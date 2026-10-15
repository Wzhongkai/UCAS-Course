import { readAutomationSettings } from "../automation/store.mjs";
import { UcasClient } from "../ucas.mjs";

export class BackendScheduleError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "BackendScheduleError";
    this.status = status;
  }
}

export function normalizeScheduleDate(value) {
  if (typeof value !== "string") throw new BackendScheduleError(400, "日期格式无效");
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value)
    ?? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new BackendScheduleError(400, "日期格式无效");

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) {
    throw new BackendScheduleError(400, "日期无效");
  }
  return `${match[1]}${match[2]}${match[3]}`;
}

export function createScheduleRateLimiter({
  accountLimit = 10,
  accountWindowMs = 5 * 60_000,
  globalLimit = 100,
  globalWindowMs = 60_000,
  maxAccountBuckets = 256,
  now = Date.now
} = {}) {
  const accountRequests = new Map();
  let globalRequests = [];

  function consume(accountId) {
    const current = now();
    globalRequests = globalRequests.filter((timestamp) => timestamp > current - globalWindowMs);
    for (const [key, entry] of accountRequests) {
      if (entry.lastSeenAt <= current - accountWindowMs) accountRequests.delete(key);
      else entry.requests = entry.requests.filter((timestamp) => timestamp > current - accountWindowMs);
    }

    let entry = accountRequests.get(accountId);
    if (!entry) {
      if (accountRequests.size >= maxAccountBuckets) {
        let oldestKey;
        let oldestAt = Infinity;
        for (const [key, candidate] of accountRequests) {
          if (candidate.lastSeenAt < oldestAt) {
            oldestAt = candidate.lastSeenAt;
            oldestKey = key;
          }
        }
        if (oldestKey !== undefined) accountRequests.delete(oldestKey);
      }
      entry = { requests: [], lastSeenAt: current };
      accountRequests.set(accountId, entry);
    }
    entry.lastSeenAt = current;

    if (entry.requests.length >= accountLimit || globalRequests.length >= globalLimit) return false;
    entry.requests.push(current);
    globalRequests.push(current);
    return true;
  }

  return {
    consume,
    get accountBucketCount() { return accountRequests.size; }
  };
}

function safeCourseField(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return "";
}

function sanitizeCourse(course) {
  if (!course || typeof course !== "object" || Array.isArray(course)) return null;
  return {
    id: safeCourseField(course.id),
    uuid: safeCourseField(course.uuid),
    courseName: safeCourseField(course.courseName),
    teacherName: safeCourseField(course.teacherName),
    weekDay: safeCourseField(course.weekDay),
    classBeginTime: safeCourseField(course.classBeginTime),
    classEndTime: safeCourseField(course.classEndTime),
    signStatus: safeCourseField(course.signStatus),
    classroom: safeCourseField(course.classroom ?? course.classRoom ?? course.classroomName ?? course.classRoomName ?? course.roomName)
  };
}

export function createBackendScheduleService({
  readSettings = readAutomationSettings,
  createClient = (credentials) => new UcasClient(credentials),
  rateLimiter = createScheduleRateLimiter()
} = {}) {
  return async function querySchedule({ accountId, date } = {}) {
    const normalizedDate = normalizeScheduleDate(date);
    if (typeof accountId !== "string" || !accountId.trim() || accountId.trim().length > 200) {
      throw new BackendScheduleError(400, "账号无效");
    }
    const cleanAccountId = accountId.trim();

    const settings = await readSettings();
    const account = settings.accounts.find((entry) => entry.id === cleanAccountId);
    if (!account) throw new BackendScheduleError(404, "账号不存在");
    if (!account.credentials || typeof account.credentials.username !== "string" || typeof account.credentials.password !== "string") {
      throw new BackendScheduleError(503, "账号凭据暂不可用");
    }
    if (!rateLimiter.consume(cleanAccountId)) throw new BackendScheduleError(429, "查询太频繁，请稍后再试");

    const client = createClient(account.credentials);
    await client.login();
    const result = await client.schedule(normalizedDate);
    if (!Array.isArray(result)) throw new Error("Invalid schedule response");
    const courses = result.map(sanitizeCourse).filter(Boolean);
    return { date: normalizedDate, total: courses.length, courses };
  };
}
