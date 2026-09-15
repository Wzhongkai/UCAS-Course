import { createServer } from "node:net";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readAutomationSettings, writeWorkerStatus, readWorkerEvents, writeWorkerEvents, encryptionReady, dataDirectory } from "./automation/store.mjs";
import { accessReady } from "./automation/auth.mjs";
import { UcasClient } from "./ucas.mjs";
import { scheduleOutcome, shanghaiDate, signTargetForAttempt, signWindow, timeAtSix } from "./schedule.mjs";

const completedFile = resolve(dataDirectory, "completed.json");
const logFile = resolve(dataDirectory, "auto-sign.log");
const states = new Map();
const completed = new Set();
let lastConfigAt = 0;
let lastStatusAt = 0;
let configError = "";
let busy = false;
let logWrite = Promise.resolve();
let completedWrite = Promise.resolve();
let recentEvents = [];

function hint(username) {
  return `${username.slice(0, 3)}***${username.slice(-3)}`;
}

function safeText(message) {
  const secrets = [...states.values()].flatMap((state) => [state.client?.password, state.client?.username]).filter(Boolean);
  return secrets.reduce((value, secret) => value.replaceAll(secret, "[已隐藏]"), String(message));
}

function log(message) {
  const safeMessage = safeText(message);
  const at = new Date().toISOString();
  const line = `[${new Date(at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}] ${safeMessage}`;
  recentEvents.push({ at, message: safeMessage });
  recentEvents = recentEvents.slice(-100);
  console.log(line);
  logWrite = logWrite.then(async () => {
    await mkdir(dataDirectory, { recursive: true });
    await appendFile(logFile, `${line}\n`, "utf8");
    await writeWorkerEvents(recentEvents);
  }).catch(() => {});
}

function label(state, group) {
  return `${state.usernameHint} · ${group.first.courseName || "未命名课程"}（${group.first.id}）`;
}

function completionKey(state, group) {
  return state.id === "legacy" ? group.key : `${state.id}:${group.key}`;
}

async function loadCompleted() {
  try {
    const data = JSON.parse(await readFile(completedFile, "utf8"));
    for (const key of Array.isArray(data.completed) ? data.completed : []) {
      if (typeof key === "string") completed.add(key);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") log("历史签到记录读取失败，将参考课表签到状态。");
  }
}

async function saveCompleted() {
  const cutoff = shanghaiDate(Date.now() - 14 * 24 * 60 * 60_000);
  for (const key of completed) {
    const date = key.match(/(?:^|:)(\d{8}):/)?.[1];
    if (date && date < cutoff) completed.delete(key);
  }
  const snapshot = JSON.stringify({ completed: [...completed] }, null, 2);
  completedWrite = completedWrite.catch(() => {}).then(async () => {
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(completedFile, snapshot, "utf8");
  });
  await completedWrite;
}

async function markCompleted(state, group, message) {
  const key = completionKey(state, group);
  if (completed.has(key)) return;
  completed.add(key);
  state.messages.set(group.key, message);
  log(`${label(state, group)}：${message}。同一时间段的其他课程入口不再尝试。`);
  try { await saveCompleted(); }
  catch { log("签到记录保存失败，本次运行仍会停止重试。"); }
}

function createState(account) {
  return {
    id: account.id,
    usernameHint: hint(account.credentials.username),
    version: account.updatedAt,
    refreshVersion: account.refreshRequestedAt,
    enabled: Boolean(account.enabled),
    timing: account.timing,
    client: account.enabled ? new UcasClient(account.credentials) : null,
    activeDate: "",
    groups: [],
    scheduleState: "waiting",
    nextScheduleAt: 0,
    lastScheduleAt: 0,
    lastError: "",
    clockOffset: 0,
    clockFetchedAt: 0,
    attempts: new Map(),
    nextAttemptAt: new Map(),
    messages: new Map(),
    expired: new Set(),
    forceRefresh: false,
    allDoneLogged: false
  };
}

async function syncSettings(now) {
  if (now - lastConfigAt < 3_000) return;
  lastConfigAt = now;
  try {
    if (!encryptionReady()) throw new Error("AUTO_SIGN_SECRET 未配置或格式不正确");
    if (!accessReady()) throw new Error("UCAS_ACCESS_KEY 未配置或长度不足");
    const settings = await readAutomationSettings();
    const accountIds = new Set(settings.accounts.map((account) => account.id));
    for (const id of states.keys()) {
      if (!accountIds.has(id)) {
        states.delete(id);
        log("一个账号已移除，停止其后续任务。");
      }
    }
    for (const account of settings.accounts) {
      const current = states.get(account.id);
      if (!current || current.version !== account.updatedAt) {
        const state = createState(account);
        states.set(account.id, state);
        log(`${state.usernameHint}：自动签到已${state.enabled ? "启用" : "关闭"}。`);
      } else if (current.refreshVersion !== account.refreshRequestedAt) {
        current.refreshVersion = account.refreshRequestedAt;
        if (account.refreshRequestedAt) {
          current.forceRefresh = true;
          current.nextScheduleAt = 0;
          current.scheduleState = "waiting";
        }
      }
    }
    configError = "";
  } catch (error) {
    states.clear();
    const message = error instanceof Error ? error.message : "读取自动签到配置失败";
    if (message !== configError) log(`自动签到配置错误：${message}`);
    configError = message;
  }
}

async function refreshSchedule(state, now) {
  try {
    const courses = await state.client.schedule(state.activeDate);
    const outcome = scheduleOutcome(courses, state.activeDate);
    state.groups = outcome.groups;
    state.lastScheduleAt = Date.now();
    state.nextScheduleAt = timeAtSix(shanghaiDate(now + 24 * 60 * 60_000));
    state.scheduleState = outcome.state;
    state.lastError = "";
    state.allDoneLogged = false;
    if (courses.length === 0) {
      log(`${state.usernameHint} · ${state.activeDate}：今日无课，本日不再查询课表。`);
    } else {
      log(`${state.usernameHint} · ${state.activeDate} 课表已获取：${courses.length} 条，合并为 ${state.groups.length} 组。`);
    }
    for (const group of state.groups) {
      if (group.signTargets.some((course) => course.signStatus === "1")) {
        await markCompleted(state, group, "同一时间段的课表入口显示已签到");
      }
    }
  } catch (error) {
    state.client.sessionId = "";
    state.nextScheduleAt = now + 5 * 60_000;
    state.scheduleState = "error";
    state.lastError = safeText(error instanceof Error ? error.message : "课表查询失败");
    log(`${state.usernameHint}：课表查询失败：${state.lastError}；5 分钟后重试。`);
  }
}

async function timestampForSign(state) {
  if (Date.now() - state.clockFetchedAt >= 30_000) {
    try {
      const startedAt = Date.now();
      const serverTimestamp = await state.client.serverTimestamp();
      const finishedAt = Date.now();
      state.clockOffset = serverTimestamp + Math.floor((finishedAt - startedAt) / 2) - finishedAt;
      state.clockFetchedAt = finishedAt;
    } catch {
      state.clockFetchedAt = Date.now();
      log(`${state.usernameHint}：UCAS 校时失败，暂用上次时差或本机时间。`);
    }
  }
  return Date.now() + state.clockOffset - 3_000;
}

async function attemptSign(state, group) {
  const count = (state.attempts.get(group.key) ?? 0) + 1;
  state.attempts.set(group.key, count);
  const target = signTargetForAttempt(group, count);
  let delay = 10_000;
  try {
    const timestamp = await timestampForSign(state);
    const result = await state.client.sign(target.id, timestamp);
    if (result?.STATUS === "0" && result?.result?.stuSignStatus === "1") {
      await markCompleted(state, group, `第 ${count} 次尝试成功，课程入口 ${target.id}${result.result.stuSignId ? `，记录 ${result.result.stuSignId}` : ""}`);
      return;
    }
    const reason = result?.result?.msg ?? result?.ERRMSG ?? result?.msg ?? result?.message ?? "上游未确认成功";
    const message = safeText(`第 ${count} 次未成功，课程入口 ${target.id}：${String(reason)}`);
    state.messages.set(group.key, message);
    log(`${label(state, group)}：${message}`);
  } catch (error) {
    if (error?.status === 401) state.client.sessionId = "";
    if (error?.status === 429) delay = Math.max(10_000, error.retryAfterMs ?? 60_000);
    const message = safeText(`第 ${count} 次请求失败，课程入口 ${target.id}：${error instanceof Error ? error.message : "未知错误"}`);
    state.messages.set(group.key, message);
    log(`${label(state, group)}：${message}`);
  } finally {
    state.nextAttemptAt.set(group.key, Date.now() + delay);
  }
}

async function tickAccount(state, now) {
  if (!state.enabled || !state.client) return;
  const today = shanghaiDate(now);
  if (today !== state.activeDate) {
    state.activeDate = today;
    state.groups = [];
    state.scheduleState = "waiting";
    state.attempts.clear();
    state.nextAttemptAt.clear();
    state.messages.clear();
    state.expired.clear();
    state.allDoneLogged = false;
    state.nextScheduleAt = state.forceRefresh || now >= timeAtSix(today) ? now : timeAtSix(today);
    log(`${state.usernameHint} · ${today}：${state.nextScheduleAt === now ? "准备查询当天课表" : "等待 06:00 查询课表"}。`);
  }
  if (now >= state.nextScheduleAt) {
    state.forceRefresh = false;
    await refreshSchedule(state, now);
  }
  if (state.groups.length > 0 && state.groups.every((group) => completed.has(completionKey(state, group)))) {
    if (!state.allDoneLogged) {
      state.allDoneLogged = true;
      log(`${state.usernameHint}：今日所有目标课程已签到，停止本日签到尝试。`);
    }
    return;
  }
  for (const group of state.groups) {
    if (completed.has(completionKey(state, group))) continue;
    const window = signWindow(group, state.timing, state.id);
    const currentTime = Date.now();
    if (currentTime > window.stopAt) {
      if (!state.expired.has(group.key) && currentTime >= window.prepareAt) {
        state.expired.add(group.key);
        state.messages.set(group.key, "第一节课已结束，请人工核查");
        log(`${label(state, group)}：第一节课已结束，停止尝试。`);
      }
      continue;
    }
    if (currentTime < window.attemptAt || currentTime < (state.nextAttemptAt.get(group.key) ?? 0)) continue;
    await attemptSign(state, group);
  }
}

function publicPlan(state, now) {
  return state.groups.map((group) => {
    const window = signWindow(group, state.timing, state.id);
    let status = "待开始";
    if (completed.has(completionKey(state, group))) status = "已签到";
    else if (now > window.stopAt) status = "未成功，已停止";
    else if ((state.attempts.get(group.key) ?? 0) > 0) status = "重试中";
    else if (now >= window.prepareAt) status = "准备中";
    return {
      key: group.key,
      courseName: group.first.courseName ?? "",
      teacherName: [...new Set(group.signTargets.map((course) => String(course.teacherName ?? "").trim()).filter(Boolean))].join(" / "),
      courseId: group.first.id,
      courseIds: group.signTargets.map((course) => course.id),
      start: group.start,
      end: group.end,
      targetCount: group.signTargets.length,
      attemptAt: window.attemptAt,
      state: status,
      attempts: state.attempts.get(group.key) ?? 0,
      message: state.messages.get(group.key) ?? ""
    };
  });
}

async function writeStatus(now) {
  await writeWorkerStatus({
    updatedAt: new Date(now).toISOString(),
    lastError: configError,
    accounts: [...states.values()].map((state) => ({
      id: state.id,
      usernameHint: state.usernameHint,
      enabled: state.enabled,
      date: state.activeDate,
      scheduleState: state.scheduleState,
      lastScheduleAt: state.lastScheduleAt || null,
      nextScheduleAt: Number.isFinite(state.nextScheduleAt) ? state.nextScheduleAt : null,
      lastError: state.lastError,
      plan: publicPlan(state, now)
    }))
  });
  lastStatusAt = now;
}

async function tick() {
  const now = Date.now();
  await syncSettings(now);
  await Promise.all([...states.values()].map((state) => tickAccount(state, now).catch((error) => {
    log(`${state.usernameHint}：调度异常：${error instanceof Error ? error.message : "未知错误"}`);
  })));
  if (now - lastStatusAt >= 3_000) await writeStatus(Date.now());
}

const lock = createServer();
await new Promise((resolve, reject) => {
  lock.once("error", reject);
  lock.listen(43857, "127.0.0.1", resolve);
}).catch((error) => {
  console.error(`后台任务无法启动（可能已有一个实例）：${error.message}`);
  process.exit(1);
});
try { recentEvents = await readWorkerEvents(); }
catch { recentEvents = []; }
await loadCompleted();
if (!process.env.AUTO_SIGN_SECRET) log("自动签到密钥尚未设置，后台任务不会启动。");
log("自动签到后台进程已启动。网页可以关闭，进程必须保持运行。");
await tick();
setInterval(async () => {
  if (busy) return;
  busy = true;
  try { await tick(); }
  catch (error) { log(`调度异常：${error instanceof Error ? error.message : "未知错误"}`); }
  finally { busy = false; }
}, 1_000);
