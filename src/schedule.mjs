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

function sameTimedCourse(left, right) {
  return courseName(left.alternatives[0]) !== "" &&
    courseName(left.alternatives[0]) === courseName(right) &&
    left.start === right.start && left.end === right.end;
}

export function groupCourses(courses, date) {
  const seen = new Set();
  const valid = [];

  for (const course of Array.isArray(courses) ? courses : []) {
    const id = String(course.id ?? "").trim();
    const start = parseCourseTime(course.classBeginTime, date);
    const end = parseCourseTime(course.classEndTime, date);
    if (!/^\d{7}$/.test(id) || start === null || end === null || end <= start) continue;
    const duplicateKey = `${id}:${start}:${end}`;
    if (seen.has(duplicateKey)) continue;
    seen.add(duplicateKey);
    valid.push({ ...course, id, start, end });
  }

  valid.sort((a, b) => a.start - b.start || a.end - b.end || courseName(a).localeCompare(courseName(b), "zh-CN") || a.id.localeCompare(b.id));

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
    return {
      key: `${date}:${first.id}:${slot.start}`,
      first,
      signTargets: [...slot.alternatives],
      start: slot.start,
      firstEnd: slot.end,
      end: slot.end,
      slots: [slot],
      courses: [...slot.alternatives],
      sessionCount: 1
    };
  });
}

export function signWindow(group) {
  return {
    prepareAt: group.start - 30 * 60_000,
    attemptAt: group.start - 10 * 60_000,
    stopAt: group.firstEnd
  };
}

export function signTargetForAttempt(group, attemptNumber) {
  const targets = Array.isArray(group?.signTargets) && group.signTargets.length > 0
    ? group.signTargets
    : group?.first ? [group.first] : [];
  if (targets.length === 0) return null;
  const index = Math.max(0, Number(attemptNumber) - 1) % targets.length;
  return targets[index];
}
