import { card, formatShanghaiTime } from "./format.mjs";

function cleanLabel(value, fallback) {
  const clean = String(value ?? "").trim().replace(/\s+/gu, " ");
  return (clean || fallback).slice(0, 120);
}

function accountField(accountHint) {
  const hint = String(accountHint ?? "").trim();
  return hint ? { label: "学号", value: hint } : null;
}

export function successNotification({ accountId, completionKey, courseName, accountHint, source, signParameter }) {
  const course = cleanLabel(courseName, "未命名课程");
  const fromSchedule = source === "schedule";
  const method = fromSchedule ? "课表确认（方式未知）"
    : signParameter === "timeTableId" ? "UUID"
      : signParameter === "courseSchedId" ? "courseSchedId" : "未知";
  return {
    id: `completion:${completionKey}:success`,
    accountId,
    kind: "success",
    content: card(fromSchedule ? "课表显示已签到" : "签到成功", [
      accountField(accountHint),
      { label: "课程", value: course },
      { label: "方法", value: method }
    ])
  };
}

export function expiredNotification({ accountId, completionKey, courseName, accountHint }) {
  const course = cleanLabel(courseName, "未命名课程");
  return {
    id: `completion:${completionKey}:failure`,
    accountId,
    kind: "failure",
    content: card("签到失败", [
      accountField(accountHint),
      { label: "课程", value: course },
      { label: "结果", value: "课程已结束，请人工核查。" }
    ])
  };
}

export function scheduleErrorNotification({ accountId, date, accountHint }) {
  const safeDate = /^\d{8}$/u.test(String(date)) ? String(date) : "未知日期";
  return {
    id: `schedule-error:${accountId}:${safeDate}`,
    accountId,
    kind: "schedule_error",
    content: card("课表查询异常", [
      accountField(accountHint),
      { label: "日期", value: safeDate },
      { label: "说明", value: "查询失败，5 分钟后自动重试。" }
    ])
  };
}

export function upcomingNotification({ accountId, completionKey, courseName, accountHint, attemptAt, stopAt }) {
  const course = cleanLabel(courseName, "未命名课程");
  const now = Date.now();
  const expiresAfterAttempt = Number.isFinite(attemptAt) ? attemptAt + 60_000 : now + 30_000;
  const expiresAt = Math.min(
    Number.isFinite(stopAt) ? stopAt : Number.POSITIVE_INFINITY,
    Math.max(expiresAfterAttempt, now + 30_000)
  );
  const time = formatShanghaiTime(attemptAt);
  return {
    id: `completion:${completionKey}:upcoming`,
    accountId,
    kind: "upcoming",
    expiresAt,
    content: card("即将签到", [
      accountField(accountHint),
      { label: "课程", value: course },
      { label: "计划尝试", value: `${time}（北京时间）` }
    ])
  };
}
