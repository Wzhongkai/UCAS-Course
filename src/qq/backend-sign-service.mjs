import { completionKeyFor, readAutomationSettings, recordCompletedKeys } from "../automation/store.mjs";
import {
  groupCourses,
  normalizeCourseName,
  normalizeCourseWhitelist,
  resolveCourseSignMethod,
  shanghaiDate,
  signTargetsForMethod
} from "../schedule.mjs";
import { normalizeSignMethod } from "../sign-url.mjs";
import { UcasClient } from "../ucas.mjs";
import { createScheduleRateLimiter, normalizeScheduleDate } from "./backend-schedule-service.mjs";

const SIGN_TIMESTAMP_BUFFER_MS = 3_000;
const SIGN_PREPARE_BEFORE_MS = 30 * 60_000;

export class BackendSignError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "BackendSignError";
    this.status = status;
  }
}

function cleanReason(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 120);
}

function isGroupSigned(group) {
  return group.courses.some((course) => String(course.signStatus) === "1");
}

function chooseTargetGroup(groups, currentTime) {
  const unsigned = groups.filter((group) => !isGroupSigned(group));
  if (unsigned.length === 0) return { group: groups[0], alreadySigned: true };

  const active = unsigned.find((group) => currentTime >= group.start - SIGN_PREPARE_BEFORE_MS && currentTime <= group.end);
  if (active) return { group: active, alreadySigned: false };

  const upcoming = unsigned.find((group) => group.end >= currentTime);
  if (upcoming) return { group: upcoming, alreadySigned: false };

  return { group: unsigned.at(-1), alreadySigned: false };
}

async function resolveSignTimestamp(client, now) {
  try {
    const startedAt = now();
    const serverTimestamp = await client.serverTimestamp();
    const finishedAt = now();
    const offset = serverTimestamp + Math.floor((finishedAt - startedAt) / 2) - finishedAt;
    return finishedAt + offset - SIGN_TIMESTAMP_BUFFER_MS;
  } catch {
    return now() - SIGN_TIMESTAMP_BUFFER_MS;
  }
}

export function createBackendSignService({
  readSettings = readAutomationSettings,
  createClient = (credentials) => new UcasClient(credentials),
  rateLimiter = createScheduleRateLimiter(),
  markCompleted = (key, cutoffDate) => recordCompletedKeys([key], cutoffDate),
  now = Date.now
} = {}) {
  async function persistCompletion(accountId, groupKey) {
    try {
      const cutoff = shanghaiDate(now() - 14 * 24 * 60 * 60_000);
      await markCompleted(completionKeyFor(accountId, groupKey), cutoff);
    } catch {
      // Do not fail a confirmed sign-in if the completion cache cannot be written.
    }
  }

  return async function signCourseNow({ accountId, courseName, signMethod, date } = {}) {
    if (typeof accountId !== "string" || !accountId.trim() || accountId.trim().length > 200) {
      throw new BackendSignError(400, "账号无效");
    }
    const cleanAccountId = accountId.trim();

    const cleanCourseName = typeof courseName === "string" ? normalizeCourseWhitelist([courseName])[0] : "";
    if (!cleanCourseName || cleanCourseName.length > 120) {
      throw new BackendSignError(400, "课程名称无效或超过 120 个字符");
    }

    let explicitMethod;
    if (signMethod !== undefined && signMethod !== null && signMethod !== "") {
      try {
        explicitMethod = normalizeSignMethod(signMethod, true);
      } catch {
        throw new BackendSignError(400, "签到方式无效");
      }
    }

    let normalizedDate;
    try {
      normalizedDate = date === undefined ? shanghaiDate(now()) : normalizeScheduleDate(date);
    } catch {
      throw new BackendSignError(400, "日期无效");
    }

    const settings = await readSettings();
    const account = settings.accounts.find((entry) => entry.id === cleanAccountId);
    if (!account) throw new BackendSignError(404, "账号不存在");
    if (!account.credentials || typeof account.credentials.username !== "string" || typeof account.credentials.password !== "string") {
      throw new BackendSignError(503, "账号凭据暂不可用");
    }
    if (!rateLimiter.consume(cleanAccountId)) throw new BackendSignError(429, "签到请求太频繁，请稍后再试");

    const client = createClient(account.credentials);
    await client.login();
    const rawCourses = await client.schedule(normalizedDate);
    if (!Array.isArray(rawCourses)) throw new Error("Invalid schedule response");

    const groups = groupCourses(rawCourses, normalizedDate);
    const targetKey = normalizeCourseName(cleanCourseName);
    const matched = groups.filter((group) => normalizeCourseName(group.first.courseName) === targetKey);
    if (matched.length === 0) {
      return { status: "not_found", date: normalizedDate, courseName: cleanCourseName };
    }

    const { group, alreadySigned } = chooseTargetGroup(matched, now());
    const resolvedName = String(group.first.courseName ?? "").trim() || cleanCourseName;
    if (alreadySigned) {
      await persistCompletion(account.id, group.key);
      return { status: "already_signed", date: normalizedDate, courseName: resolvedName };
    }

    const preferredMethod = explicitMethod ?? resolveCourseSignMethod(
      account.signMethod,
      account.courseSignMethodOverrides,
      resolvedName
    );
    const targets = signTargetsForMethod(group, preferredMethod);
    if (targets.length === 0) {
      return {
        status: "failed",
        date: normalizedDate,
        courseName: resolvedName,
        signParameter: preferredMethod,
        reason: "课程缺少有效签到编号"
      };
    }

    const timestamp = await resolveSignTimestamp(client, now);
    let lastSignParameter = preferredMethod;
    let lastReason = "";

    for (const target of targets) {
      const { data: result, signParameter } = await client.sign(
        { uuid: target.uuid, courseSchedId: target.legacyId, method: preferredMethod },
        timestamp
      );
      lastSignParameter = signParameter;
      if (result?.STATUS === "0" && result?.result?.stuSignStatus === "1") {
        await persistCompletion(account.id, group.key);
        return {
          status: "signed",
          date: normalizedDate,
          courseName: resolvedName,
          signParameter,
          stuSignId: result?.result?.stuSignId ? String(result.result.stuSignId) : ""
        };
      }
      lastReason = cleanReason(result?.result?.msg ?? result?.ERRMSG ?? result?.msg ?? result?.message ?? "");
    }

    return {
      status: "failed",
      date: normalizedDate,
      courseName: resolvedName,
      signParameter: lastSignParameter,
      reason: lastReason || "上游未确认成功"
    };
  };
}
