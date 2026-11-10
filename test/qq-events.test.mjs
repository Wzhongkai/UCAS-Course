import assert from "node:assert/strict";
import test from "node:test";
import { expiredNotification, scheduleErrorNotification, successNotification, upcomingNotification } from "../src/qq/events.mjs";

test("success notifications deduplicate by completion key and say how success was detected", () => {
  const base = { accountId: "acct-1", completionKey: "acct-1:20261015:123:1792020000000", courseName: "数据结构", accountHint: "123***789" };
  const fromSchedule = successNotification({ ...base, source: "schedule" });
  const fromAttempt = successNotification({ ...base, source: "attempt", signParameter: "timeTableId" });
  const fallback = successNotification({ ...base, source: "attempt", signParameter: "courseSchedId" });

  assert.equal(fromSchedule.id, fromAttempt.id);
  assert.match(fromSchedule.content, /课表显示已签到/u);
  assert.match(fromSchedule.content, /方法：课表确认（方式未知）/u);
  assert.match(fromAttempt.content, /签到成功/u);
  assert.match(fromAttempt.content, /^【签到成功】\n\n学号：123\*\*\*789\n课程：数据结构\n方法：UUID$/u);
  assert.match(fallback.content, /方法：courseSchedId$/u);
  assert.doesNotMatch(fromAttempt.content, /节流|权限/u);
  assert.equal(fromSchedule.accountId, base.accountId);
});

test("expired and schedule error notifications use stable failure keys", () => {
  const expired = expiredNotification({ accountId: "acct-1", completionKey: "acct-1:20261015:123:1792020000000", courseName: "数据结构" });
  const scheduleError = scheduleErrorNotification({ accountId: "acct-1", date: "20261015" });

  assert.equal(expired.id, "completion:acct-1:20261015:123:1792020000000:failure");
  assert.equal(expired.kind, "failure");
  assert.match(expired.content, /^【签到失败】\n\n课程：数据结构\n结果：课程已结束，请人工核查。$/u);
  assert.equal(scheduleError.id, "schedule-error:acct-1:20261015");
  assert.equal(scheduleError.kind, "schedule_error");
  assert.match(scheduleError.content, /^【课表查询异常】\n\n日期：20261015\n说明：查询失败，5 分钟后自动重试。$/u);
});

test("upcoming notifications have a stable key, Shanghai time, and no credential fields", () => {
  const input = {
    accountId: "acct-1",
    completionKey: "acct-1:20261015:123:1792020000000",
    courseName: "数据结构",
    accountHint: "123***789",
    attemptAt: Date.parse("2026-09-14T07:50:00+08:00"),
    stopAt: Date.now() + 15_000,
    username: "student-raw-id",
    password: "raw-password-do-not-send"
  };
  const first = upcomingNotification(input);
  const repeated = upcomingNotification(input);

  assert.equal(first.id, "completion:acct-1:20261015:123:1792020000000:upcoming");
  assert.equal(first.id, repeated.id);
  assert.equal(first.kind, "upcoming");
  assert.equal(typeof first.expiresAt, "number");
  assert.ok(first.expiresAt <= input.stopAt);
  assert.match(first.content, /^【即将签到】\n\n学号：123\*\*\*789\n课程：数据结构\n计划尝试：2026-09-14 07:50（北京时间）$/u);
  assert.doesNotMatch(first.content, /节流|权限/u);
  assert.doesNotMatch(JSON.stringify(first), /raw-password-do-not-send|student-raw-id/u);
});

test("notifications omit the account field when there is no safe account hint", () => {
  const event = successNotification({ accountId: "acct-1", completionKey: "key", courseName: "数据结构", accountHint: "", source: "attempt", signParameter: "timeTableId" });
  assert.equal(event.content, "【签到成功】\n\n课程：数据结构\n方法：UUID");
});
