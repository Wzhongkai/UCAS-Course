import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  readPublicSettings,
  readWorkerEvents,
  readWorkerStatus,
  updateAutomationSettings
} from "../automation/store.mjs";
import { UcasClient } from "../ucas.mjs";
import { normalizeCourseName, shanghaiDate } from "../schedule.mjs";
import {
  finishEnrollmentAttempt,
  reserveEnrollmentAttempt,
  withEnrollmentLock
} from "./enrollment.mjs";
import { card, helpMessage } from "./format.mjs";
import { createBackendScheduleQuery } from "./backend.mjs";
import { createCourseCards } from "./course-view.mjs";

const MAX_INPUT_LENGTH = 16_384;
const MAX_REPLY_LENGTH = 1_300;
const MAX_USERNAME_LENGTH = 40;
const MAX_PASSWORD_LENGTH = 80;
const MAX_COURSES = 100;
const MAX_COURSE_NAME_LENGTH = 120;
const MAX_TEXT = 240;
const DELETE_TTL_MS = 5 * 60_000;

const SAFE_ERROR = "操作暂时失败，请稍后重试。";
const DEFAULT_AUTOMATION = Object.freeze({
  readPublicSettings,
  readWorkerEvents,
  readWorkerStatus,
  updateAutomationSettings,
  querySchedule: createBackendScheduleQuery()
});

function normalizeUserId(userId) {
  if (typeof userId !== "string") return "";
  const value = userId.trim();
  return value.length > 0 && value.length <= 128 ? value : "";
}

function safeText(value, maxLength = MAX_TEXT) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function validUsername(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_USERNAME_LENGTH && !/\s/u.test(value);
}

function formatShanghai(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间未知";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}`;
}

function boundReply(lines, limit = MAX_REPLY_LENGTH) {
  let result = "";
  for (const line of lines) {
    const next = result ? `${result}\n${line}` : line;
    if (next.length > limit) {
      const remaining = Math.max(0, limit - result.length - (result ? 1 : 0));
      if (remaining > 0) result += `${result ? "\n" : ""}${"……（内容已截断）".slice(0, remaining)}`;
      break;
    }
    result = next;
  }
  return result;
}

function boundCards(cards, limit = MAX_REPLY_LENGTH) {
  let result = "";
  for (const item of cards) {
    const cardText = String(item ?? "").trim();
    if (!cardText) continue;
    const next = result ? `${result}\n\n${cardText}` : cardText;
    if (next.length > limit) {
      const remaining = Math.max(0, limit - result.length - (result ? 2 : 0));
      if (remaining > 0) result += `${result ? "\n\n" : ""}${"……（内容已截断）".slice(0, remaining)}`;
      break;
    }
    result = next;
  }
  return result;
}

function accountIdOf(account) {
  return typeof account?.id === "string" && account.id.length > 0 && account.id.length <= 128 ? account.id : "";
}

function accountLabel(account) {
  return safeText(account?.username, 40) || "未知学号";
}

function safeTokenEqual(received, expected) {
  if (typeof received !== "string" || typeof expected !== "string") return false;
  const left = Buffer.from(received, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function parsePasswordCommand(text, command) {
  const match = text.match(new RegExp(`^${command}\\s+(\\S+)\\s+([\\s\\S]+)$`, "u"));
  if (!match) return null;
  return { username: match[1], password: match[2] };
}

function parseWhitelistCommand(text) {
  const match = text.match(/^不打卡名单(?:\s+([\s\S]*))?$/u);
  if (!match) return null;
  return { value: match[1] ?? "" };
}

function normalizeQueryDate(value) {
  if (typeof value !== "string") return null;
  const compact = value.includes("-") ? value.replaceAll("-", "") : value;
  if (!/^\d{8}$/u.test(compact)) return null;
  const year = Number(compact.slice(0, 4));
  const month = Number(compact.slice(4, 6));
  const day = Number(compact.slice(6, 8));
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return compact;
}

function formatTiming(timing) {
  if (timing?.mode === "random" && Number.isInteger(timing.minMinutes) && Number.isInteger(timing.maxMinutes)) {
    return `随机 ${timing.minMinutes}–${timing.maxMinutes} 分钟`;
  }
  const minutes = Number.isInteger(timing?.fixedMinutes) ? timing.fixedMinutes : 10;
  return `固定 ${minutes} 分钟`;
}

function scheduleStateLabel(state) {
  const labels = {
    waiting: "等待获取课表",
    ready: "课表已获取",
    no_courses: "今日无课",
    no_matching_courses: "名单中的课程已全部跳过",
    error: "课表获取失败"
  };
  return labels[state] ?? (safeText(state, 40) || "暂无后台状态");
}

function courseOverrideCount(account) {
  const overrides = account?.courseTimingOverrides;
  return overrides && typeof overrides === "object" && !Array.isArray(overrides) ? Object.keys(overrides).length : 0;
}

export function createCommandHandler({
  store,
  automation = DEFAULT_AUTOMATION,
  ucasClientFactory = (credentials) => new UcasClient(credentials),
  enrollment = { reserve: reserveEnrollmentAttempt, finish: finishEnrollmentAttempt, withLock: withEnrollmentLock }
} = {}) {
  const pendingDeletes = new Map();

  async function call(target, method, ...args) {
    if (typeof target?.[method] !== "function") throw new Error("dependency unavailable");
    return target[method](...args);
  }

  async function isAdmin(userId) {
    return Boolean(await call(store, "isAdmin", userId));
  }

  async function readSettings() {
    const result = await call(automation, "readPublicSettings");
    if (!Array.isArray(result?.accounts)) throw new Error("invalid public settings");
    return result.accounts.filter((account) => accountIdOf(account));
  }

  async function bindingsFor(userId) {
    const result = await call(store, "listBindings", userId);
    if (!Array.isArray(result)) return [];
    return result.filter((binding) => binding?.userId === userId && accountIdOf({ id: binding?.accountId }));
  }

  async function resolveAccounts(userId, admin, username) {
    let bindings = [];
    if (!admin) {
      bindings = await bindingsFor(userId);
      if (!bindings.length) return { accounts: [], reason: "no_binding" };
    }
    const settings = await readSettings();
    if (username !== undefined) {
      const account = settings.find((entry) => entry.username === username);
      if (!account) return { accounts: [], reason: admin ? "not_found" : "forbidden" };
      if (!admin && !bindings.some((binding) => binding.accountId === accountIdOf(account))) {
        return { accounts: [], reason: "forbidden" };
      }
      return { accounts: [account], reason: null };
    }
    if (admin) return { accounts: settings, reason: null };
    const allowedIds = new Set(bindings.map((binding) => binding.accountId));
    return { accounts: settings.filter((account) => allowedIds.has(accountIdOf(account))), reason: null };
  }

  async function resolveSingleAccount(userId, admin, username) {
    if (username !== undefined) return resolveAccounts(userId, admin, username);
    if (admin) return { accounts: [], reason: "username_required" };
    const bindings = await bindingsFor(userId);
    if (bindings.length === 0) return { accounts: [], reason: "no_binding" };
    const settings = await readSettings();
    const allowedIds = new Set(bindings.map((binding) => binding.accountId));
    const accounts = settings.filter((account) => allowedIds.has(accountIdOf(account)));
    if (accounts.length === 1) return { accounts, reason: null };
    return {
      accounts: [],
      reason: accounts.length > 1 ? "multiple_bindings" : "no_binding"
    };
  }

  async function splitOptionalUsername(value) {
    const text = String(value ?? "").trim();
    const match = text.match(/^(\S+)(?:\s+([\s\S]*))?$/u);
    if (!match) return { username: undefined, value: "" };
    const candidate = match[1];
    const knownAccount = (await readSettings()).some((account) => account.username === candidate);
    if (!knownAccount && !/^\d{6,12}$/u.test(candidate)) return { username: undefined, value: text };
    return { username: candidate, value: match[2] ?? "" };
  }

  function scopeError(reason) {
    if (reason === "no_binding") return "你还没有绑定账号，请使用“绑定学号 学号 密码”自助绑定。";
    if (reason === "multiple_bindings") return "你有多个有效绑定，请明确提供学号后重试。";
    if (reason === "username_required") return "管理员请明确提供学号后重试。";
    if (reason === "not_found") return "没有找到该学号对应的账号。";
    return "没有权限管理该学号的账号；普通用户只能操作自己已绑定的学号。";
  }

  async function bindingForTarget(userId, account, admin) {
    const binding = await call(store, "getBinding", accountIdOf(account));
    if (!admin && binding?.userId !== userId) return null;
    return binding ?? null;
  }

  async function handleInternal({ userId, content }) {
    const safeUserId = normalizeUserId(userId);
    if (!safeUserId) return "无法识别你的 QQ ID。";
    if (typeof content !== "string" || content.length > MAX_INPUT_LENGTH) return "指令过长或格式无效。";

    const text = content.replace(/^\s+/u, "");
    const trimmed = text.trim();
    if (!trimmed) return "请发送“帮助”查看可用指令。";

    const role = await isAdmin(safeUserId);
    const identity = role && Boolean(await call(store, "getAdminMode", safeUserId));
    if (trimmed === "进入管理员模式") {
      if (!role) return "仅配置的管理员可以进入管理员模式。";
      const entered = await call(store, "setAdminMode", safeUserId, true);
      if (!entered) return "管理员模式开启失败，请稍后重试。";
      return card("管理员模式已开启", [{ label: "权限", value: "可管理所有账号" }], {
        footer: "涉及账号的指令均须明确提供学号；发送“退出管理员模式”返回本人账号权限。"
      });
    }
    if (trimmed === "退出管理员模式") {
      const wasActive = identity;
      await call(store, "setAdminMode", safeUserId, false);
      const prefix = `${safeUserId}:`;
      for (const key of pendingDeletes.keys()) {
        if (key.startsWith(prefix)) pendingDeletes.delete(key);
      }
      return wasActive ? card("管理员模式已退出", [], { footer: "后续指令按本人账号权限处理。" }) : "当前未开启管理员模式。";
    }
    if (trimmed === "帮助" || trimmed === "菜单") return helpMessage(false);
    if (trimmed === "管理员帮助" || trimmed === "管理菜单") return role ? helpMessage(true, "admin") : "";
    if (trimmed === "我的ID" || trimmed === "我的 ID") {
      return card("我的 QQ ID", [{ label: "QQ ID", value: safeUserId }], { footer: "可使用“绑定学号 学号 密码”自助绑定。" });
    }

    let match;
    const selfEnrollment = parsePasswordCommand(text, "绑定学号");
    if (selfEnrollment) {
      const { username, password } = selfEnrollment;
      if (!validUsername(username) || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
        return "学号或密码格式无效。密码最多 80 个字符。";
      }
      const reservation = await enrollment.reserve(safeUserId);
      if (!reservation) return "绑定验证次数已达上限，请 15 分钟后重试。";

      try {
        const client = ucasClientFactory({ username, password });
        await client.login();
      } catch {
        await enrollment.finish(reservation, true);
        return "学号或密码验证失败，请检查后重试。";
      }
      await enrollment.finish(reservation, false);

      try {
        return await enrollment.withLock(async () => {
          const settings = await readSettings();
          let account = settings.find((entry) => entry.username === username);
          let created = false;
          if (account) {
            const currentBinding = await call(store, "getBinding", accountIdOf(account));
            if (currentBinding?.userId && currentBinding.userId !== safeUserId) {
              return "该学号已绑定其他 QQ，无法重复绑定。";
            }
          }

          const ownBindings = await bindingsFor(safeUserId);
          if (!identity && ownBindings.some((binding) => binding.accountId !== accountIdOf(account))) {
            return "普通用户只能绑定一个学号；请先解绑现有学号，或联系管理员处理。";
          }

          if (!account) {
            await call(automation, "updateAutomationSettings", { action: "add", username, password, enabled: false });
            created = true;
            const afterAdd = await readSettings();
            account = afterAdd.find((entry) => entry.username === username);
            if (!account) throw new Error("created account unavailable");
          }

          const accountId = accountIdOf(account);
          if (!accountId) throw new Error("invalid account id");
          try {
            const result = await call(store, "bindVerified", safeUserId, accountId, { allowMultiple: identity });
            if (result?.accountId !== accountId) throw new Error("binding result mismatch");
          } catch (error) {
            if (created) {
              await call(automation, "updateAutomationSettings", { action: "remove", accountId }).catch(() => {});
            }
            if (/只能绑定一个账号|multiple|allowMultiple/iu.test(String(error?.message ?? ""))) {
              return "普通用户只能绑定一个学号；请先解绑现有学号，或联系管理员处理。";
            }
            if (/其他用户|已绑定|owned|already bound/iu.test(String(error?.message ?? ""))) {
              return "该学号已绑定其他 QQ，无法重复绑定。";
            }
            throw error;
          }

          if (!created) {
            await call(automation, "updateAutomationSettings", { action: "password", accountId, password });
          }

          const paused = account.enabled ? "已开启" : "已暂停";
          const fields = [
            { label: "学号", value: username },
            { label: "自动打卡", value: paused }
          ];
          if (!created) fields.push({ label: "登录凭据", value: "已更新" });
          return card("绑定成功", fields, {
            footer: created ? "新账号默认暂停；需要时可自行开启打卡。" : "已保存验证通过的凭据，并保留账号原有开关状态。"
          });
        });
      } catch {
        return SAFE_ERROR;
      }
    }

    if (trimmed === "账号列表") {
      const scope = await resolveAccounts(safeUserId, identity);
      if (scope.reason === "no_binding") return scopeError(scope.reason);
      if (scope.accounts.length === 0) return identity ? "当前没有已添加的账号。" : "你目前没有已绑定的账号。";
      const fields = [];
      for (const account of scope.accounts) {
        let suffix = account.enabled ? "打卡已开启" : "打卡已关闭";
        if (identity) {
          const binding = await call(store, "getBinding", accountIdOf(account));
          if (binding?.userId) suffix += `；绑定 QQ ${safeText(binding.userId, 80)}`;
        }
        fields.push({ label: accountLabel(account), value: suffix });
      }
      const cards = [];
      for (let index = 0; index < fields.length; index += 6) {
        cards.push(card(identity ? "账号列表" : "你绑定的账号", fields.slice(index, index + 6)));
      }
      return boundCards(cards);
    }

    if ((match = trimmed.match(/^绑定\s+(\S+)$/u))) {
      if (!identity) return role
        ? "请先发送“进入管理员模式”后再使用绑定码流程。"
        : "绑定码流程仅管理员可以使用；普通用户请使用“绑定学号 学号 密码”自助绑定。";
      const code = match[1];
      if (code.length > 128) return "绑定码格式无效或已过期。";
      let bindResult;
      let binding;
      let accountId;
      try {
        bindResult = await call(store, "bind", safeUserId, code);
        accountId = typeof bindResult === "string" ? bindResult : bindResult?.accountId;
        if (typeof accountId !== "string" || accountId.length === 0 || accountId.length > 128) return "绑定码格式无效或已过期。";
        binding = await call(store, "getBinding", accountId);
      } catch {
        return "绑定码格式无效或已过期。";
      }
      if (binding?.userId !== safeUserId) return "绑定码格式无效或已过期。";
      const boundAccount = (await readSettings()).find((account) => accountIdOf(account) === accountId);
      return card("账号绑定成功", [{ label: "学号", value: accountLabel(boundAccount) }], { footer: "之后请使用学号管理这个账号。" });
    }

    if ((match = trimmed.match(/^绑定码\s+(\S+)$/u))) {
      if (!identity) return role ? "请先发送“进入管理员模式”后再创建绑定码。" : "仅管理员可以创建绑定码。";
      const username = match[1];
      if (!validUsername(username)) return "学号格式无效。";
      const scope = await resolveAccounts(safeUserId, true, username);
      if (scope.reason) return scopeError(scope.reason);
      const result = await call(store, "createBindingCode", accountIdOf(scope.accounts[0]));
      if (typeof result?.code !== "string" || !result.code) return SAFE_ERROR;
      return `${card("绑定码", [
        { label: "学号", value: username },
        { label: "有效期至（上海时间）", value: formatShanghai(result.expiresAt) }
      ], { footer: "请复制绑定码发送给对应用户。" })}\n\n${result.code}`;
    }

    if (trimmed === "日志" || (match = trimmed.match(/^日志\s+(\S+)$/u))) {
      if (!identity) return role
        ? "请先发送“进入管理员模式”后再查看运行日志。"
        : "普通用户暂不能查看运行日志：现有日志没有可靠的账号标识，无法安全隔离。";
      if (match?.[1]) {
        const scope = await resolveAccounts(safeUserId, true, match[1]);
        if (scope.reason) return scopeError(scope.reason);
        const events = await call(automation, "readWorkerEvents");
        if (!Array.isArray(events)) return "当前没有可读取的日志。";
        const scoped = events.filter((event) => event?.accountId === accountIdOf(scope.accounts[0]));
        if (scoped.length === 0 && events.some((event) => typeof event?.accountId !== "string")) {
          return "这批日志没有账号标识，无法按学号筛选。管理员可使用“日志”查看全局日志。";
        }
        return scoped.length
          ? boundReply([card(`学号 ${match[1]} 的最近日志`, scoped.slice(-4).map((event) => ({ label: formatShanghai(event?.at), value: safeText(event?.message, 180) || "（无详细内容）" })))])
          : "该账号暂无日志。";
      }
      const events = await call(automation, "readWorkerEvents");
      if (!Array.isArray(events) || events.length === 0) return "当前没有可读取的日志。";
      return boundReply([card("最近运行日志", events.slice(-4).map((event) => ({ label: formatShanghai(event?.at), value: safeText(event?.message, 180) || "（无详细内容）" })))]);
    }

    if ((match = trimmed.match(/^解绑(?:\s+(\S+))?$/u))) {
      const requestedUsername = match[1];
      if (requestedUsername !== undefined && !validUsername(requestedUsername)) return "学号格式无效。";
      const scope = await resolveSingleAccount(safeUserId, identity, requestedUsername);
      if (scope.reason) return scopeError(scope.reason);
      const username = scope.accounts[0].username;
      await call(store, "unbind", accountIdOf(scope.accounts[0]));
      pendingDeletes.delete(`${safeUserId}:${username}`);
      return card("已解除绑定", [{ label: "学号", value: username }], { footer: "自动化账号仍保留。" });
    }

    if ((match = trimmed.match(/^状态(?:\s+(\S+))?$/u))) {
      const scope = match[1] === undefined
        ? await resolveSingleAccount(safeUserId, identity)
        : await resolveAccounts(safeUserId, identity, match[1]);
      if (scope.reason) return scopeError(scope.reason);
      if (scope.accounts.length === 0) return "没有可查看的账号。";
      const status = await call(automation, "readWorkerStatus");
      const workerAccounts = Array.isArray(status?.accounts) ? status.accounts : [];
      const cards = [];
      if (identity && status?.lastError) cards.push(card("后台状态", [{ label: "最近状态", value: "后台报告有错误，请查看管理员日志。" }]));
      for (const account of scope.accounts) {
        const state = workerAccounts.find((entry) => entry?.id === accountIdOf(account));
        const fields = [
          { label: "打卡", value: account.enabled ? "已开启" : "已暂停" },
          { label: "默认签到时间", value: formatTiming(account.timing) },
          { label: "单课时间覆盖", value: `${courseOverrideCount(account)} 门` }
        ];
        if (!state) fields.push({ label: "后台状态", value: "尚未报告" });
        else {
          if (state.date) fields.push({ label: "日期", value: safeText(state.date, 20) });
          if (state.scheduleState) fields.push({ label: "课表", value: scheduleStateLabel(state.scheduleState) });
          if (state.lastError) fields.push({ label: "最近运行", value: "有错误" });
          if (status?.updatedAt) fields.push({ label: "状态更新时间", value: formatShanghai(status.updatedAt) });
        }
        cards.push(card(accountLabel(account), fields));
      }
      return boundCards(cards);
    }

    if ((match = trimmed.match(/^(?:查询课程|查询课表|课表)(?:\s+(\S+))?(?:\s+(\S+))?$/u))) {
      let username;
      let date = shanghaiDate();
      if (match[2]) {
        username = match[1];
        if (!validUsername(username)) return "学号格式无效。";
        date = normalizeQueryDate(match[2]);
        if (!date) return "日期格式无效，请使用 YYYYMMDD 或 YYYY-MM-DD。";
      } else if (match[1]) {
        const currentScope = await resolveAccounts(safeUserId, identity);
        if (currentScope.reason) return scopeError(currentScope.reason);
        if (currentScope.accounts.some((account) => account.username === match[1])) {
          username = match[1];
        } else {
          date = normalizeQueryDate(match[1]);
          if (!date) {
            if (validUsername(match[1])) username = match[1];
            else return "日期格式无效，请使用 YYYYMMDD 或 YYYY-MM-DD。";
          }
        }
      }
      const scope = username === undefined
        ? await resolveSingleAccount(safeUserId, identity)
        : await resolveAccounts(safeUserId, identity, username);
      if (scope.reason) return scopeError(scope.reason);
      if (scope.accounts.length === 0) return "没有可查询的账号。";
      let workerStatus;
      try { workerStatus = await call(automation, "readWorkerStatus"); }
      catch { /* A worker outage must not prevent a live timetable query. */ }
      const cards = [];
      for (const account of scope.accounts) {
        let result;
        try {
          result = await call(automation, "querySchedule", accountIdOf(account), date);
        } catch {
          cards.push(card(accountLabel(account), [{ label: "查询结果", value: "课表查询失败，请稍后重试。" }]));
          continue;
        }
        const courses = Array.isArray(result) ? result : result?.courses;
        cards.push(...createCourseCards(courses, { account, date, workerStatus }));
      }
      return boundCards(cards, MAX_REPLY_LENGTH * 4);
    }

    if ((match = trimmed.match(/^(开启打卡|关闭打卡)(?:\s+(\S+))?$/u))) {
      const enabled = match[1] === "开启打卡";
      const requestedUsername = match[2];
      if (requestedUsername !== undefined && !validUsername(requestedUsername)) return "学号格式无效。";
      const scope = await resolveSingleAccount(safeUserId, identity, requestedUsername);
      if (scope.reason) return scopeError(scope.reason);
      const account = scope.accounts[0];
      const username = account.username;
      if (Boolean(account.enabled) === enabled) {
        return card("打卡状态未改变", [{ label: "学号", value: username }, { label: "自动打卡", value: enabled ? "已开启" : "已暂停" }]);
      }
      await call(automation, "updateAutomationSettings", { action: "toggle", accountId: accountIdOf(account), enabled });
      return card("打卡设置已更新", [{ label: "学号", value: username }, { label: "自动打卡", value: enabled ? "已开启" : "已暂停" }]);
    }

    if ((match = trimmed.match(/^刷新课表(?:\s+(\S+))?$/u))) {
      const requestedUsername = match[1];
      if (requestedUsername !== undefined && !validUsername(requestedUsername)) return "学号格式无效。";
      const scope = await resolveSingleAccount(safeUserId, identity, requestedUsername);
      if (scope.reason) return scopeError(scope.reason);
      const account = scope.accounts[0];
      const username = account.username;
      if (!account.enabled) return "该账号打卡已关闭，请先明确开启后再刷新课表。";
      await call(automation, "updateAutomationSettings", { action: "refresh", accountId: accountIdOf(account) });
      return card("课表刷新已请求", [{ label: "学号", value: username }]);
    }

    const fixedTimingMatch = trimmed.match(/^签到时间(?:\s+([\s\S]+?))?\s+固定\s+(\d+)$/u);
    const randomTimingMatch = trimmed.match(/^签到时间(?:\s+([\s\S]+?))?\s+随机\s+(\d+)\s+(\d+)$/u);
    if (fixedTimingMatch || randomTimingMatch) {
      const timingMatch = fixedTimingMatch ?? randomTimingMatch;
      const { username: requestedUsername, value: timingTarget } = await splitOptionalUsername(timingMatch[1] ?? "");
      const courseName = timingTarget.normalize("NFKC").trim().replace(/\s+/gu, " ");
      if (requestedUsername !== undefined && !validUsername(requestedUsername)) return "学号格式无效。";
      if (courseName && courseName !== "所有" && courseName.length > MAX_COURSE_NAME_LENGTH) {
        return `课程名不能为空，且不能超过 ${MAX_COURSE_NAME_LENGTH} 个字符。`;
      }
      let timing;
      if (fixedTimingMatch) {
        const fixedMinutes = Number(timingMatch[2]);
        if (!Number.isInteger(fixedMinutes) || fixedMinutes < 1 || fixedMinutes > 120) return "签到时间必须是 1 到 120 分钟的整数。";
        timing = { mode: "fixed", fixedMinutes };
      } else {
        const minMinutes = Number(timingMatch[2]);
        const maxMinutes = Number(timingMatch[3]);
        if (!Number.isInteger(minMinutes) || !Number.isInteger(maxMinutes) || minMinutes < 1 || maxMinutes > 120 || minMinutes > maxMinutes) {
          return "随机签到时间需满足 1 ≤ 最小分钟 ≤ 最大分钟 ≤ 120。";
        }
        timing = { mode: "random", minMinutes, maxMinutes };
      }
      const scope = await resolveSingleAccount(safeUserId, identity, requestedUsername);
      if (scope.reason) return scopeError(scope.reason);
      const account = scope.accounts[0];
      const username = account.username;
      if (courseName && courseName !== "所有") {
        await call(automation, "updateAutomationSettings", {
          action: "course-timing", accountId: accountIdOf(account), courseName, timing
        });
        return card("单课签到时间已更新", [
          { label: "学号", value: username },
          { label: "课程", value: courseName },
          { label: "签到时间", value: formatTiming(timing) }
        ], { footer: "单课时间覆盖优先于默认时间。" });
      }
      const resetCourseTimingOverrides = courseName === "所有";
      await call(automation, "updateAutomationSettings", {
        action: "timing", accountId: accountIdOf(account), timing,
        ...(resetCourseTimingOverrides ? { resetCourseTimingOverrides: true } : {})
      });
      return card("默认签到时间已更新", [{ label: "学号", value: username }, { label: "签到时间", value: formatTiming(timing) }], {
        footer: resetCourseTimingOverrides
          ? "所有课程已统一，旧单课设置已清除。"
          : "单课时间覆盖优先于默认时间。"
      });
    }

    const fixedCourseTiming = trimmed.match(/^单课时间\s+([\s\S]+?)\s+固定\s+(\d+)$/u);
    const randomCourseTiming = trimmed.match(/^单课时间\s+([\s\S]+?)\s+随机\s+(\d+)\s+(\d+)$/u);
    if (fixedCourseTiming || randomCourseTiming) {
      const timingMatch = fixedCourseTiming ?? randomCourseTiming;
      const { username: requestedUsername, value: requestedCourseName } = await splitOptionalUsername(timingMatch[1]);
      const courseName = requestedCourseName.normalize("NFKC").trim().replace(/\s+/gu, " ");
      if (requestedUsername !== undefined && !validUsername(requestedUsername)) return "学号格式无效。";
      if (!courseName || courseName.length > MAX_COURSE_NAME_LENGTH) return `课程名不能为空，且不能超过 ${MAX_COURSE_NAME_LENGTH} 个字符。`;
      let timing;
      if (fixedCourseTiming) {
        const fixedMinutes = Number(timingMatch[2]);
        if (!Number.isInteger(fixedMinutes) || fixedMinutes < 1 || fixedMinutes > 120) return "签到时间必须是 1 到 120 分钟的整数。";
        timing = { mode: "fixed", fixedMinutes };
      } else {
        const minMinutes = Number(timingMatch[2]);
        const maxMinutes = Number(timingMatch[3]);
        if (!Number.isInteger(minMinutes) || !Number.isInteger(maxMinutes) || minMinutes < 1 || maxMinutes > 120 || minMinutes > maxMinutes) {
          return "随机签到时间需满足 1 ≤ 最小分钟 ≤ 最大分钟 ≤ 120。";
        }
        timing = { mode: "random", minMinutes, maxMinutes };
      }
      const scope = await resolveSingleAccount(safeUserId, identity, requestedUsername);
      if (scope.reason) return scopeError(scope.reason);
      const username = scope.accounts[0].username;
      await call(automation, "updateAutomationSettings", {
        action: "course-timing", accountId: accountIdOf(scope.accounts[0]), courseName, timing
      });
      return card("单课签到时间已更新", [
        { label: "学号", value: username },
        { label: "课程", value: courseName },
        { label: "签到时间", value: formatTiming(timing) }
      ], { footer: "单课时间覆盖优先于默认时间。" });
    }

    if ((match = trimmed.match(/^清除单课时间\s+([\s\S]+)$/u))) {
      const { username: requestedUsername, value: requestedCourseName } = await splitOptionalUsername(match[1]);
      const courseName = requestedCourseName.normalize("NFKC").trim().replace(/\s+/gu, " ");
      if (requestedUsername !== undefined && !validUsername(requestedUsername)) return "学号格式无效。";
      if (!courseName || courseName.length > MAX_COURSE_NAME_LENGTH) return `课程名不能为空，且不能超过 ${MAX_COURSE_NAME_LENGTH} 个字符。`;
      const scope = await resolveSingleAccount(safeUserId, identity, requestedUsername);
      if (scope.reason) return scopeError(scope.reason);
      const username = scope.accounts[0].username;
      await call(automation, "updateAutomationSettings", {
        action: "course-timing", accountId: accountIdOf(scope.accounts[0]), courseName, timing: null
      });
      return card("单课签到时间已清除", [
        { label: "学号", value: username },
        { label: "课程", value: courseName }
      ], { footer: "后续使用默认签到时间。" });
    }

    if ((match = trimmed.match(/^(停止打卡|启动打卡)\s+([\s\S]+)$/u))) {
      const shouldStop = match[1] === "停止打卡";
      const { username: requestedUsername, value: requestedCourseName } = await splitOptionalUsername(match[2]);
      const courseName = requestedCourseName.normalize("NFKC").trim().replace(/\s+/gu, " ");
      if (requestedUsername !== undefined && !validUsername(requestedUsername)) return "学号格式无效。";
      if (!courseName || courseName.length > MAX_COURSE_NAME_LENGTH) {
        return `课程名不能为空，且不能超过 ${MAX_COURSE_NAME_LENGTH} 个字符。`;
      }
      const scope = await resolveSingleAccount(safeUserId, identity, requestedUsername);
      if (scope.reason) return scopeError(scope.reason);
      const account = scope.accounts[0];
      const current = Array.isArray(account.courseWhitelist)
        ? account.courseWhitelist.filter((name) => typeof name === "string")
        : [];
      const normalized = normalizeCourseName(courseName);
      const alreadyStopped = current.some((name) => normalizeCourseName(name) === normalized);
      if (shouldStop && !alreadyStopped) {
        if (current.length >= MAX_COURSES) return `停止打卡名单最多 ${MAX_COURSES} 门课。`;
        await call(automation, "updateAutomationSettings", {
          action: "whitelist", accountId: accountIdOf(account), courseWhitelist: [...current, courseName]
        });
      } else if (!shouldStop && alreadyStopped) {
        await call(automation, "updateAutomationSettings", {
          action: "whitelist", accountId: accountIdOf(account),
          courseWhitelist: current.filter((name) => normalizeCourseName(name) !== normalized)
        });
      }
      const stopped = shouldStop;
      return card(shouldStop ? "已停止该课程打卡" : "已启动该课程打卡", [
        { label: "课程", value: courseName },
        { label: "打卡状态", value: stopped ? "已停止" : "已启动" }
      ], {
        footer: !shouldStop && !account.enabled
          ? "账号总开关仍关闭，请先发送“开启打卡”后该课程才会打卡；本指令只移出停止名单。"
          : alreadyStopped === shouldStop ? "设置未改变。" : undefined
      });
    }

    if ((match = trimmed.match(/^停止打卡课程名单(?:\s+(\S+))?$/u))) {
      const requestedUsername = match[1];
      if (requestedUsername !== undefined && !validUsername(requestedUsername)) return "学号格式无效。";
      const scope = await resolveSingleAccount(safeUserId, identity, requestedUsername);
      if (scope.reason) return scopeError(scope.reason);
      const account = scope.accounts[0];
      const names = Array.isArray(account.courseWhitelist)
        ? account.courseWhitelist.filter((name) => typeof name === "string").map((name) => safeText(name, MAX_COURSE_NAME_LENGTH))
        : [];
      const cards = [card("停止打卡课程名单", [
        { label: "学号", value: accountLabel(account) },
        { label: "课程数", value: `${names.length} 门` }
      ])];
      if (names.length === 0) cards.push(card("名单内容", [{ label: "课程", value: "（空）" }]));
      else {
        for (let index = 0; index < names.length; index += 8) {
          cards.push(card(index === 0 ? "名单内容" : "名单续页", names.slice(index, index + 8).map((name) => ({ label: "课程", value: name }))));
        }
      }
      return boundCards(cards);
    }

    if ((match = parseWhitelistCommand(trimmed))) {
      const { username: requestedUsername, value } = await splitOptionalUsername(match.value);
      const courseWhitelist = value.trim() ? value.split("|").map((name) => name.trim()).filter(Boolean) : [];
      if (courseWhitelist.length > MAX_COURSES || courseWhitelist.some((name) => name.length > MAX_COURSE_NAME_LENGTH)) {
        return `不打卡名单最多 ${MAX_COURSES} 门课，每门课不能超过 ${MAX_COURSE_NAME_LENGTH} 个字符。`;
      }
      if (requestedUsername !== undefined && !validUsername(requestedUsername)) return "学号格式无效。";
      const scope = await resolveSingleAccount(safeUserId, identity, requestedUsername);
      if (scope.reason) return scopeError(scope.reason);
      const username = scope.accounts[0].username;
      await call(automation, "updateAutomationSettings", {
        action: "whitelist", accountId: accountIdOf(scope.accounts[0]), courseWhitelist
      });
      const sample = courseWhitelist.slice(0, 4).join("、");
      const remaining = courseWhitelist.length - Math.min(courseWhitelist.length, 4);
      return card("不打卡名单已更新", [
        { label: "学号", value: username },
        { label: "课程数", value: `${courseWhitelist.length} 门` },
        { label: "课程示例", value: sample || "（空）" }
      ], { footer: remaining > 0 ? `另有 ${remaining} 门课程已保存。` : undefined });
    }

    const passwordUpdate = parsePasswordCommand(text, "更新密码");
    if (passwordUpdate) {
      if (!identity) return role ? "请先发送“进入管理员模式”后再修改账号密码。" : "仅管理员可以修改自动化账号密码。";
      const { username, password } = passwordUpdate;
      if (!validUsername(username) || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) return "学号或密码格式无效。密码最多 80 个字符。";
      const scope = await resolveAccounts(safeUserId, identity, username);
      if (scope.reason) return scopeError(scope.reason);
      await call(automation, "updateAutomationSettings", { action: "password", accountId: accountIdOf(scope.accounts[0]), password });
      return card("登录凭据已更新", [{ label: "学号", value: username }]);
    }

    const addAccountCommand = parsePasswordCommand(text, "添加账号");
    const addStudentCommand = parsePasswordCommand(text, "添加学号");
    const addAccount = addAccountCommand ?? addStudentCommand;
    if (addAccount) {
      if (!identity) return role ? "请先发送“进入管理员模式”后再添加学号。" : "仅管理员可以添加全局账号。";
      const { username, password } = addAccount;
      if (!validUsername(username) || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) return "学号或密码格式无效。密码最多 80 个字符。";
      await call(automation, "updateAutomationSettings", { action: "add", username, password, enabled: false });
      const accounts = await readSettings();
      const account = accounts.find((entry) => entry.username === username);
      if (addStudentCommand) {
        if (!account) return "学号已提交为暂停状态，但暂时无法读取，请稍后重试。";
        return card("学号已添加", [
          { label: "学号", value: username },
          { label: "打卡", value: "已暂停" }
        ], { footer: "该学号的使用者发送“绑定学号 学号 密码”验证后绑定。" });
      }
      if (!account) return "账号已提交为关闭状态，但绑定码暂时无法生成，请管理员稍后重试。";
      const result = await call(store, "createBindingCode", accountIdOf(account));
      if (typeof result?.code !== "string" || !result.code) return "账号已添加并保持关闭，但绑定码生成失败，请管理员稍后重试。";
      return `${card("账号已添加", [
        { label: "学号", value: username },
        { label: "自动打卡", value: "已暂停" },
        { label: "有效期至（上海时间）", value: formatShanghai(result.expiresAt) }
      ], { footer: "绑定码请复制下一行发送给对应用户。" })}\n\n${result.code}`;
    }

    if ((match = trimmed.match(/^(删除账号|删除学号)\s+(\S+)(?:\s+确认\s+(\S+))?$/u))) {
      if (!identity) return role
        ? "请先发送“进入管理员模式”后再删除学号。"
        : "仅管理员可以删除自动化账号；普通用户可使用“解绑”解除自己的绑定。";
      const commandName = match[1];
      const username = match[2];
      if (!validUsername(username)) return "学号格式无效。";
      const key = `${safeUserId}:${username}`;
      if (!match[3]) {
        const scope = await resolveAccounts(safeUserId, identity, username);
        if (scope.reason) return scopeError(scope.reason);
        const token = randomBytes(6).toString("hex").toUpperCase();
        pendingDeletes.set(key, { accountId: accountIdOf(scope.accounts[0]), token, expiresAt: Date.now() + DELETE_TTL_MS });
        return `${card("删除账号二次确认", [
          { label: "学号", value: username },
          { label: "有效期", value: "5 分钟" }
        ], { footer: "请复制并发送以下指令：" })}\n\n${commandName} ${username} 确认 ${token}`;
      }
      const pending = pendingDeletes.get(key);
      if (!pending || pending.expiresAt < Date.now() || !safeTokenEqual(match[3], pending.token)) {
        if (pending?.expiresAt < Date.now()) pendingDeletes.delete(key);
        return `删除确认码无效或已过期；请重新发送“${commandName} 学号”获取确认码。`;
      }
      const currentAccounts = await readSettings();
      const accountStillExists = currentAccounts.some((account) => accountIdOf(account) === pending.accountId && account.username === username);
      if (accountStillExists) {
        await call(automation, "updateAutomationSettings", { action: "remove", accountId: pending.accountId });
      }
      await call(store, "unbind", pending.accountId);
      pendingDeletes.delete(key);
      return card("账号已删除", [{ label: "学号", value: username }], { footer: "关联绑定已清理。" });
    }

    if ((match = trimmed.match(/^通知(?:\s+(\S+))?\s+(全部|仅失败|关闭)$/u))) {
      const requestedUsername = match[1];
      if (requestedUsername !== undefined && !validUsername(requestedUsername)) return "学号格式无效。";
      const scope = await resolveSingleAccount(safeUserId, identity, requestedUsername);
      if (scope.reason) return scopeError(scope.reason);
      const username = scope.accounts[0].username;
      const mode = match[2] === "全部" ? "all" : match[2] === "仅失败" ? "failure" : "off";
      await call(store, "setPreference", accountIdOf(scope.accounts[0]), mode);
      return card("通知设置已更新", [{ label: "学号", value: username }, { label: "接收方式", value: match[2] }]);
    }

    if ((match = trimmed.match(/^测试通知(?:\s+(\S+))?$/u))) {
      const requestedUsername = match[1];
      if (requestedUsername !== undefined && !validUsername(requestedUsername)) return "学号格式无效。";
      const scope = await resolveSingleAccount(safeUserId, identity, requestedUsername);
      if (scope.reason) return scopeError(scope.reason);
      const username = scope.accounts[0].username;
      const accountId = accountIdOf(scope.accounts[0]);
      const binding = await bindingForTarget(safeUserId, scope.accounts[0], identity);
      if (binding?.mode === "off") return card("测试通知未发送", [{ label: "学号", value: username }, { label: "原因", value: "通知已关闭" }]);
      if (!binding || !["all", "failure"].includes(binding.mode)) {
        return identity
          ? `该账号通知设置不可用，请先设置“通知 ${username} 全部”或“通知 ${username} 仅失败”。`
          : "该账号通知设置不可用，请先设置“通知 全部”或“通知 仅失败”。";
      }
      if (typeof store?.enqueueNotification === "function") {
        await call(store, "enqueueNotification", {
          id: randomUUID(), accountId, kind: "failure", content: "QQ 通知测试：这是一条测试消息。"
        });
        return card("测试通知已排队", [{ label: "学号", value: username }]);
      }
      return card("测试通知请求已确认", [{ label: "学号", value: username }, { label: "状态", value: "后台通知队列当前不可用" }]);
    }

    return "未识别这条指令，请发送“帮助”查看用法。";
  }

  return async function handle(input = {}) {
    try {
      return await handleInternal(input);
    } catch {
      return SAFE_ERROR;
    }
  };
}
