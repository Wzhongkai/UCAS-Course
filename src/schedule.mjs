import { DEFAULT_SIGN_METHOD, normalizeCourseSchedId, normalizeCourseUuid, normalizeSignMethod, selectSignIdentifier } from "./sign-url.mjs";

const SHANGHAI_OFFSET = "+08:00";

export function shanghaiDate(timestamp = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(timestamp);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}${values.month}${values.day}`;
}

export function timeAtSix(date) {
  return Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T06:00:00+08:00`);
}

export function parseCourseTime(value, date) {
  const match = String(value ?? "").match(/(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match || !/^\d{8}$/.test(date)) return null;
  const [, hourText, minuteText, secondText = "00"] = match;
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const isoDate = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  const parsed = Date.parse(`${isoDate}T${hourText}:${minuteText}:${secondText}${SHANGHAI_OFFSET}`);
  return Number.isFinite(parsed) ? parsed : null;
}

function courseName(course) {
  return String(course.courseName ?? "").trim();
}

export function normalizeCourseName(value) {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("zh-CN");
}

export function resolveCourseTiming(defaultTiming, overrides, courseName) {
  const normalizedName = normalizeCourseName(courseName);
  if (!normalizedName || !overrides || typeof overrides !== "object" || Array.isArray(overrides)) return defaultTiming;

  for (const [name, timing] of Object.entries(overrides)) {
    if (normalizeCourseName(name) !== normalizedName) continue;
    if (timing?.mode === "fixed" && Number.isInteger(timing.fixedMinutes) && timing.fixedMinutes >= 1 && timing.fixedMinutes <= 30) {
      return timing;
    }
    if (timing?.mode === "random" && Number.isInteger(timing.minMinutes) && Number.isInteger(timing.maxMinutes)
      && timing.minMinutes >= 1 && timing.maxMinutes <= 30 && timing.minMinutes <= timing.maxMinutes) {
      return timing;
    }
    return defaultTiming;
  }

  return defaultTiming;
}

export function resolveCourseSignMethod(defaultMethod, overrides, courseName) {
  const fallback = normalizeSignMethod(defaultMethod);
  const normalizedName = normalizeCourseName(courseName);
  if (!normalizedName || !overrides || typeof overrides !== "object" || Array.isArray(overrides)) return fallback;

  for (const [name, method] of Object.entries(overrides)) {
    if (normalizeCourseName(name) !== normalizedName) continue;
    if (method === "timeTableId" || method === "courseSchedId") return method;
    return fallback;
  }

  return fallback;
}

export function normalizeCourseWhitelist(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const item of value) {
    const display = String(item ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ");
    const key = normalizeCourseName(display);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(display);
  }
  return result;
}

export function filterCoursesByWhitelist(courses, whitelist) {
  const allowed = new Set(normalizeCourseWhitelist(whitelist).map(normalizeCourseName));
  if (allowed.size === 0) return Array.isArray(courses) ? courses : [];
  return (Array.isArray(courses) ? courses : []).filter((course) => !allowed.has(normalizeCourseName(course?.courseName)));
}

function sameTimedCourse(left, right) {
  return courseName(left.alternatives[0]) !== "" &&
    courseName(left.alternatives[0]) === courseName(right) &&
    left.start === right.start && left.end === right.end;
}

export function groupCourses(courses, date) {
  const seen = new Set();
  const valid = [];

  for (const course of Array.isArray(courses) ? courses : []) {
    if (!course || typeof course !== "object") continue;
    const id = String(course.id ?? "").trim();
    const uuid = normalizeCourseUuid(course.uuid);
    const legacyId = normalizeCourseSchedId(id);
    const start = parseCourseTime(course.classBeginTime, date);
    const end = parseCourseTime(course.classEndTime, date);
    if ((!legacyId && !uuid) || start === null || end === null || end <= start) continue;
    const duplicateKey = `${legacyId ?? ""}:${uuid ?? ""}:${start}:${end}`;
    if (seen.has(duplicateKey)) continue;
    seen.add(duplicateKey);
    valid.push({ ...course, id, uuid, legacyId, start, end });
  }

  valid.sort((a, b) => a.start - b.start || a.end - b.end || courseName(a).localeCompare(courseName(b), "zh-CN")
    || Number(!a.legacyId) - Number(!b.legacyId) || (a.legacyId || a.uuid).localeCompare(b.legacyId || b.uuid));

  const slots = [];
  for (const course of valid) {
    const slot = slots.at(-1);
    if (slot && sameTimedCourse(slot, course)) {
      slot.alternatives.push(course);
    } else {
      slots.push({ start: course.start, end: course.end, alternatives: [course] });
    }
  }

  return slots.map((slot) => {
    const first = slot.alternatives[0];
    const uuidTargets = new Map();
    const numericTargets = new Map();
    for (const course of slot.alternatives) {
      if (course.uuid && !uuidTargets.has(course.uuid)) uuidTargets.set(course.uuid, course);
      if (course.legacyId && !numericTargets.has(course.legacyId)) numericTargets.set(course.legacyId, course);
    }
    return {
      // Existing completion records and randomized times still use the old slot key.
      key: `${date}:${first.legacyId || first.uuid}:${slot.start}`,
      first,
      uuidTargets: [...uuidTargets.values()],
      numericTargets: [...numericTargets.values()],
      signTargets: [...(uuidTargets.size ? uuidTargets : numericTargets).values()],
      start: slot.start,
      firstEnd: slot.end,
      end: slot.end,
      slots: [slot],
      courses: [...slot.alternatives],
      sessionCount: 1
    };
  });
}

export function scheduleOutcome(courses, date) {
  const items = Array.isArray(courses) ? courses : [];
  return {
    state: items.length === 0 ? "no_courses" : "ready",
    groups: groupCourses(items, date)
  };
}

function stableFraction(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0x100000000;
}

function advanceMilliseconds(timing, seed) {
  if (timing?.mode === "random") {
    const min = Number(timing.minMinutes);
    const max = Number(timing.maxMinutes);
    if (Number.isFinite(min) && Number.isFinite(max) && min >= 1 && max >= min) {
      const minMs = min * 60_000;
      const rangeMs = (max - min) * 60_000;
      return minMs + Math.floor(stableFraction(seed) * (rangeMs + 1));
    }
  }
  const fixed = Number(timing?.fixedMinutes);
  return (Number.isFinite(fixed) && fixed >= 1 ? fixed : 10) * 60_000;
}

export function signWindow(group, timing, accountSeed = "") {
  const attemptAt = group.start - advanceMilliseconds(timing, `${accountSeed}:${group.key}`);
  return {
    prepareAt: Math.min(group.start - 30 * 60_000, attemptAt),
    attemptAt,
    stopAt: group.firstEnd
  };
}

export function signTargetsForMethod(group, preferredMethod = DEFAULT_SIGN_METHOD) {
  const method = normalizeSignMethod(preferredMethod);
  const uuidTargets = Array.isArray(group?.uuidTargets) ? group.uuidTargets : null;
  const numericTargets = Array.isArray(group?.numericTargets) ? group.numericTargets : null;
  if (!uuidTargets && !numericTargets) return group?.signTargets ?? [];
  const uuids = uuidTargets ?? [];
  const numerics = numericTargets ?? [];
  if (method === "courseSchedId") return numerics.length ? numerics : uuids;
  return uuids.length ? uuids : numerics;
}

export function effectiveSignMethodForGroup(group, preferredMethod = DEFAULT_SIGN_METHOD) {
  const method = normalizeSignMethod(preferredMethod);
  const targets = signTargetsForMethod(group, method);
  const firstTarget = targets[0];
  if (!firstTarget) return method;
  return selectSignIdentifier(firstTarget.uuid, firstTarget.legacyId ?? firstTarget.id, method)?.name ?? method;
}

export function signTargetForAttempt(group, attemptNumber, preferredMethod = DEFAULT_SIGN_METHOD) {
  const targets = signTargetsForMethod(group, preferredMethod);
  if (targets.length === 0) return null;
  const index = Math.max(0, Number(attemptNumber) - 1) % targets.length;
  return targets[index];
}
