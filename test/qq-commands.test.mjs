import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Resolve automation/store defaults inside a fresh temporary directory before imports.
const moduleTempDirectory = await mkdtemp(join(tmpdir(), "qq-command-module-"));
process.env.AUTO_SIGN_DATA_DIR = moduleTempDirectory;
const [{ createCommandHandler }, { createQqStore }, { createEnrollmentCoordinator }] = await Promise.all([
  import("../src/qq/commands.mjs"),
  import("../src/qq/store.mjs"),
  import("../src/qq/enrollment.mjs")
]);
const { shanghaiDate } = await import("../src/schedule.mjs");
after(async () => {
  delete process.env.AUTO_SIGN_DATA_DIR;
  await rm(moduleTempDirectory, { recursive: true, force: true });
});

let fixtureSequence = 0;

function fixture() {
  fixtureSequence += 1;
  const accounts = [
    { id: "account-a", username: "20260001", enabled: true, timing: { mode: "fixed", fixedMinutes: 10 }, courseTimingOverrides: { "课程甲": { mode: "fixed", fixedMinutes: 5 } }, courseWhitelist: [] },
    { id: "account-b", username: "20260002", enabled: true, timing: { mode: "fixed", fixedMinutes: 10 }, courseWhitelist: [] }
  ];
  const bindings = new Map([
    ["account-a", { userId: "qq-user-a", mode: "all" }],
    ["account-b", { userId: "qq-user-b", mode: "failure" }]
  ]);
  const admins = new Set(["qq-admin"]);
  const adminModes = new Map([["qq-admin", true]]);
  const codes = new Map();
  const actions = [];
  const queued = [];
  const verificationCalls = [];
  const queryCalls = [];
  const signCalls = [];
  const events = [
    { at: "2026-10-15T03:00:00.000Z", message: "account a event", accountId: "account-a" },
    { at: "2026-10-15T03:01:00.000Z", message: "account b private event", accountId: "account-b" },
    { at: "2026-10-15T03:02:00.000Z", message: "legacy global event" }
  ];
  const status = {
    updatedAt: "2026-10-15T03:05:00.000Z",
    lastError: "global admin-only detail",
    accounts: [
      { id: "account-a", date: "20261015", scheduleState: "ready", plan: [{ courseName: "课程甲", start: Date.parse("2026-10-15T09:00:00+08:00"), end: Date.parse("2026-10-15T10:00:00+08:00"), state: "待开始", attempts: 0 }] },
      { id: "account-b", date: "20261015", scheduleState: "error", lastError: "other account internal detail", plan: [{ courseName: "秘密课程乙", message: "other account secret" }] }
    ]
  };
  const counts = { publicSettings: 0, status: 0, events: 0 };
  const recipients = (accountId) => {
    const value = bindings.get(accountId);
    return Array.isArray(value) ? value : value ? [value] : [];
  };
  const store = {
    async isAdmin(userId) { return admins.has(userId); },
    async getAdminMode(userId) { return admins.has(userId) && adminModes.get(userId) === true; },
    async setAdminMode(userId, enabled) {
      if (enabled) {
        if (!admins.has(userId)) return false;
        adminModes.set(userId, true);
        return true;
      }
      adminModes.delete(userId);
      return false;
    },
    async claimAdmin(userId, token) { if (token === "one-use-token") admins.add(userId); },
    async createBindingCode(accountId) {
      const code = `CODE-${codes.size + 1}`;
      codes.set(code, accountId);
      return { code, expiresAt: "2026-10-15T04:00:00.000Z" };
    },
    async bind(userId, code) {
      const accountId = codes.get(code);
      if (!accountId) throw new Error("bad code");
      await store.bindVerified(userId, accountId);
      codes.delete(code);
      return { accountId };
    },
    async bindVerified(userId, accountId) {
      if (recipients(accountId).some((binding) => binding.userId === userId)) return { accountId };
      if ([...bindings.keys()].some((boundId) => boundId !== accountId && recipients(boundId).some((binding) => binding.userId === userId))) {
        throw new Error("该 QQ 已绑定其他学号");
      }
      bindings.set(accountId, [...recipients(accountId), { userId, mode: "all" }]);
      return { accountId };
    },
    async getBindings(accountId) { return recipients(accountId); },
    async getBinding(accountId, userId) {
      const entries = recipients(accountId);
      return userId === undefined ? entries.length === 1 ? entries[0] : null : entries.find((binding) => binding.userId === userId) ?? null;
    },
    async listBindings(userId) {
      return [...bindings.keys()].flatMap((accountId) => recipients(accountId).filter((binding) => binding.userId === userId)
        .map((binding) => ({ accountId, ...binding })));
    },
    async unbind(accountId, userId) {
      const remaining = userId === undefined ? [] : recipients(accountId).filter((binding) => binding.userId !== userId);
      if (remaining.length) bindings.set(accountId, remaining);
      else bindings.delete(accountId);
    },
    async setPreference(accountId, mode, userId) {
      for (const binding of recipients(accountId)) if (userId === undefined || binding.userId === userId) binding.mode = mode;
    },
    async enqueueNotification(value) { queued.push(value); }
  };
  const automation = {
    async readPublicSettings() { counts.publicSettings += 1; return { accounts: structuredClone(accounts) }; },
    async updateAutomationSettings(input) {
      actions.push(structuredClone(input));
      if (input.action === "add") {
        accounts.push({ id: `account-${accounts.length + 1}`, username: input.username, enabled: input.enabled ?? true, timing: {}, courseTimingOverrides: {}, courseWhitelist: [] });
      } else if (input.action === "remove") {
        const index = accounts.findIndex((account) => account.id === input.accountId);
        if (index >= 0) accounts.splice(index, 1);
      } else if (input.action === "toggle") {
        const account = accounts.find((entry) => entry.id === input.accountId);
        if (account) account.enabled = input.enabled;
      } else if (input.action === "timing") {
        const account = accounts.find((entry) => entry.id === input.accountId);
        if (account) {
          account.timing = structuredClone(input.timing);
          if (input.resetCourseTimingOverrides) account.courseTimingOverrides = {};
        }
      } else if (input.action === "whitelist") {
        const account = accounts.find((entry) => entry.id === input.accountId);
        if (account) account.courseWhitelist = structuredClone(input.courseWhitelist);
      } else if (input.action === "password" && automation.passwordError) {
        throw new Error(input.password);
      } else if (input.action === "course-timing") {
        const account = accounts.find((entry) => entry.id === input.accountId);
        if (account) {
          account.courseTimingOverrides ??= {};
          if (input.timing === null) delete account.courseTimingOverrides[input.courseName];
          else account.courseTimingOverrides[input.courseName] = structuredClone(input.timing);
        }
      } else if (input.action === "sign-method") {
        const account = accounts.find((entry) => entry.id === input.accountId);
        if (account) {
          account.signMethod = input.signMethod;
          if (input.resetCourseSignMethodOverrides) account.courseSignMethodOverrides = {};
        }
      } else if (input.action === "course-sign-method") {
        const account = accounts.find((entry) => entry.id === input.accountId);
        if (account) {
          account.courseSignMethodOverrides ??= {};
          if (input.signMethod === null) delete account.courseSignMethodOverrides[input.courseName];
          else account.courseSignMethodOverrides[input.courseName] = input.signMethod;
        }
      }
    },
    async readWorkerStatus() { counts.status += 1; return structuredClone(status); },
    async readWorkerEvents() { counts.events += 1; return structuredClone(events); },
    async querySchedule(accountId, date) {
      queryCalls.push({ accountId, date });
      if (automation.queryError) throw new Error("private query detail");
      return [{ id: "1234567", courseName: " 课程   甲 ", classBeginTime: "09:00:00", classEndTime: "10:00:00", teacherName: "教师甲" }];
    },
    async signNow(accountId, courseName, signMethod) {
      signCalls.push({ accountId, courseName, signMethod });
      if (automation.signNowResult) return automation.signNowResult;
      return { status: "signed", courseName, signParameter: signMethod ?? "timeTableId", stuSignId: "SIGN-1" };
    }
  };
  const ucasClientFactory = ({ username, password }) => ({
    async login() {
      verificationCalls.push({ username, password });
      if (password.includes("invalid")) throw new Error("UCAS rejected credentials");
    }
  });
  const enrollment = createEnrollmentCoordinator({ directory: join(moduleTempDirectory, `enrollment-${fixtureSequence}`) });
  return {
    handler: createCommandHandler({ store, automation, ucasClientFactory, enrollment }),
    accounts, bindings, codes, actions, queued, counts, store, automation, verificationCalls, queryCalls, signCalls, admins, adminModes
  };
}

test("帮助介绍自助绑定；普通用户不能使用管理员绑定码流程", async () => {
  const f = fixture();
  const userHelp = await f.handler({ userId: "qq-new", content: "帮助" });
  assert.match(userHelp, /绑定学号 学号 密码/u);
  const adminHelp = await f.handler({ userId: "qq-admin", content: "管理员帮助" });
  assert.match(adminHelp, /🛠️ 管理员目录/u);
  assert.equal(await f.handler({ userId: "qq-admin", content: "帮助" }), adminHelp);
  assert.equal(await f.handler({ userId: "qq-admin", content: "菜单" }), adminHelp);
  assert.equal(await f.handler({ userId: "qq-admin", content: "管理菜单" }), adminHelp);
  assert.match(await f.handler({ userId: "qq-new", content: "我的ID" }), /qq-new/u);
  assert.equal(await f.handler({ userId: "qq-new", content: "管理菜单" }), "");
  assert.equal(await f.handler({ userId: "qq-new", content: "管理员帮助" }), "");
  assert.match(await f.handler({ userId: "qq-new", content: "绑定 20260001" }), /仅管理员/u);
  assert.equal(f.bindings.has("account-a"), true);
  assert.equal(f.counts.publicSettings, 0);

  f.accounts.push({ id: "account-c", username: "20260003", enabled: false, timing: {}, courseWhitelist: [] });
  const grant = await f.handler({ userId: "qq-admin", content: "绑定码 20260003" });
  const code = grant.split(/\r?\n/u).at(-1);
  assert.match(code, /^CODE-/u);
  assert.match(await f.handler({ userId: "qq-new", content: `绑定 ${code}` }), /仅管理员/u);
  assert.equal(await f.store.getBinding("account-c"), null);
  assert.match(await f.handler({ userId: "qq-admin", content: `绑定 ${code}` }), /绑定成功/u);
  assert.deepEqual(await f.store.getBinding("account-c"), { userId: "qq-admin", mode: "all" });
});

test("普通用户只能读写自己的绑定账号，状态和课表按账号 ID 过滤", async () => {
  const f = fixture();
  const status = await f.handler({ userId: "qq-user-a", content: "状态" });
  assert.match(status, /20260001/u);
  assert.match(status, /默认签到时间：固定 10 分钟/u);
  assert.match(status, /单课时间覆盖：1 门/u);
  assert.match(status, /课表已获取/u);
  assert.doesNotMatch(status, /ready|waiting/u);
  assert.doesNotMatch(status, /20260002|other account|global admin-only/u);
  const schedule = await f.handler({ userId: "qq-user-a", content: "课表" });
  assert.match(schedule, /课程 甲/u);
  const today = shanghaiDate();
  assert.ok(schedule.includes(`${today.slice(0, 4)}-${today.slice(4, 6)}-${today.slice(6, 8)} 09:00–10:00`));
  assert.doesNotMatch(schedule, /秘密课程乙|other account/u);

  const denied = await f.handler({ userId: "qq-user-a", content: "关闭打卡 20260002" });
  assert.match(denied, /没有权限/u);
  assert.equal(f.actions.some((action) => action.action === "toggle"), false);
  assert.match(await f.handler({ userId: "qq-user-a", content: "日志 20260001" }), /普通用户暂不能查看/u);
  assert.equal(f.counts.events, 0);
});

test("自助绑定验证凭据后新账号保持暂停，已存在账号保留开关状态", async () => {
  const f = fixture();
  f.accounts.push({ id: "account-c", username: "20260003", enabled: true, timing: { mode: "fixed", fixedMinutes: 22 }, courseWhitelist: [] });

  const existing = await f.handler({ userId: "qq-enroller-existing", content: "绑定学号 20260003 verified password" });
  assert.match(existing, /登录凭据：已更新/u);
  assert.match(existing, /自动打卡：已开启/u);
  assert.equal(f.accounts.find((account) => account.id === "account-c").enabled, true);
  assert.equal(f.actions.some((action) => action.action === "add" && action.username === "20260003"), false);
  assert.deepEqual(f.actions.find((action) => action.action === "password"), {
    action: "password", accountId: "account-c", password: "verified password"
  });
  assert.deepEqual(await f.store.getBinding("account-c"), { userId: "qq-enroller-existing", mode: "all" });

  const newPassword = "verified pass phrase";
  const created = await f.handler({ userId: "qq-enroller-new", content: `绑定学号 20260004 ${newPassword}` });
  assert.match(created, /自动打卡：已暂停/u);
  assert.doesNotMatch(created, /verified pass phrase/u);
  const account = f.accounts.find((entry) => entry.username === "20260004");
  assert.equal(account.enabled, false);
  assert.deepEqual(await f.store.getBinding(account.id), { userId: "qq-enroller-new", mode: "all" });
  assert.equal(f.actions.find((action) => action.action === "add" && action.username === "20260004").password, newPassword);
  assert.equal(f.verificationCalls.at(-1).password, newPassword);
});

test("同一学号支持多个 QQ，但每个 QQ 只能绑定一个学号", async () => {
  const f = fixture();
  const claimed = await f.handler({ userId: "qq-user-c", content: "绑定学号 20260001 valid password" });
  assert.match(claimed, /绑定成功/u);
  assert.deepEqual(await f.store.getBinding("account-a", "qq-user-a"), { userId: "qq-user-a", mode: "all" });
  assert.deepEqual(await f.store.getBinding("account-a", "qq-user-c"), { userId: "qq-user-c", mode: "all" });
  assert.match(await f.handler({ userId: "qq-user-c", content: "查询课表" }), /20260001/u);

  const multiple = await f.handler({ userId: "qq-user-a", content: "绑定学号 20260003 valid password" });
  assert.match(multiple, /只能绑定一个学号/u);
  assert.equal(f.accounts.some((account) => account.username === "20260003"), false);
});

test("并发自助绑定同一学号可全部成功且只创建一个账号", async () => {
  const f = fixture();
  const replies = await Promise.all([
    f.handler({ userId: "qq-race-a", content: "绑定学号 20260003 correct password" }),
    f.handler({ userId: "qq-race-b", content: "绑定学号 20260003 correct password" })
  ]);
  assert.equal(replies.filter((reply) => /绑定成功/u.test(reply)).length, 2);
  assert.equal((await f.store.getBindings("account-3")).length, 2);
  assert.equal(f.accounts.filter((account) => account.username === "20260003").length, 1);
});

test("共享账号的查询和打卡设置共用，普通 QQ 的通知与解绑互相独立", async () => {
  const f = fixture();
  await f.handler({ userId: "qq-user-c", content: "绑定学号 20260001 valid password" });
  assert.match(await f.handler({ userId: "qq-user-c", content: "通知 关闭" }), /仅修改你自己的/u);
  assert.equal((await f.store.getBinding("account-a", "qq-user-a")).mode, "all");
  assert.equal((await f.store.getBinding("account-a", "qq-user-c")).mode, "off");
  await f.handler({ userId: "qq-user-a", content: "测试通知" });
  assert.equal(f.queued.at(-1).userId, "qq-user-a");
  await f.handler({ userId: "qq-user-c", content: "签到时间 所有 固定 14" });
  assert.match(await f.handler({ userId: "qq-user-a", content: "状态" }), /固定 14 分钟/u);
  const unbound = await f.handler({ userId: "qq-user-a", content: "解绑" });
  assert.match(unbound, /仅解除你自己的绑定/u);
  assert.equal(await f.store.getBinding("account-a", "qq-user-a"), null);
  assert.equal((await f.store.getBinding("account-a", "qq-user-c")).mode, "off");
  assert.match(await f.handler({ userId: "qq-user-c", content: "查询课表" }), /20260001/u);
  assert.match(await f.handler({ userId: "qq-user-a", content: "查询课表" }), /还没有绑定/u);
  assert.equal(f.accounts.find((account) => account.id === "account-a").enabled, true);
});

test("管理员也只能绑定一个学号，管理其他学号不需要额外绑定", async () => {
  const f = fixture();
  assert.match(await f.handler({ userId: "qq-admin", content: "绑定学号 20260001 valid password" }), /绑定成功/u);
  assert.match(await f.handler({ userId: "qq-admin", content: "绑定学号 20260002 valid password" }), /每个 QQ 只能绑定一个/u);
  assert.match(await f.handler({ userId: "qq-admin", content: "查询课表 20260002" }), /20260002/u);
  assert.equal((await f.store.listBindings("qq-admin")).length, 1);
});

test("自助绑定验证失败按 QQ 限制每 15 分钟三次，且不创建账号", async () => {
  const f = fixture();
  for (let i = 0; i < 3; i += 1) {
    assert.match(await f.handler({ userId: "qq-invalid-credentials-test", content: "绑定学号 20260005 invalid password" }), /验证失败/u);
  }
  const blocked = await f.handler({ userId: "qq-invalid-credentials-test", content: "绑定学号 20260005 another password" });
  assert.match(blocked, /次数已达上限/u);
  assert.equal(f.verificationCalls.filter((entry) => entry.username === "20260005").length, 3);
  assert.equal(f.accounts.some((account) => account.username === "20260005"), false);
  assert.equal(f.actions.some((action) => action.action === "password"), false);
});

test("自助绑定验证失败的全局限额为每 15 分钟 50 次", async () => {
  const f = fixture();
  for (let i = 0; i < 50; i += 1) {
    const username = String(21_000_000 + i);
    const reply = await f.handler({ userId: `qq-global-limit-${i}`, content: `绑定学号 ${username} invalid password` });
    assert.match(reply, /验证失败/u);
  }
  const blocked = await f.handler({ userId: "qq-global-limit-final", content: "绑定学号 21001000 invalid password" });
  assert.match(blocked, /次数已达上限/u);
  assert.equal(f.verificationCalls.length, 50);
});

test("课程查询可查看本人暂停账号并按上海时间输出，单课时间只可写自己的账号", async () => {
  const f = fixture();
  f.accounts[0].enabled = false;
  const result = await f.handler({ userId: "qq-user-a", content: "查询课程 20260001 2026-10-15" });
  assert.match(result, /2026-10-15/u);
  assert.match(result, /2026-10-15 09:00–10:00/u);
  assert.match(result, /① 课程 甲\n· 教师：教师甲\n· 时间：2026-10-15 09:00–10:00/u);
  assert.deepEqual(f.queryCalls, [{ accountId: "account-a", date: "20261015" }]);

  const dateOnly = await f.handler({ userId: "qq-user-a", content: "查询课程 20261015" });
  assert.match(dateOnly, /① 课程 甲/u);
  assert.equal(f.queryCalls.at(-1).accountId, "account-a");
  assert.match(f.queryCalls.at(-1).date, /^\d{8}$/u);

  const denied = await f.handler({ userId: "qq-user-a", content: "查询课程 20260002 20261015" });
  assert.match(denied, /没有权限/u);
  assert.equal(f.queryCalls.length, 2);

  const ambiguous = await f.handler({ userId: "qq-user-a", content: "查询课程 20261015 2026-10-16" });
  assert.match(ambiguous, /没有权限/u);
  assert.equal(f.queryCalls.length, 2);

  assert.match(await f.handler({ userId: "qq-user-a", content: "单课时间 20260001 课程   甲 随机 5 9" }), /优先于默认时间/u);
  assert.deepEqual(f.actions.at(-1), {
    action: "course-timing", accountId: "account-a", courseName: "课程 甲", timing: { mode: "random", minMinutes: 5, maxMinutes: 9 }
  });
  assert.match(await f.handler({ userId: "qq-user-a", content: "清除单课时间 20260001 课程 甲" }), /后续使用默认签到时间/u);
  assert.equal(f.actions.at(-1).timing, null);
  const forbiddenTiming = await f.handler({ userId: "qq-user-a", content: "单课时间 20260002 课程乙 固定 5" });
  assert.match(forbiddenTiming, /没有权限/u);
});

test("普通用户无学号时只解析唯一有效绑定，三个课表别名实时查询上海当日", async () => {
  const f = fixture();
  const today = shanghaiDate();

  for (const command of ["查询课程", "查询课表", "课表"]) {
    const reply = await f.handler({ userId: "qq-user-a", content: command });
    assert.match(reply, /① 课程 甲/u);
    assert.equal(f.queryCalls.at(-1).accountId, "account-a");
    assert.equal(f.queryCalls.at(-1).date, today);
  }

  const noBinding = await f.handler({ userId: "qq-no-binding", content: "状态" });
  assert.match(noBinding, /还没有绑定账号/u);
  assert.match(await f.handler({ userId: "qq-no-binding", content: "查询课表" }), /还没有绑定账号/u);
  f.bindings.set("deleted-account-id", { userId: "qq-stale-binding", mode: "all" });
  assert.match(await f.handler({ userId: "qq-stale-binding", content: "状态" }), /还没有绑定账号/u);
  assert.match(await f.handler({ userId: "qq-user-a", content: "状态 20260002" }), /没有权限/u);

  f.bindings.set("account-b", { userId: "qq-user-a", mode: "all" });
  const beforeStatusReads = f.counts.status;
  const beforeActions = f.actions.length;
  assert.match(await f.handler({ userId: "qq-user-a", content: "状态" }), /多个有效绑定/u);
  assert.equal(f.counts.status, beforeStatusReads);
  assert.match(await f.handler({ userId: "qq-user-a", content: "关闭打卡" }), /多个有效绑定/u);
  assert.equal(f.actions.length, beforeActions);
  for (const command of ["查询课程", "查询课表", "课表"]) {
    assert.match(await f.handler({ userId: "qq-user-a", content: command }), /多个有效绑定/u);
  }
  assert.equal(f.queryCalls.length, 3);
  assert.match(await f.handler({ userId: "qq-user-a", content: "查询课表 20260001 2026-10-15" }), /① 课程 甲/u);
});

test("普通用户单绑定可在设置命令中省略学号，管理员仍须显式指定", async () => {
  const f = fixture();
  assert.match(await f.handler({ userId: "qq-user-a", content: "关闭打卡" }), /已更新/u);
  assert.deepEqual(f.actions.at(-1), { action: "toggle", accountId: "account-a", enabled: false });
  assert.match(await f.handler({ userId: "qq-user-a", content: "开启打卡" }), /已更新/u);
  assert.match(await f.handler({ userId: "qq-user-a", content: "刷新课表" }), /已请求/u);
  assert.deepEqual(f.actions.at(-1), { action: "refresh", accountId: "account-a" });

  assert.match(await f.handler({ userId: "qq-user-a", content: "签到时间 固定 15" }), /已更新/u);
  assert.deepEqual(f.actions.at(-1), { action: "timing", accountId: "account-a", timing: { mode: "fixed", fixedMinutes: 15 } });
  const allCoursesTiming = await f.handler({ userId: "qq-user-a", content: "签到时间 所有 固定 10" });
  assert.match(allCoursesTiming, /所有课程已统一，旧单课设置已清除/u);
  assert.deepEqual(f.actions.at(-1), {
    action: "timing", accountId: "account-a", timing: { mode: "fixed", fixedMinutes: 10 }, resetCourseTimingOverrides: true
  });
  assert.deepEqual(f.accounts[0].courseTimingOverrides, {});
  assert.match(await f.handler({ userId: "qq-user-a", content: "单课时间 课程甲 随机 5 9" }), /优先于默认时间/u);
  assert.deepEqual(f.actions.at(-1), {
    action: "course-timing", accountId: "account-a", courseName: "课程甲", timing: { mode: "random", minMinutes: 5, maxMinutes: 9 }
  });
  assert.match(await f.handler({ userId: "qq-user-a", content: "清除单课时间 课程甲" }), /后续使用默认签到时间/u);
  assert.deepEqual(f.actions.at(-1), { action: "course-timing", accountId: "account-a", courseName: "课程甲", timing: null });
  assert.match(await f.handler({ userId: "qq-user-a", content: "不打卡名单 课程甲|英语" }), /已更新/u);
  assert.deepEqual(f.actions.at(-1), { action: "whitelist", accountId: "account-a", courseWhitelist: ["课程甲", "英语"] });

  assert.match(await f.handler({ userId: "qq-user-a", content: "通知 仅失败" }), /已更新/u);
  assert.match(await f.handler({ userId: "qq-user-a", content: "测试通知" }), /已排队/u);
  assert.equal(f.queued.at(-1).accountId, "account-a");
  assert.match(await f.handler({ userId: "qq-user-a", content: "解绑" }), /已解除绑定/u);
  assert.equal(await f.store.getBinding("account-a"), null);

  assert.match(await f.handler({ userId: "qq-admin", content: "开启打卡" }), /明确提供学号/u);
});

test("管理员模式内无参账号命令必须明确学号，显式学号仍可管理其他账号", async () => {
  const unbound = fixture();
  assert.match(await unbound.handler({ userId: "qq-admin", content: "状态" }), /明确提供学号/u);
  for (const command of ["查询课程", "查询课表", "课表"]) {
    assert.match(await unbound.handler({ userId: "qq-admin", content: command }), /明确提供学号/u);
  }
  assert.equal(unbound.counts.status, 0);
  assert.equal(unbound.queryCalls.length, 0);

  const f = fixture();
  await f.store.unbind("account-a");
  assert.match(await f.handler({ userId: "qq-admin", content: "绑定学号 20260001 admin verified password" }), /绑定成功/u);
  assert.equal((await f.store.getBinding("account-a")).userId, "qq-admin");
  const status = await f.handler({ userId: "qq-admin", content: "状态" });
  assert.match(status, /明确提供学号/u);
  assert.equal(f.counts.status, 0);
  for (const command of ["查询课程", "查询课表", "课表"]) {
    assert.match(await f.handler({ userId: "qq-admin", content: command }), /明确提供学号/u);
  }
  assert.equal(f.queryCalls.length, 0);
  assert.match(await f.handler({ userId: "qq-admin", content: "查询课程 20260001" }), /20260001/u);
  assert.deepEqual(f.queryCalls.map((entry) => entry.accountId), ["account-a"]);

  assert.match(await f.handler({ userId: "qq-admin", content: "关闭打卡 20260002" }), /已更新/u);
  assert.deepEqual(f.actions.at(-1), { action: "toggle", accountId: "account-b", enabled: false });

  f.bindings.set("account-b", { userId: "qq-admin", mode: "all" });
  const beforeCalls = f.queryCalls.length;
  assert.match(await f.handler({ userId: "qq-admin", content: "课表" }), /明确提供学号/u);
  assert.equal(f.queryCalls.length, beforeCalls);
});

test("管理员外模式按普通绑定权限运行，进入后裸账号命令拒绝且新增学号别名可用", async () => {
  const f = fixture();
  f.adminModes.set("qq-admin", false);
  const userHelp = await f.handler({ userId: "qq-user-a", content: "帮助" });
  const adminPersonalHelp = await f.handler({ userId: "qq-admin", content: "帮助" });
  assert.ok(adminPersonalHelp.startsWith(userHelp));
  assert.match(adminPersonalHelp, /▸ 管理员入口\n  进入管理员模式 \/ 管理员帮助/u);
  assert.doesNotMatch(userHelp, /管理员入口|进入管理员模式/u);
  assert.match(await f.handler({ userId: "qq-admin", content: "管理员帮助" }), /🛠️ 管理员目录/u);
  assert.equal(await f.store.getAdminMode("qq-admin"), false);
  assert.match(await f.handler({ userId: "qq-admin", content: "关闭打卡 20260002" }), /没有权限|还没有绑定/u);
  assert.match(await f.handler({ userId: "qq-admin", content: "日志" }), /进入管理员模式/u);
  assert.match(await f.handler({ userId: "qq-admin", content: "添加学号 20260004 alias password" }), /进入管理员模式/u);
  assert.match(await f.handler({ userId: "qq-admin", content: "删除学号 20260002" }), /进入管理员模式/u);

  assert.match(await f.handler({ userId: "qq-admin", content: "绑定学号 20260003 verified password" }), /绑定成功/u);
  const ownStatus = await f.handler({ userId: "qq-admin", content: "状态" });
  assert.match(ownStatus, /20260003/u);
  assert.doesNotMatch(ownStatus, /20260001|20260002/u);
  const ownSchedule = await f.handler({ userId: "qq-admin", content: "查询课表" });
  assert.match(ownSchedule, /20260003/u);
  assert.deepEqual(f.queryCalls.at(-1).accountId, "account-3");
  assert.match(await f.handler({ userId: "qq-admin", content: "账号列表" }), /20260003/u);
  assert.doesNotMatch(await f.handler({ userId: "qq-admin", content: "账号列表" }), /20260001|20260002/u);
  assert.match(await f.handler({ userId: "qq-admin", content: "绑定学号 20260005 another verified password" }), /只能绑定一个学号/u);
  assert.equal(f.accounts.some((account) => account.username === "20260005"), false);

  assert.match(await f.handler({ userId: "qq-admin", content: "进入管理员模式" }), /管理员模式已开启/u);
  assert.equal(await f.store.getAdminMode("qq-admin"), true);
  assert.match(await f.handler({ userId: "qq-admin", content: "状态" }), /明确提供学号/u);
  for (const command of ["查询课程", "查询课表", "课表", "关闭打卡"]) {
    assert.match(await f.handler({ userId: "qq-admin", content: command }), /明确提供学号/u);
  }
  assert.deepEqual(f.queryCalls.map((entry) => entry.accountId), ["account-3"]);
  assert.match(await f.handler({ userId: "qq-admin", content: "关闭打卡 20260002" }), /已更新/u);
  assert.deepEqual(f.actions.at(-1), { action: "toggle", accountId: "account-b", enabled: false });
  const globalList = await f.handler({ userId: "qq-admin", content: "账号列表" });
  assert.match(globalList, /20260001/u);
  assert.match(globalList, /20260002/u);

  const addStudentReply = await f.handler({ userId: "qq-admin", content: "添加学号 20260004 alias password" });
  assert.match(addStudentReply, /学号已添加/u);
  assert.match(addStudentReply, /该学号的使用者发送“绑定学号 学号 密码”验证后绑定/u);
  assert.doesNotMatch(addStudentReply, /CODE-/u);
  assert.equal(f.codes.size, 0);
  assert.equal(f.accounts.find((account) => account.username === "20260004").enabled, false);
  const deletePrompt = await f.handler({ userId: "qq-admin", content: "删除学号 20260004" });
  const token = deletePrompt.match(/删除学号 20260004 确认 ([A-F0-9]{12})$/u)?.[1];
  assert.ok(token);
  assert.match(await f.handler({ userId: "qq-admin", content: `删除学号 20260004 确认 ${token}` }), /账号已删除/u);
  assert.equal(f.accounts.some((account) => account.username === "20260004"), false);
});

test("退出管理员模式清除待删除码、不改账号设置且模式按用户隔离", async () => {
  const f = fixture();
  await f.store.unbind("account-a");
  assert.match(await f.handler({ userId: "qq-admin", content: "绑定学号 20260001 verified password" }), /绑定成功/u);
  const deletePrompt = await f.handler({ userId: "qq-admin", content: "删除账号 20260001" });
  const token = deletePrompt.match(/删除账号 20260001 确认 ([A-F0-9]{12})$/u)?.[1];
  assert.ok(token);
  const originalEnabled = f.accounts.find((account) => account.id === "account-a").enabled;

  f.admins.add("qq-admin-two");
  assert.equal(await f.store.getAdminMode("qq-admin-two"), false);
  assert.match(await f.handler({ userId: "qq-admin-two", content: "进入管理员模式" }), /管理员模式已开启/u);
  assert.equal(await f.store.getAdminMode("qq-admin-two"), true);
  assert.match(await f.handler({ userId: "qq-admin", content: "退出管理员模式" }), /管理员模式已退出/u);
  assert.equal(await f.store.getAdminMode("qq-admin"), false);
  assert.equal(await f.store.getAdminMode("qq-admin-two"), true);
  assert.equal(f.accounts.find((account) => account.id === "account-a").enabled, originalEnabled);
  assert.match(await f.handler({ userId: "qq-admin", content: "状态" }), /20260001/u);
  assert.doesNotMatch(await f.handler({ userId: "qq-admin", content: "状态" }), /20260002/u);
  assert.match(await f.handler({ userId: "qq-admin", content: "关闭打卡 20260002" }), /没有权限/u);

  assert.match(await f.handler({ userId: "qq-admin", content: "进入管理员模式" }), /管理员模式已开启/u);
  const replay = await f.handler({ userId: "qq-admin", content: `删除账号 20260001 确认 ${token}` });
  assert.match(replay, /确认码无效或已过期/u);
  assert.equal(f.accounts.some((account) => account.username === "20260001"), true);
  assert.equal(f.actions.some((action) => action.action === "remove" && action.accountId === "account-a"), false);

  assert.match(await f.handler({ userId: "qq-user-a", content: "进入管理员模式" }), /仅配置的管理员/u);
  assert.equal(await f.store.getAdminMode("qq-user-a"), false);
  assert.match(await f.handler({ userId: "qq-user-a", content: "退出管理员模式" }), /当前未开启/u);
});

test("停止和启动单门课程按标准化全名更新名单并只读展示本人名单", async () => {
  const f = fixture();
  f.accounts[0].enabled = false;
  f.accounts[0].courseWhitelist = ["高等   数学", "英语", "高等 数学"];
  f.accounts[1].courseWhitelist = ["他人课程"];
  const beforeActions = f.actions.length;

  assert.match(await f.handler({ userId: "qq-user-a", content: "停止打卡 高等   数学" }), /设置未改变/u);
  assert.deepEqual(f.accounts[0].courseWhitelist, ["高等   数学", "英语", "高等 数学"]);
  assert.equal(f.actions.length, beforeActions);

  const started = await f.handler({ userId: "qq-user-a", content: "启动打卡 高等 数学" });
  assert.match(started, /请先发送“开启打卡”/u);
  assert.deepEqual(f.accounts[0].courseWhitelist, ["英语"]);
  assert.match(await f.handler({ userId: "qq-user-a", content: "停止打卡 高等 数学" }), /已停止/u);
  assert.deepEqual(f.accounts[0].courseWhitelist, ["英语", "高等 数学"]);

  const list = await f.handler({ userId: "qq-user-a", content: "停止打卡课程名单" });
  assert.match(list, /英语/u);
  assert.match(list, /高等 数学/u);
  assert.doesNotMatch(list, /他人课程/u);
  assert.equal(f.actions.length, beforeActions + 2);
  assert.match(await f.handler({ userId: "qq-admin", content: "停止打卡课程名单" }), /明确提供学号/u);
  assert.match(await f.handler({ userId: "qq-user-a", content: "停止打卡课程名单 20260002" }), /没有权限/u);
});

test("账号列表仅列出本人绑定", async () => {
  const f = fixture();
  const list = await f.handler({ userId: "qq-user-a", content: "账号列表" });
  assert.match(list, /20260001/u);
  assert.doesNotMatch(list, /20260002/u);
  assert.match(await f.handler({ userId: "qq-new", content: "日志" }), /普通用户暂不能查看/u);
});

test("更新密码完整接收空格且命令回复和内部异常都不泄露密码", async () => {
  const f = fixture();
  f.automation.passwordError = true;
  const password = "new pass phrase with spaces";
  const reply = await f.handler({ userId: "qq-admin", content: `更新密码 20260001 ${password}` });
  assert.equal(f.actions.at(-1).password, password);
  assert.doesNotMatch(reply, /new pass phrase|spaces/u);
  assert.equal(reply, "操作暂时失败，请稍后重试。");
});

test("管理员添加账号时原子请求保持关闭并返回绑定码", async () => {
  const f = fixture();
  const reply = await f.handler({ userId: "qq-admin", content: "添加账号 20260003 initial pass" });
  assert.match(reply, /自动打卡：已暂停/u);
  assert.match(reply, /\n\nCODE-/u);
  assert.deepEqual(f.actions.at(-1), {
    action: "add", username: "20260003", password: "initial pass", enabled: false
  });
  assert.equal(f.accounts.find((account) => account.username === "20260003").enabled, false);
  assert.equal(f.actions.some((action) => action.action === "toggle"), false);
  assert.doesNotMatch(reply, /initial pass/u);
});

test("删除账号必须使用同一用户和账号的短效二次确认码，删除后清理绑定", async () => {
  const f = fixture();
  const first = await f.handler({ userId: "qq-admin", content: "删除账号 20260001" });
  const token = first.match(/确认 ([A-F0-9]{12})$/u)?.[1];
  assert.ok(token);
  assert.match(first, /\n\n删除账号 20260001 确认 [A-F0-9]{12}$/u);
  assert.equal(f.accounts.length, 2);
  assert.match(await f.handler({ userId: "qq-user-a", content: "删除账号 20260001 确认 BADTOKEN" }), /仅管理员/u);
  assert.equal(f.accounts.length, 2);
  assert.match(await f.handler({ userId: "qq-user-b", content: `删除账号 20260001 确认 ${token}` }), /仅管理员/u);
  assert.equal(f.accounts.length, 2);

  assert.match(await f.handler({ userId: "qq-admin", content: `删除账号 20260001 确认 ${token}` }), /已删除/u);
  assert.equal(f.accounts.some((account) => account.username === "20260001"), false);
  assert.equal(f.bindings.has("account-a"), false);
  assert.equal(f.actions.filter((action) => action.action === "remove").length, 1);
});

test("通知关闭时测试通知不入队，失败模式只排入 failure 类型", async () => {
  const f = fixture();
  await f.handler({ userId: "qq-user-a", content: "通知 20260001 关闭" });
  assert.match(await f.handler({ userId: "qq-user-a", content: "测试通知 20260001" }), /通知已关闭/u);
  assert.equal(f.queued.length, 0);

  await f.handler({ userId: "qq-user-a", content: "通知 20260001 仅失败" });
  assert.match(await f.handler({ userId: "qq-user-a", content: "测试通知 20260001" }), /已排队/u);
  assert.equal(f.queued.length, 1);
  assert.equal(f.queued[0].kind, "failure");
  assert.equal(f.queued[0].accountId, "account-a");
});

test("管理员删除指令先生成确认码，未知异常不回显内部消息", async () => {
  const f = fixture();
  const reply = await f.handler({ userId: "qq-admin", content: "删除账号 20260002" });
  assert.match(reply, /二次确认/u);
  assert.equal(f.actions.some((action) => action.action === "remove"), false);
});

test("签到时间解析接受不同空格数量", async () => {
  const f = fixture();
  assert.match(await f.handler({ userId: "qq-user-a", content: "签到时间 20260001    固定   15" }), /已更新/u);
  assert.deepEqual(f.actions.at(-1).timing, { mode: "fixed", fixedMinutes: 15 });
  assert.match(await f.handler({ userId: "qq-user-a", content: "签到时间 20260001   随机  12   24" }), /已更新/u);
  assert.deepEqual(f.actions.at(-1).timing, { mode: "random", minMinutes: 12, maxMinutes: 24 });
});

test("真实 QQ store 的已验证绑定返回值与普通用户状态隔离兼容", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-command-store-"));
  try {
    const store = createQqStore({
      directory,
      appId: "commands-integration",
      bootstrapToken: "test-bootstrap-token",
      adminOpenids: ["qq-admin-integration"]
    });
    const accounts = [
      { id: "integration-a", username: "20990001", enabled: false, timing: {}, courseWhitelist: [] },
      { id: "integration-b", username: "20990002", enabled: true, timing: {}, courseWhitelist: [] }
    ];
    const counts = { status: 0 };
    const automation = {
      async readPublicSettings() { return { accounts: structuredClone(accounts) }; },
      async updateAutomationSettings() {},
      async readWorkerStatus() {
        counts.status += 1;
        return { accounts: [
          { id: "integration-a", date: "20261015", scheduleState: "waiting" },
          { id: "integration-b", date: "20261015", scheduleState: "ready", lastError: "private status" }
        ] };
      },
      async readWorkerEvents() { return []; }
    };
    const handler = createCommandHandler({
      store,
      automation,
      ucasClientFactory: () => ({ async login() {} })
    });

    assert.match(await handler({ userId: "qq-user-integration", content: "绑定学号 20990001 verified password" }), /自动打卡：已暂停/u);
    assert.deepEqual(await store.getBinding("integration-a"), { userId: "qq-user-integration", mode: "all" });
    assert.deepEqual(await store.listBindings("qq-user-integration"), [
      { accountId: "integration-a", userId: "qq-user-integration", mode: "all" }
    ]);

    const visibleStatus = await handler({ userId: "qq-user-integration", content: "状态" });
    assert.match(visibleStatus, /20990001/u);
    assert.doesNotMatch(visibleStatus, /20990002|private status/u);
    assert.equal(counts.status, 1);
    const denied = await handler({ userId: "qq-user-integration", content: "状态 20990002" });
    assert.match(denied, /没有权限/u);
    assert.equal(counts.status, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("签到方式支持全部统一与单课覆盖，管理员模式下必须指定学号", async () => {
  const f = fixture();
  const single = await f.handler({ userId: "qq-user-a", content: "签到方式 高等数学 课堂扫码" });
  assert.match(single, /单课签到方式已更新/u);
  assert.match(single, /课堂扫码/u);
  assert.deepEqual(f.actions.at(-1), {
    action: "course-sign-method", accountId: "account-a", courseName: "高等数学", signMethod: "courseSchedId"
  });

  const statusAfterSingle = await f.handler({ userId: "qq-user-a", content: "状态" });
  assert.match(statusAfterSingle, /默认签到方式：打卡机扫码/u);
  assert.match(statusAfterSingle, /单课方式覆盖：1 门/u);

  const defaultOnly = await f.handler({ userId: "qq-user-a", content: "签到方式 课堂扫码" });
  assert.match(defaultOnly, /默认签到方式已更新/u);
  assert.deepEqual(f.actions.at(-1), {
    action: "sign-method", accountId: "account-a", signMethod: "courseSchedId"
  });
  assert.equal(f.accounts[0].courseSignMethodOverrides["高等数学"], "courseSchedId");

  const allReset = await f.handler({ userId: "qq-user-a", content: "签到方式 所有 打卡机扫码" });
  assert.match(allReset, /所有课程已统一，旧单课方式设置已清除/u);
  assert.deepEqual(f.actions.at(-1), {
    action: "sign-method", accountId: "account-a", signMethod: "timeTableId", resetCourseSignMethodOverrides: true
  });
  assert.deepEqual(f.accounts[0].courseSignMethodOverrides, {});

  await f.handler({ userId: "qq-user-a", content: "签到方式 课程甲 课堂扫码" });
  const cleared = await f.handler({ userId: "qq-user-a", content: "清除单课方式 课程甲" });
  assert.match(cleared, /单课签到方式已清除/u);
  assert.deepEqual(f.actions.at(-1), {
    action: "course-sign-method", accountId: "account-a", courseName: "课程甲", signMethod: null
  });

  const invalid = await f.handler({ userId: "qq-user-a", content: "签到方式 所有 未知方式" });
  assert.match(invalid, /仅支持“打卡机扫码”或“课堂扫码”/u);

  assert.match(await f.handler({ userId: "qq-admin", content: "签到方式 所有 课堂扫码" }), /明确提供学号/u);
  const adminUpdate = await f.handler({ userId: "qq-admin", content: "签到方式 20260002 所有 课堂扫码" });
  assert.match(adminUpdate, /默认签到方式已更新/u);
  assert.deepEqual(f.actions.at(-1), {
    action: "sign-method", accountId: "account-b", signMethod: "courseSchedId", resetCourseSignMethodOverrides: true
  });
});

test("立即签到支持默认方式、指定方式与管理员代签", async () => {
  const f = fixture();
  const defaultSign = await f.handler({ userId: "qq-user-a", content: "立即签到 高等数学" });
  assert.match(defaultSign, /✅ 立即签到成功/u);
  assert.match(defaultSign, /· 方式：打卡机扫码/u);
  assert.match(defaultSign, /不再重复自动签到/u);
  assert.deepEqual(f.signCalls.at(-1), { accountId: "account-a", courseName: "高等数学", signMethod: undefined });

  const classroomSign = await f.handler({ userId: "qq-user-a", content: "立即签到 高等数学 课堂扫码" });
  assert.match(classroomSign, /✅ 立即签到成功/u);
  assert.match(classroomSign, /· 方式：课堂扫码/u);
  assert.deepEqual(f.signCalls.at(-1), { accountId: "account-a", courseName: "高等数学", signMethod: "courseSchedId" });

  f.automation.signNowResult = { status: "already_signed", courseName: "高等数学" };
  assert.match(await f.handler({ userId: "qq-user-a", content: "立即签到 高等数学" }), /课表显示已签到/u);

  f.automation.signNowResult = { status: "not_found", courseName: "未知课程" };
  assert.match(await f.handler({ userId: "qq-user-a", content: "立即签到 未知课程" }), /未找到今日课程/u);

  f.automation.signNowResult = { status: "failed", courseName: "高等数学", signParameter: "courseSchedId", reason: "未到签到时间" };
  const failedReply = await f.handler({ userId: "qq-user-a", content: "立即签到 高等数学 课堂扫码" });
  assert.match(failedReply, /⚠️ 立即签到未成功/u);
  assert.match(failedReply, /· 原因：未到签到时间/u);

  f.automation.signNowResult = null;
  assert.match(await f.handler({ userId: "qq-admin", content: "立即签到 高等数学" }), /明确提供学号/u);
  const adminSign = await f.handler({ userId: "qq-admin", content: "立即签到 20260002 高等数学 课堂扫码" });
  assert.match(adminSign, /✅ 立即签到成功/u);
  assert.deepEqual(f.signCalls.at(-1), { accountId: "account-b", courseName: "高等数学", signMethod: "courseSchedId" });
});

