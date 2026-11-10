import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { dataDirectory } from "../automation/store.mjs";
import { withFileLock } from "../automation/file-lock.mjs";

const MODES = new Set(["all", "failure", "off"]);
const KINDS = new Set(["success", "failure", "schedule_error", "daily_done", "upcoming"]);
const FAILURE_KINDS = new Set(["failure", "schedule_error"]);
const INBOUND_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_INBOUND_IDS = 100_000;
const BINDING_CODE_TTL_MS = 10 * 60 * 1000;
const BINDING_GUESS_WINDOW_MS = 15 * 60 * 1000;
const MAX_BINDING_GUESSES = 5;
const MAX_GLOBAL_BINDING_GUESSES = 500;
const MAX_SEND_ATTEMPTS = 5;
const SENDER_LEASE_MS = 5 * 60 * 1000;
const TERMINAL_HISTORY_LIMIT = 1_000;
const NOTIFICATION_ID_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_NOTIFICATION_IDS = 50_000;
const MAX_PENDING_NOTIFICATIONS = 1_000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function emptyState() {
  return {
    version: 2,
    admins: [],
    bootstrapClaimed: false,
    adminModes: {},
    bindings: {},
    bindingCodes: {},
    bindingAttempts: {},
    bindingGuess: { windowStartedAt: 0, count: 0 },
    inbound: {},
    notificationIds: {},
    notifications: [],
    notificationStats: { sent: 0, failed: 0 },
    senderLease: null,
    runtimeStatus: null
  };
}

function cleanId(value, label) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 200) {
    throw new Error(`${label}无效`);
  }
  return value.trim();
}

function safeAppId(value) {
  return String(value ?? "local").trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "local";
}

function adminList(value) {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(items.map((item) => String(item).trim()).filter((item) => item && item.length <= 200))];
}

function hashCode(code) {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

function createCode() {
  return [...randomBytes(8)].map((value) => CODE_ALPHABET[value & 31]).join("");
}

function allows(mode, kind) {
  if (mode === "off") return false;
  if (mode === "all") return true;
  return mode === "failure" && FAILURE_KINDS.has(kind);
}

function hintUserId(userId) {
  if (userId.length <= 4) return "*".repeat(userId.length);
  return `${userId.slice(0, 3)}***${userId.slice(-2)}`;
}

function sanitizeRuntimeStatus(value, bootstrapToken) {
  const sensitiveKey = /(secret|token|password|authorization|credential)/i;
  const visit = (item, key = "") => {
    if (sensitiveKey.test(key)) return "[已隐藏]";
    if (typeof item === "string") {
      return bootstrapToken ? item.split(bootstrapToken).join("[已隐藏]") : item;
    }
    if (Array.isArray(item)) return item.map((entry) => visit(entry));
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).map(([childKey, child]) => [childKey, visit(child, childKey)]));
    }
    if (item === null || ["number", "boolean"].includes(typeof item)) return item;
    return null;
  };
  return visit(value);
}

async function readState(file) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw error;
  }
  if (!parsed || ![1, 2].includes(parsed.version) || typeof parsed !== "object") throw new Error("QQ 存储文件格式无效");
  const defaults = emptyState();
  return {
    ...defaults,
    ...parsed,
    version: 2,
    admins: Array.isArray(parsed.admins) ? parsed.admins : [],
    adminModes: parsed.adminModes && typeof parsed.adminModes === "object" && !Array.isArray(parsed.adminModes)
      ? parsed.adminModes
      : {},
    bindings: Object.fromEntries(Object.entries(parsed.bindings ?? {}).map(([accountId, value]) => {
      const entries = Array.isArray(value) ? value : [value];
      const seen = new Set();
      return [accountId, entries.map((binding) => {
        const userId = cleanId(binding?.userId, "QQ 用户");
        if (seen.has(userId)) throw new Error("QQ 绑定记录重复");
        seen.add(userId);
        return {
          ...binding, userId,
          mode: MODES.has(binding.mode) ? binding.mode : "all",
          bindingId: binding.bindingId || createHash("sha256").update(JSON.stringify([accountId, userId, binding.boundAt])).digest("hex").slice(0, 24)
        };
      })];
    })),
    bindingCodes: parsed.bindingCodes && typeof parsed.bindingCodes === "object" ? parsed.bindingCodes : {},
    bindingAttempts: parsed.bindingAttempts && typeof parsed.bindingAttempts === "object" ? parsed.bindingAttempts : {},
    bindingGuess: parsed.bindingGuess && typeof parsed.bindingGuess === "object" ? parsed.bindingGuess : defaults.bindingGuess,
    inbound: parsed.inbound && typeof parsed.inbound === "object" ? parsed.inbound : {},
    notificationIds: parsed.notificationIds && typeof parsed.notificationIds === "object" ? parsed.notificationIds : {},
    notifications: Array.isArray(parsed.notifications) ? parsed.notifications : [],
    notificationStats: parsed.notificationStats && typeof parsed.notificationStats === "object"
      ? { ...defaults.notificationStats, ...parsed.notificationStats }
      : defaults.notificationStats
  };
}

async function writeState(file, state) {
  await mkdir(dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(tempFile, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(tempFile, file);
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => {});
    throw error;
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function isNetworkError(error) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  if (status === 429) return true;
  if ([401, 403, 404].includes(status)) return false;
  if (error?.retryable === true) return true;
  if (error?.retryable === false) return false;
  if (error instanceof TypeError && /fetch|network/i.test(error.message)) return true;
  const code = String(error?.code ?? error?.cause?.code ?? "");
  return new Set([
    "ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT",
    "ECONNABORTED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET", "FETCH_ERROR"
  ]).has(code);
}

function failureLabel(error) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  if (status === 429 || isNetworkError(error)) return "网络发送失败";
  if ([401, 403, 404].includes(status)) return "发送权限或接收方拒绝";
  return "消息发送失败";
}

function trimTerminalHistory(state) {
  const terminal = state.notifications.filter((item) => ["sent", "failed", "cancelled"].includes(item.status));
  if (terminal.length <= TERMINAL_HISTORY_LIMIT) return;
  const keep = new Set(terminal.slice(-TERMINAL_HISTORY_LIMIT).map((item) => item.id));
  state.notifications = state.notifications.filter((item) => !["sent", "failed", "cancelled"].includes(item.status) || keep.has(item.id));
}

function pruneNotificationIds(state, now) {
  const unfinished = new Set(state.notifications
    .filter((item) => ["pending", "sending"].includes(item.status))
    .map((item) => item.eventId ?? item.id));
  for (const [id, timestamp] of Object.entries(state.notificationIds)) {
    if (!unfinished.has(id) && (!Number.isFinite(timestamp) || timestamp < now - NOTIFICATION_ID_RETENTION_MS)) {
      delete state.notificationIds[id];
    }
  }
}

export function createQqStore({
  directory = dataDirectory,
  appId = process.env.QQ_BOT_APP_ID || "local",
  bootstrapToken = process.env.QQ_BOT_BOOTSTRAP_TOKEN || "",
  adminOpenids = (process.env.QQ_BOT_ADMIN_OPENIDS || "").split(",")
} = {}) {
  const file = resolve(directory, `qq-${safeAppId(appId)}.json`);
  const configuredAdmins = adminList(adminOpenids);

  const transact = (callback) => withFileLock(file, async () => {
    const state = await readState(file);
    const result = await callback(state);
    await writeState(file, state);
    return result;
  });

  const read = (callback) => withFileLock(file, async () => callback(await readState(file)));

  function pruneAdminModes(state) {
    for (const [userId, enabled] of Object.entries(state.adminModes)) {
      if (!configuredAdmins.includes(userId) || enabled !== true) delete state.adminModes[userId];
    }
  }

  async function isAdmin(userId) {
    if (typeof userId !== "string" || !userId.trim()) return false;
    const cleanUserId = userId.trim();
    // Persisted `admins` values are legacy bootstrap data and never grant access.
    return configuredAdmins.includes(cleanUserId);
  }

  async function claimAdmin() {
    return false;
  }

  async function getAdminMode(userId) {
    const cleanUserId = cleanId(userId, "QQ 用户");
    return transact((state) => {
      pruneAdminModes(state);
      return configuredAdmins.includes(cleanUserId) && state.adminModes[cleanUserId] === true;
    });
  }

  async function setAdminMode(userId, enabled) {
    const cleanUserId = cleanId(userId, "QQ 用户");
    if (typeof enabled !== "boolean") throw new Error("管理员模式状态无效");
    return transact((state) => {
      pruneAdminModes(state);
      if (enabled) {
        if (!configuredAdmins.includes(cleanUserId)) return false;
        state.adminModes[cleanUserId] = true;
        return true;
      }
      delete state.adminModes[cleanUserId];
      return false;
    });
  }

  async function createBindingCode(accountId) {
    const cleanAccountId = cleanId(accountId, "学号");
    return transact((state) => {
      for (const [hash, entry] of Object.entries(state.bindingCodes)) {
        if (entry.accountId === cleanAccountId) delete state.bindingCodes[hash];
      }
      const now = Date.now();
      let code;
      let hash;
      do {
        code = createCode();
        hash = hashCode(code);
      } while (state.bindingCodes[hash]);
      const expiresAt = new Date(now + BINDING_CODE_TTL_MS).toISOString();
      state.bindingCodes[hash] = { accountId: cleanAccountId, createdAt: now, expiresAt };
      return { code, expiresAt };
    });
  }

  function addBinding(state, userId, accountId) {
    const entries = state.bindings[accountId] ?? [];
    if (entries.some((binding) => binding.userId === userId)) return;
    if (Object.entries(state.bindings).some(([otherId, bindings]) => otherId !== accountId
      && bindings.some((binding) => binding.userId === userId))) {
      throw new Error("该 QQ 已绑定其他学号，请先解绑");
    }
    state.bindings[accountId] = [...entries, {
      userId, mode: "all", boundAt: new Date().toISOString(), bindingId: randomBytes(12).toString("hex")
    }];
  }

  async function bind(userId, code) {
    const cleanUserId = cleanId(userId, "QQ 用户");
    const cleanCode = typeof code === "string" ? code.trim().toUpperCase() : "";
    const result = await transact((state) => {
      const now = Date.now();
      for (const [hash, entry] of Object.entries(state.bindingCodes)) {
        if (!Number.isFinite(Date.parse(entry.expiresAt)) || Date.parse(entry.expiresAt) <= now) delete state.bindingCodes[hash];
      }

      let attempt = state.bindingAttempts[cleanUserId];
      if (!attempt || now - attempt.windowStartedAt >= BINDING_GUESS_WINDOW_MS) {
        attempt = { windowStartedAt: now, count: 0, blockedUntil: 0 };
      }
      if (attempt.blockedUntil > now) return { error: "绑定尝试过多，请稍后再试" };

      let global = state.bindingGuess;
      if (!Number.isFinite(global.windowStartedAt) || now - global.windowStartedAt >= BINDING_GUESS_WINDOW_MS) {
        global = { windowStartedAt: now, count: 0 };
      }
      if (global.count >= MAX_GLOBAL_BINDING_GUESSES) {
        state.bindingGuess = global;
        return { error: "绑定请求过多，请稍后再试" };
      }

      const hash = /^[A-Z2-9]{8}$/.test(cleanCode) ? hashCode(cleanCode) : "";
      const entry = hash ? state.bindingCodes[hash] : null;
      if (!entry || Date.parse(entry.expiresAt) <= now) {
        attempt.count += 1;
        if (attempt.count >= MAX_BINDING_GUESSES) attempt.blockedUntil = now + BINDING_GUESS_WINDOW_MS;
        state.bindingAttempts[cleanUserId] = attempt;
        global.count += 1;
        state.bindingGuess = global;
        if (Object.keys(state.bindingAttempts).length > 10_000) {
          for (const [id, item] of Object.entries(state.bindingAttempts)) {
            if (now - item.windowStartedAt > BINDING_GUESS_WINDOW_MS * 2) delete state.bindingAttempts[id];
          }
        }
        return { error: attempt.blockedUntil > now ? "绑定尝试过多，请稍后再试" : "绑定码无效或已过期" };
      }

      addBinding(state, cleanUserId, entry.accountId);
      delete state.bindingCodes[hash];
      delete state.bindingAttempts[cleanUserId];
      return { accountId: entry.accountId };
    });
    if (result.error) throw new Error(result.error);
    return result;
  }

  async function bindVerified(userId, accountId) {
    const cleanUserId = cleanId(userId, "QQ 用户");
    const cleanAccountId = cleanId(accountId, "学号");
    return transact((state) => {
      addBinding(state, cleanUserId, cleanAccountId);
      return { accountId: cleanAccountId };
    });
  }

  async function getBindings(accountId) {
    const cleanAccountId = cleanId(accountId, "学号");
    return read((state) => (state.bindings[cleanAccountId] ?? []).map(({ userId, mode, bindingId }) => ({ userId, mode, bindingId })));
  }

  async function getBinding(accountId, userId) {
    const cleanAccountId = cleanId(accountId, "学号");
    const cleanUserId = userId === undefined ? undefined : cleanId(userId, "QQ 用户");
    return read((state) => {
      const entries = state.bindings[cleanAccountId] ?? [];
      const binding = cleanUserId === undefined ? (entries.length === 1 ? entries[0] : null)
        : entries.find((entry) => entry.userId === cleanUserId);
      return binding ? { userId: binding.userId, mode: MODES.has(binding.mode) ? binding.mode : "all" } : null;
    });
  }

  async function listBindings(userId) {
    const cleanUserId = cleanId(userId, "QQ 用户");
    return read((state) => Object.entries(state.bindings).flatMap(([accountId, bindings]) => bindings
      .filter((binding) => binding.userId === cleanUserId)
      .map((binding) => ({ accountId, userId: binding.userId, mode: binding.mode }))));
  }

  async function unbind(accountId, userId) {
    const cleanAccountId = cleanId(accountId, "学号");
    const cleanUserId = userId === undefined ? undefined : cleanId(userId, "QQ 用户");
    return transact((state) => {
      const entries = state.bindings[cleanAccountId] ?? [];
      const remaining = cleanUserId === undefined ? [] : entries.filter((binding) => binding.userId !== cleanUserId);
      const existed = remaining.length !== entries.length;
      if (remaining.length) state.bindings[cleanAccountId] = remaining;
      else delete state.bindings[cleanAccountId];
      if (cleanUserId === undefined) {
        for (const [hash, entry] of Object.entries(state.bindingCodes)) {
          if (entry.accountId === cleanAccountId) delete state.bindingCodes[hash];
        }
      }
      for (const item of state.notifications) {
        if (item.accountId === cleanAccountId && (cleanUserId === undefined || item.userId === cleanUserId)
          && ["pending", "sending"].includes(item.status)) item.status = "cancelled";
      }
      trimTerminalHistory(state);
      return existed;
    });
  }

  async function setPreference(accountId, mode, userId) {
    const cleanAccountId = cleanId(accountId, "学号");
    const cleanUserId = userId === undefined ? undefined : cleanId(userId, "QQ 用户");
    if (!MODES.has(mode)) throw new Error("通知偏好无效");
    return transact((state) => {
      const bindings = (state.bindings[cleanAccountId] ?? []).filter((entry) => cleanUserId === undefined || entry.userId === cleanUserId);
      if (!bindings.length) throw new Error("该学号尚未绑定此 QQ");
      for (const binding of bindings) binding.mode = mode;
      for (const item of state.notifications) {
        if (item.accountId === cleanAccountId && (cleanUserId === undefined || item.userId === cleanUserId)
          && ["pending", "sending"].includes(item.status) && !allows(mode, item.kind)) {
          item.status = "cancelled";
        }
      }
      trimTerminalHistory(state);
      return { accountId: cleanAccountId, mode };
    });
  }

  async function recordInbound(id) {
    const cleanEventId = cleanId(id, "消息编号");
    return transact((state) => {
      const now = Date.now();
      for (const [eventId, timestamp] of Object.entries(state.inbound)) {
        if (!Number.isFinite(timestamp) || timestamp < now - INBOUND_RETENTION_MS) delete state.inbound[eventId];
      }
      if (Object.hasOwn(state.inbound, cleanEventId)) return false;
      if (Object.keys(state.inbound).length >= MAX_INBOUND_IDS) return false;
      state.inbound[cleanEventId] = now;
      return true;
    });
  }

  async function enqueueNotification({ id, accountId, kind, content, expiresAt, userId } = {}) {
    const cleanEventId = cleanId(id, "事件编号");
    const cleanAccountId = cleanId(accountId, "学号");
    const cleanUserId = userId === undefined ? undefined : cleanId(userId, "QQ 用户");
    if (!KINDS.has(kind)) throw new Error("通知类型无效");
    if (typeof content !== "string" || !content.trim() || content.length > 10_000) throw new Error("通知内容无效");
    if (expiresAt !== undefined && !Number.isFinite(expiresAt)) throw new Error("通知有效期无效");
    return transact((state) => {
      const now = Date.now();
      if (expiresAt !== undefined && expiresAt <= now) return false;
      pruneNotificationIds(state, now);
      if (Object.hasOwn(state.notificationIds, cleanEventId)) return false;
      if (Object.keys(state.notificationIds).length >= MAX_NOTIFICATION_IDS) return false;
      state.notificationIds[cleanEventId] = now;
      const recipients = (state.bindings[cleanAccountId] ?? []).filter((binding) => allows(binding.mode, kind)
        && (cleanUserId === undefined || binding.userId === cleanUserId));
      if (!recipients.length) return false;
      if (state.notifications.filter((item) => ["pending", "sending"].includes(item.status)).length + recipients.length > MAX_PENDING_NOTIFICATIONS) return false;
      for (const binding of recipients) state.notifications.push({
        id: recipients.length === 1 ? cleanEventId : `delivery-${randomBytes(16).toString("hex")}`,
        eventId: cleanEventId,
        accountId: cleanAccountId,
        userId: binding.userId,
        kind,
        content,
        ...(expiresAt === undefined ? {} : { expiresAt }),
        status: "pending",
        attempts: 0,
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now
      });
      return true;
    });
  }

  async function finishAttempt(id, attemptToken, error = null) {
    return transact((state) => {
      const item = state.notifications.find((entry) => entry.id === id && entry.attemptToken === attemptToken && entry.status === "sending");
      if (!item) return null;
      const now = Date.now();
      delete item.attemptToken;
      delete item.leaseUntil;
      delete item.leasePid;
      item.updatedAt = now;
      if (!error) {
        item.status = "sent";
        item.sentAt = now;
        state.notificationStats.sent += 1;
        trimTerminalHistory(state);
        return "sent";
      }
      item.lastError = failureLabel(error);
      if (isNetworkError(error) && item.attempts < MAX_SEND_ATTEMPTS) {
        item.status = "pending";
        const backoffMs = Math.min(1000 * (2 ** (item.attempts - 1)), 16_000);
        const retryAfterMs = Number(error?.retryAfterMs);
        item.nextAttemptAt = now + Math.max(backoffMs, Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : 0);
        return "retried";
      }
      item.status = "failed";
      item.failedAt = now;
      state.notificationStats.failed += 1;
      trimTerminalHistory(state);
      return "failed";
    });
  }

  async function drainNotifications({ send, accountExists = async () => true, signal } = {}) {
    if (typeof send !== "function") throw new TypeError("send 必须是函数");
    if (typeof accountExists !== "function") throw new TypeError("accountExists 必须是函数");
    const counts = { sent: 0, failed: 0, skipped: 0, retried: 0, pending: 0 };
    const senderToken = randomBytes(16).toString("hex");
    const acquired = await transact((state) => {
      const lease = state.senderLease;
      // Never steal from a live process, even if a send has exceeded its
      // nominal lease. A dead process is recoverable as soon as its pid exits.
      if (lease && processIsAlive(lease.pid)) return false;
      state.senderLease = { token: senderToken, pid: process.pid, expiresAt: Date.now() + SENDER_LEASE_MS };
      return true;
    });
    if (!acquired) {
      counts.pending = await read((state) => state.notifications.filter((item) => ["pending", "sending"].includes(item.status)).length);
      return counts;
    }

    try {
      while (!signal?.aborted) {
        const reservation = await transact((state) => {
          const lease = state.senderLease;
          if (!lease || lease.token !== senderToken) return null;
          const now = Date.now();
          lease.expiresAt = now + SENDER_LEASE_MS;
          let exhausted = 0;
          for (const queued of state.notifications) {
            const expiredSend = queued.status === "sending"
              && (!Number.isFinite(queued.leaseUntil) || queued.leaseUntil <= now || !processIsAlive(queued.leasePid));
            const exhaustedPending = queued.status === "pending" && queued.attempts >= MAX_SEND_ATTEMPTS;
            if ((expiredSend || exhaustedPending) && queued.attempts >= MAX_SEND_ATTEMPTS) {
              queued.status = "failed";
              queued.failedAt = now;
              queued.updatedAt = now;
              queued.lastError = "发送进程中断次数过多";
              delete queued.attemptToken;
              delete queued.leaseUntil;
              state.notificationStats.failed += 1;
              exhausted += 1;
            }
          }
          if (exhausted) trimTerminalHistory(state);
          const item = state.notifications.find((entry) =>
            (entry.status === "pending" && entry.nextAttemptAt <= now)
            || (entry.status === "sending" && (!Number.isFinite(entry.leaseUntil) || entry.leaseUntil <= now || !processIsAlive(entry.leasePid))));
          if (!item) return { item: null, exhausted };
          item.status = "sending";
          item.attempts += 1;
          item.attemptToken = randomBytes(16).toString("hex");
          item.leasePid = process.pid;
          item.leaseUntil = now + SENDER_LEASE_MS;
          item.updatedAt = now;
          return { item: { ...item }, exhausted };
        });
        if (!reservation) break;
        counts.failed += reservation.exhausted;
        if (!reservation.item) break;
        const reservedItem = reservation.item;

        let exists;
        try {
          exists = await accountExists(reservedItem.accountId);
        } catch (error) {
          const result = await finishAttempt(reservedItem.id, reservedItem.attemptToken, error);
          if (result) counts[result] += 1;
          continue;
        }
        const binding = await getBinding(reservedItem.accountId, reservedItem.userId);
        if (!exists || !binding || binding.userId !== reservedItem.userId || !allows(binding.mode, reservedItem.kind)
          || (Number.isFinite(reservedItem.expiresAt) && reservedItem.expiresAt <= Date.now())) {
          await transact((state) => {
            const current = state.notifications.find((entry) => entry.id === reservedItem.id && entry.attemptToken === reservedItem.attemptToken);
            if (current && current.status === "sending") {
              current.status = "cancelled";
              current.updatedAt = Date.now();
              delete current.attemptToken;
              delete current.leaseUntil;
              delete current.leasePid;
              trimTerminalHistory(state);
            }
          });
          counts.skipped += 1;
          continue;
        }

        try {
          // Network I/O deliberately happens after all file-lock transactions
          // have ended. Delivery is at-least-once across process crashes.
          await send(reservedItem.userId, reservedItem.content, {
            accountId: reservedItem.accountId, kind: reservedItem.kind,
            ...(reservedItem.expiresAt === undefined ? {} : { expiresAt: reservedItem.expiresAt })
          });
          const result = await finishAttempt(reservedItem.id, reservedItem.attemptToken);
          if (result) counts[result] += 1;
        } catch (error) {
          const result = await finishAttempt(reservedItem.id, reservedItem.attemptToken, error);
          if (result) counts[result] += 1;
        }
      }
    } finally {
      await transact((state) => {
        if (state.senderLease?.token === senderToken) state.senderLease = null;
      });
    }
    counts.pending = await read((state) => state.notifications.filter((item) => ["pending", "sending"].includes(item.status)).length);
    return counts;
  }

  async function getSummary() {
    return read((state) => ({
      bindings: Object.entries(state.bindings).flatMap(([accountId, bindings]) => bindings.map((binding) => ({
        accountId,
        bindingId: binding.bindingId,
        bound: true,
        mode: MODES.has(binding.mode) ? binding.mode : "all",
        userHint: hintUserId(binding.userId)
      }))),
      pending: state.notifications.filter((item) => ["pending", "sending"].includes(item.status)).length,
      failed: state.notificationStats.failed,
      sent: state.notificationStats.sent
    }));
  }

  async function setRuntimeStatus(value) {
    const safeValue = sanitizeRuntimeStatus(value, bootstrapToken);
    return transact((state) => {
      state.runtimeStatus = safeValue;
      return safeValue;
    });
  }

  async function getRuntimeStatus() {
    return read((state) => state.runtimeStatus);
  }

  return {
    isAdmin,
    claimAdmin,
    getAdminMode,
    setAdminMode,
    createBindingCode,
    bind,
    bindVerified,
    getBinding,
    getBindings,
    listBindings,
    unbind,
    setPreference,
    recordInbound,
    enqueueNotification,
    drainNotifications,
    getSummary,
    setRuntimeStatus,
    getRuntimeStatus
  };
}
