import { effectiveSignMethodForGroup, groupCourses, normalizeCourseName, parseCourseTime, resolveCourseSignMethod, resolveCourseTiming, signWindow } from "../schedule.mjs";
import { signMethodLabel } from "../sign-url.mjs";
import { card, formatShanghaiTime } from "./format.mjs";

const WORKER_STATES = new Set(["待开始", "已签到", "未成功，已停止", "重试中", "准备中"]);
const CIRCLED_NUMBERS = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];

function courseBadge(index) {
  return CIRCLED_NUMBERS[index - 1] ?? `${index}.`;
}

function displayDate(date) {
  const raw = String(date ?? "");
  return /^\d{8}$/u.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : raw;
}

function text(value, fallback = "未提供") {
  const result = String(value ?? "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 120);
  return result || fallback;
}

function timingLabel(timing) {
  return timing?.mode === "random"
    ? `提前 ${timing.minMinutes}–${timing.maxMinutes} 分钟`
    : `提前 ${timing?.fixedMinutes ?? 10} 分钟`;
}

export function createCourseCards(courses, { account, date, workerStatus, now = Date.now() }) {
  const rows = new Map();
  const source = (Array.isArray(courses) ? courses : []).filter((course) => course && typeof course === "object");
  for (const course of source) {
    const name = text(course.courseName ?? course.name, "未命名课程");
    const identityName = String(course.courseName ?? course.name ?? "").trim();
    const start = parseCourseTime(course.classBeginTime ?? course.startTime, date);
    const end = parseCourseTime(course.classEndTime ?? course.endTime, date);
    // Mirror groupCourses' exact name grouping so each random seed describes
    // the same task the worker will execute.
    const key = JSON.stringify([identityName, start, end]);
    const row = rows.get(key) ?? { name, identityName, start, end, ids: new Set(), teachers: new Set(), rooms: new Set(), signed: false };
    row.ids.add(String(course.id ?? "").trim());
    row.signed ||= String(course.signStatus) === "1";
    const teacher = text(course.teacherName ?? course.teacher, "");
    const room = text(course.classroom ?? course.classRoom ?? course.classroomName ?? course.classRoomName ?? course.roomName, "");
    if (teacher) row.teachers.add(teacher);
    if (room) row.rooms.add(room);
    rows.set(key, row);
  }
  if (!rows.size) {
    return [card(`当天课表 · ${displayDate(date)}`, [
      { label: "学号", value: account.username },
      { label: "查询结果", value: "当天没有课程。" }
    ], { icon: "📅" })];
  }

  const groups = groupCourses(source, date);
  const skipped = new Set((account.courseWhitelist ?? []).map(normalizeCourseName));
  const updatedAt = Date.parse(workerStatus?.updatedAt ?? "");
  const fresh = Number.isFinite(updatedAt) && now - updatedAt >= -5_000 && now - updatedAt <= 90_000;
  const state = fresh && Array.isArray(workerStatus?.accounts)
    ? workerStatus.accounts.find((entry) => entry.id === account.id && entry.date === date && entry.enabled !== false)
    : null;
  const cards = [card(`当天课表 · ${displayDate(date)}`, [
    { label: "学号", value: account.username },
    { label: "课程数", value: `${rows.size} 门` }
  ], { icon: "📅" })];
  for (const row of [...rows.values()].sort((left, right) => (left.start ?? Infinity) - (right.start ?? Infinity))) {
    const group = groups.find((entry) => entry.start === row.start && entry.end === row.end
      && String(entry.first.courseName ?? "").trim() === row.identityName);
    const timing = resolveCourseTiming(account.timing, account.courseTimingOverrides, row.name);
    const preferredMethod = resolveCourseSignMethod(account.signMethod, account.courseSignMethodOverrides, row.name);
    const effectiveMethod = group ? effectiveSignMethodForGroup(group, preferredMethod) : preferredMethod;
    const methodText = group && effectiveMethod !== preferredMethod
      ? `${signMethodLabel(preferredMethod)}（缺少对应编号，回退${signMethodLabel(effectiveMethod)}）`
      : signMethodLabel(preferredMethod);
    const window = group ? signWindow(group, timing, account.id) : null;
    const plan = Array.isArray(state?.plan) ? state.plan.find((entry) => entry.start === row.start && entry.end === row.end
      && String(entry.courseName ?? "").trim() === row.identityName
      && (Array.isArray(entry.courseIds) ? entry.courseIds : [entry.courseId]).some((id) => row.ids.has(String(id)))) : null;
    let status;
    let attempt;
    if (skipped.has(normalizeCourseName(row.name)) || !account.enabled) {
      attempt = "停止打卡";
      status = skipped.has(normalizeCourseName(row.name)) ? "停止打卡（单课已停用）" : "停止打卡（总开关已关闭）";
    } else if (row.signed) {
      attempt = window ? `${formatShanghaiTime(window.attemptAt, { date: false })}（${timingLabel(timing)}）` : "已完成";
      status = "已签到（课表已确认）";
    } else if (!window) {
      attempt = `暂无法安排（${timingLabel(timing)}）`;
      status = "课程编号或时间不完整，无法生成计划";
    } else {
      attempt = `${formatShanghaiTime(window.attemptAt, { date: false })}（${timingLabel(timing)}）`;
      status = WORKER_STATES.has(plan?.state) ? plan.state : "等待后台更新";
    }
    cards.push(card(row.name, [
      { label: "教师", value: [...row.teachers].join(" / ") || "未提供" },
      { label: "时间", value: row.start !== null && row.end !== null
        ? `${formatShanghaiTime(row.start)}–${formatShanghaiTime(row.end, { date: false })}` : "未提供有效时间" },
      { label: "教室", value: [...row.rooms].join(" / ") || "未提供" },
      { label: "计划", value: attempt },
      { label: "方式", value: methodText },
      { label: "状态", value: status }
    ], { icon: courseBadge(cards.length) }));
  }
  return cards;
}
