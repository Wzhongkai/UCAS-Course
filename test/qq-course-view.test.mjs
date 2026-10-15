import test from "node:test";
import assert from "node:assert/strict";
import { createCourseCards } from "../src/qq/course-view.mjs";
import { groupCourses, signWindow } from "../src/schedule.mjs";
import { formatShanghaiTime } from "../src/qq/format.mjs";

const date = "20261015";
const now = Date.parse("2026-10-15T08:30:00+08:00");
const courses = [{ id: "1234567", courseName: "高等数学", teacherName: "张老师", classBeginTime: "09:00:00", classEndTime: "10:30:00", classroom: "教一 101" }];
const account = { id: "account-a", username: "20260001", enabled: true, timing: { mode: "fixed", fixedMinutes: 10 }, courseWhitelist: [], courseTimingOverrides: {} };
function view(changes = {}) {
  return createCourseCards(courses, { account, date, now, ...changes }).join("\n\n");
}

test("当天课程完整呈现教师、时间、教室和实际提前签到时间", () => {
  const result = view();
  assert.match(result, /课程：高等数学/u);
  assert.match(result, /教师：张老师/u);
  assert.match(result, /课程时间：2026-10-15 09:00–10:30/u);
  assert.match(result, /教室：教一 101/u);
  assert.match(result, /签到时间：08:50（提前 10 分钟）/u);
  assert.match(result, /打卡状态：等待后台更新/u);
  const override = view({ account: { ...account, courseTimingOverrides: { 高等数学: { mode: "fixed", fixedMinutes: 15 } } } });
  assert.match(override, /签到时间：08:45（提前 15 分钟）/u);
});

test("停止单课和总开关关闭都明确显示停止打卡", () => {
  const skipped = view({ account: { ...account, courseWhitelist: [" 高等数学 "] } });
  assert.match(skipped, /签到时间：停止打卡/u);
  assert.match(skipped, /打卡状态：停止打卡（单课已停用）/u);
  const paused = view({ account: { ...account, enabled: false } });
  assert.match(paused, /打卡状态：停止打卡（总开关已关闭）/u);
  assert.match(paused, /教师：张老师/u);
});

test("当前打卡状态只采纳同账号、同日期、同课程且新鲜的后台记录", () => {
  const group = groupCourses(courses, date)[0];
  const plan = [{ courseName: "高等数学", courseIds: ["1234567"], start: group.start, end: group.end, state: "已签到" }];
  const workerStatus = { updatedAt: new Date(now).toISOString(), accounts: [{ id: "other", date, enabled: true, plan: [{ ...plan[0], state: "重试中" }] }, { id: account.id, date, enabled: true, plan }] };
  assert.match(view({ workerStatus }), /打卡状态：已签到/u);
  for (const changed of [
    { ...workerStatus, updatedAt: new Date(now - 91_000).toISOString() },
    { ...workerStatus, accounts: [{ id: account.id, date: "20261014", plan }] },
    { ...workerStatus, accounts: [{ id: account.id, date, plan: [{ ...plan[0], courseIds: ["7654321"] }] }] }
  ]) {
    const result = view({ workerStatus: changed });
    assert.match(result, /打卡状态：等待后台更新/u);
    assert.doesNotMatch(result, /打卡状态：已签到|打卡状态：重试中/u);
  }
});

test("实时课表已签到标记可以确认当前成功状态", () => {
  const result = createCourseCards([{ ...courses[0], signStatus: "1" }], { account, date, now }).join("\n\n");
  assert.match(result, /打卡状态：已签到（课表已确认）/u);
  const missingId = createCourseCards([{ ...courses[0], id: "", signStatus: "1" }], { account, date, now }).join("\n\n");
  assert.match(missingId, /打卡状态：已签到（课表已确认）/u);
  assert.doesNotMatch(missingId, /无法生成计划/u);
});

test("课程合并与worker保持一致，不合并不同原始名称的随机计划", () => {
  const source = [{ ...courses[0], courseName: "Math" }, { ...courses[0], courseName: "math", id: "1234568" }];
  const timing = { mode: "random", minMinutes: 1, maxMinutes: 120 };
  const result = createCourseCards(source, { account: { ...account, timing }, date, now }).join("\n\n");
  assert.match(result, /课程数：2 门/u);
  for (const group of groupCourses(source, date)) {
    const expected = signWindow(group, timing, account.id).attemptAt;
    assert.ok(result.includes(`签到时间：${formatShanghaiTime(expected, { date: false })}`));
  }
});

test("随机签到时间与worker算法一致，重复课程聚合教师与教室", () => {
  const timing = { mode: "random", minMinutes: 5, maxMinutes: 12 };
  const expected = signWindow(groupCourses(courses, date)[0], timing, account.id).attemptAt;
  const result = view({ account: { ...account, timing } });
  assert.ok(result.includes(`签到时间：${formatShanghaiTime(expected, { date: false })}（提前 5–12 分钟）`));
  const grouped = createCourseCards([...courses, { ...courses[0], id: "1234568", teacherName: "李老师", classroom: "教一 102" }], { account, date, now }).join("\n\n");
  assert.match(grouped, /课程数：1 门/u);
  assert.match(grouped, /教师：张老师 \/ 李老师/u);
  assert.match(grouped, /教室：教一 101 \/ 教一 102/u);
});

test("缺少教室和无法安排的课程明确说明，不捏造计划", () => {
  const result = createCourseCards([{ courseName: "课程名", classBeginTime: "09:00", classEndTime: "10:00" }], { account, date, now }).join("\n\n");
  assert.match(result, /教室：未提供/u);
  assert.match(result, /教师：未提供/u);
  assert.match(result, /打卡状态：课程编号或时间不完整，无法生成计划/u);
});
