import test from "node:test";
import assert from "node:assert/strict";
import { groupCourses, parseCourseTime, scheduleOutcome, shanghaiDate, signTargetForAttempt, signWindow, timeAtSix } from "../src/schedule.mjs";

const date = "20260914";
const course = (id, start, end, name = "高等数学", teacher = "张老师") => ({
  id,
  courseName: name,
  teacherName: teacher,
  classBeginTime: `2026-09-14 ${start}`,
  classEndTime: `2026-09-14 ${end}`,
  signStatus: "0"
});

test("按上海时区解析课程时间", () => {
  assert.equal(parseCourseTime("2026-09-14 08:00:00", date), Date.parse("2026-09-14T08:00:00+08:00"));
  assert.equal(shanghaiDate(Date.parse("2026-09-13T17:00:00Z")), date);
  assert.equal(parseCourseTime("25:00:00", date), null);
});

test("每日 06:00 查询点按上海时区计算", () => {
  assert.equal(timeAtSix(date), Date.parse("2026-09-14T06:00:00+08:00"));
});

test("时间段不同的课程保持为独立签到目标", () => {
  const groups = groupCourses([
    course("1234568", "09:50:00", "10:35:00"),
    course("1234567", "08:00:00", "09:40:00"),
    course("1234569", "11:10:00", "12:00:00"),
    course("1234570", "12:10:00", "13:00:00", "大学英语", "李老师")
  ], date);
  assert.equal(groups.length, 4);
  assert.deepEqual(groups[0].courses.map(({ id }) => id), ["1234567"]);
  assert.equal(groups[0].first.id, "1234567");
  assert.deepEqual(groups[0].signTargets.map(({ id }) => id), ["1234567"]);
  assert.equal(groups[0].sessionCount, 1);
  assert.equal(groups[0].firstEnd, Date.parse("2026-09-14T09:40:00+08:00"));
});

test("同名同时间但老师不同的记录作为候选签到入口", () => {
  const groups = groupCourses([
    course("1234568", "08:00:00", "09:40:00", "信息检索导论", "李老师"),
    course("1234567", "08:00:00", "09:40:00", "信息检索导论", "张老师"),
    course("1234569", "08:00:00", "09:40:00", "另一门课", "张老师")
  ], date);
  assert.equal(groups.length, 2);
  const informationRetrieval = groups.find((group) => group.first.courseName === "信息检索导论");
  assert.deepEqual(informationRetrieval.signTargets.map(({ id }) => id), ["1234567", "1234568"]);
  assert.equal(informationRetrieval.sessionCount, 1);
  assert.equal(informationRetrieval.courses.length, 2);
  assert.equal(signTargetForAttempt(informationRetrieval, 1).id, "1234567");
  assert.equal(signTargetForAttempt(informationRetrieval, 2).id, "1234568");
  assert.equal(signTargetForAttempt(informationRetrieval, 3).id, "1234567");
});

test("准备、开始尝试和停止时间相对第一节课计算", () => {
  const [group] = groupCourses([course("1234567", "08:00:00", "09:40:00")], date);
  assert.deepEqual(signWindow(group), {
    prepareAt: Date.parse("2026-09-14T07:30:00+08:00"),
    attemptAt: Date.parse("2026-09-14T07:50:00+08:00"),
    stopAt: Date.parse("2026-09-14T09:40:00+08:00")
  });
});

test("每个账号可以使用固定或稳定的随机提前时间", () => {
  const [group] = groupCourses([course("1234567", "08:00:00", "09:40:00")], date);
  const fixed = signWindow(group, { mode: "fixed", fixedMinutes: 15 }, "account-a");
  assert.equal(fixed.attemptAt, Date.parse("2026-09-14T07:45:00+08:00"));

  const timing = { mode: "random", minMinutes: 10, maxMinutes: 20 };
  const random = signWindow(group, timing, "account-a");
  const repeated = signWindow(group, timing, "account-a");
  assert.equal(random.attemptAt, repeated.attemptAt);
  assert.ok(random.attemptAt >= Date.parse("2026-09-14T07:40:00+08:00"));
  assert.ok(random.attemptAt <= Date.parse("2026-09-14T07:50:00+08:00"));
});

test("成功获取空课表时明确标记为今日无课", () => {
  assert.deepEqual(scheduleOutcome([], date), { state: "no_courses", groups: [] });
  assert.equal(scheduleOutcome([course("1234567", "08:00:00", "09:40:00")], date).state, "ready");
});

test("无效或重复的课程记录不会产生签到任务", () => {
  const groups = groupCourses([
    course("1234567", "08:00:00", "09:00:00"),
    course("1234567", "08:00:00", "09:00:00"),
    course("abc", "10:00:00", "11:00:00")
  ], date);
  assert.equal(groups.length, 1);
});

test("即使课程 ID 相同，结束时间不同也保留为两个目标", () => {
  const groups = groupCourses([
    course("1234567", "08:00:00", "09:00:00"),
    course("1234567", "08:00:00", "09:30:00")
  ], date);
  assert.equal(groups.length, 2);
});
