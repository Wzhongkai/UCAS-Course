import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { normalizeCourseName, normalizeCourseWhitelist } from "../schedule.mjs";
import { withFileLock } from "./file-lock.mjs";

// Runtime-only persistent storage; it must not be bundled into Next's server output.
export const dataDirectory = resolve(/*turbopackIgnore: true*/ process.env.AUTO_SIGN_DATA_DIR || "data");
const settingsFile = resolve(dataDirectory, "automation.json");
const statusFile = resolve(dataDirectory, "status.json");
const eventsFile = resolve(dataDirectory, "events.json");
const DEFAULT_SIGN_TIMING = Object.freeze({
  mode: "fixed",
  fixedMinutes: 10,
  minMinutes: 10,
  maxMinutes: 20
});

export function encryptionReady() {
  return /^[a-f\d]{64}$/i.test(process.env.AUTO_SIGN_SECRET ?? "");
}

function secretKey() {
  if (!encryptionReady()) throw new Error("AUTO_SIGN_SECRET 必须是 64 位十六进制字符串");
  return Buffer.from(process.env.AUTO_SIGN_SECRET, "hex");
}

function encryptCredentials(username, password) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ username, password }), "utf8"),
    cipher.final()
  ]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
}

function decryptCredentials(value) {
  if (!value) return null;
  const decipher = createDecipheriv("aes-256-gcm", secretKey(), Buffer.from(value.iv, "base64"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, "base64")),
    decipher.final()
  ]).toString("utf8");
  const parsed = JSON.parse(plaintext);
  if (typeof parsed.username !== "string" || typeof parsed.password !== "string") {
    throw new Error("自动签到凭据格式错误");
  }
  return parsed;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(file, value) {
  await mkdir(dataDirectory, { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(temp, file);
}

export async function readAutomationSettings() {
  const raw = await readRawSettings();
  return {
    version: 3,
    updatedAt: raw.updatedAt,
    accounts: raw.accounts.map((account) => ({
      ...account,
      credentials: decryptCredentials(account.credentials)
    }))
  };
}

async function readRawSettings() {
  const raw = await readJson(settingsFile, { version: 3, accounts: [], updatedAt: null });
  if ((raw.version === 2 || raw.version === 3) && Array.isArray(raw.accounts)) {
    return {
      version: 3,
      updatedAt: raw.updatedAt,
      accounts: raw.accounts.map((account) => ({
        ...account,
        timing: normalizeSignTiming(account.timing),
        courseWhitelist: normalizeCourseWhitelist(account.courseWhitelist),
        courseTimingOverrides: normalizeCourseTimingOverrides(account.courseTimingOverrides)
      }))
    };
  }
  if (raw.version === 1) {
    return {
      version: 3,
      updatedAt: raw.updatedAt,
      accounts: raw.credentials ? [{
        id: "legacy",
        enabled: Boolean(raw.enabled),
        credentials: raw.credentials,
        timing: { ...DEFAULT_SIGN_TIMING },
        courseWhitelist: [],
        courseTimingOverrides: {},
        updatedAt: raw.updatedAt,
        refreshRequestedAt: raw.refreshRequestedAt
      }] : []
    };
  }
  throw new Error("自动签到配置格式无效");
}

export function normalizeSignTiming(value, strict = false) {
  const inRange = (number) => Number.isInteger(number) && number >= 1 && number <= 120;
  if (value?.mode === "fixed") {
    const fixedMinutes = Number(value.fixedMinutes);
    if (inRange(fixedMinutes)) {
      return { ...DEFAULT_SIGN_TIMING, mode: "fixed", fixedMinutes };
    }
  }
  if (value?.mode === "random") {
    const minMinutes = Number(value.minMinutes);
    const maxMinutes = Number(value.maxMinutes);
    if (inRange(minMinutes) && inRange(maxMinutes) && minMinutes <= maxMinutes) {
      return { ...DEFAULT_SIGN_TIMING, mode: "random", minMinutes, maxMinutes };
    }
  }
  if (strict) throw new Error("签到时间配置无效，请填写 1 到 120 分钟的有效范围");
  return { ...DEFAULT_SIGN_TIMING };
}

function normalizeCourseTimingOverrides(value, strict = false) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (strict) throw new Error("课程签到时间配置无效");
    return {};
  }
  const entries = Object.entries(value);
  if (strict && entries.length > 100) throw new Error("每个账号最多设置 100 门课程的签到时间");

  const result = {};
  const seen = new Set();
  for (const [rawName, rawTiming] of entries) {
    const courseName = normalizeCourseWhitelist([rawName])[0];
    if (!courseName || courseName.length > 120) {
      if (strict) throw new Error("课程名称无效或超过 120 个字符");
      continue;
    }
    const key = normalizeCourseName(courseName);
    if (seen.has(key)) continue;
    try {
      Object.defineProperty(result, courseName, {
        value: normalizeSignTiming(rawTiming, true), enumerable: true, configurable: true, writable: true
      });
      seen.add(key);
    } catch {
      if (strict) throw new Error("课程签到时间配置无效");
    }
  }
  return result;
}

function validateCredentials(username, password) {
  if (typeof username !== "string" || typeof password !== "string" || !username.trim() || !password) {
    throw new Error("请同时填写学号和密码");
  }
  if (username.trim().length > 40 || password.length > 80 || /\s/.test(username.trim())) {
    throw new Error("学号或密码格式错误");
  }
  return username.trim();
}

export async function updateAutomationSettings(options) {
  return withFileLock(settingsFile, () => mutateAutomationSettings(options));
}

async function mutateAutomationSettings({ action, accountId, username, password, enabled, timing, courseWhitelist, courseName, resetCourseTimingOverrides }) {
  const current = await readRawSettings();
  const accounts = current.accounts.map((account) => ({ ...account }));
  const index = accounts.findIndex((account) => account.id === accountId);
  const now = new Date().toISOString();

  if (action === "add") {
    const cleanUsername = validateCredentials(username, password);
    if (enabled !== undefined && typeof enabled !== "boolean") throw new Error("账号开关状态无效");
    if (accounts.length >= 20) throw new Error("最多保存 20 个账号");
    if (accounts.some((account) => decryptCredentials(account.credentials)?.username === cleanUsername)) {
      throw new Error("该学号已添加");
    }
    accounts.push({
      id: randomBytes(12).toString("hex"),
      enabled: enabled ?? true,
      credentials: encryptCredentials(cleanUsername, password),
      timing: { ...DEFAULT_SIGN_TIMING },
      courseWhitelist: [],
      courseTimingOverrides: {},
      updatedAt: now,
      refreshRequestedAt: null
    });
  } else if (action === "remove") {
    if (index < 0) throw new Error("账号不存在");
    accounts.splice(index, 1);
  } else if (action === "toggle") {
    if (index < 0 || typeof enabled !== "boolean") throw new Error("账号或开关状态无效");
    accounts[index].enabled = enabled;
    accounts[index].updatedAt = now;
  } else if (action === "password") {
    if (index < 0 || typeof password !== "string" || !password || password.length > 80) throw new Error("账号或新密码无效");
    const old = decryptCredentials(accounts[index].credentials);
    accounts[index].credentials = encryptCredentials(old.username, password);
    accounts[index].updatedAt = now;
  } else if (action === "refresh") {
    if (index < 0) throw new Error("账号不存在");
    if (!accounts[index].enabled) throw new Error("请先启用该账号");
    accounts[index].refreshRequestedAt = now;
  } else if (action === "timing") {
    if (index < 0) throw new Error("账号不存在");
    accounts[index].timing = normalizeSignTiming(timing, true);
    if (resetCourseTimingOverrides === true) accounts[index].courseTimingOverrides = {};
    accounts[index].updatedAt = now;
  } else if (action === "course-timing" || action === "course-timing-clear") {
    if (index < 0) throw new Error("账号不存在");
    const normalizedName = typeof courseName === "string" ? normalizeCourseWhitelist([courseName])[0] : "";
    if (!normalizedName || normalizedName.length > 120) throw new Error("课程名称无效或超过 120 个字符");
    const overrides = normalizeCourseTimingOverrides(accounts[index].courseTimingOverrides);
    const normalizedKey = normalizeCourseName(normalizedName);
    for (const existingName of Object.keys(overrides)) {
      if (normalizeCourseName(existingName) === normalizedKey) delete overrides[existingName];
    }
    if (action === "course-timing-clear" || timing === null) {
      delete overrides[normalizedName];
    } else {
      Object.defineProperty(overrides, normalizedName, {
        value: normalizeSignTiming(timing, true), enumerable: true, configurable: true, writable: true
      });
    }
    accounts[index].courseTimingOverrides = normalizeCourseTimingOverrides(overrides, true);
    accounts[index].updatedAt = now;
  } else if (action === "whitelist") {
    if (index < 0) throw new Error("账号不存在");
    if (!Array.isArray(courseWhitelist)) throw new Error("课程白名单格式无效");
    if (courseWhitelist.length > 100) throw new Error("课程白名单最多保存 100 门课");
    if (courseWhitelist.some((item) => typeof item !== "string")) throw new Error("课程白名单必须由课程名文本组成");
    const normalized = normalizeCourseWhitelist(courseWhitelist);
    if (normalized.some((item) => item.length > 120)) throw new Error("课程名称不能超过 120 个字符");
    accounts[index].courseWhitelist = normalized;
    accounts[index].updatedAt = now;
  } else {
    throw new Error("未知操作");
  }

  const next = { version: 3, accounts, updatedAt: now };
  await writeJson(settingsFile, next);
  return next;
}

export async function readPublicSettings() {
  const settings = await readAutomationSettings();
  return {
    accounts: settings.accounts.map((account) => {
      const username = account.credentials.username;
      return {
        id: account.id,
        enabled: account.enabled,
        timing: normalizeSignTiming(account.timing),
        courseWhitelist: normalizeCourseWhitelist(account.courseWhitelist),
        courseTimingOverrides: normalizeCourseTimingOverrides(account.courseTimingOverrides),
        username,
        usernameHint: `${username.slice(0, 3)}***${username.slice(-3)}`
      };
    }),
    updatedAt: settings.updatedAt
  };
}

export async function readWorkerStatus() {
  return readJson(statusFile, null);
}

export async function writeWorkerStatus(status) {
  await writeJson(statusFile, status);
}

export async function readWorkerEvents() {
  const events = await readJson(eventsFile, []);
  return Array.isArray(events) ? events.slice(-100) : [];
}

export async function writeWorkerEvents(events) {
  await writeJson(eventsFile, events.slice(-100));
}
