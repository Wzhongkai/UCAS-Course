import assert from "node:assert/strict";
import test from "node:test";
import { card, formatCourseCards, formatShanghaiTime, helpMessage } from "../src/qq/format.mjs";

test("card uses plain-text fields, filters blank values, and separates its footer", () => {
  assert.equal(card("标题", [
    { label: "课程", value: " 数据结构 " },
    ["教师", "张老师"],
    { label: "教师", value: "  " },
    { label: "空字段", value: null }
  ], { footer: "请及时查看" }), "【标题】\n\n课程：数据结构\n教师：张老师\n\n请及时查看");
  assert.equal(card("标题", [{ label: "课程", value: "" }]), "【标题】");
  assert.equal(card("删除确认", [], { footer: "请复制以下指令：\n删除账号 20260001 确认 ABC123" }), "【删除确认】\n\n请复制以下指令：\n删除账号 20260001 确认 ABC123");
});

test("Shanghai time formatter handles dates and clock-only output", () => {
  const value = Date.parse("2026-10-15T01:02:00.000Z");
  assert.equal(formatShanghaiTime(value), "2026-10-15 09:02");
  assert.equal(formatShanghaiTime(value, { date: false }), "09:02");
  assert.equal(formatShanghaiTime("not a date"), "时间未知");
});

test("course rows render as separate readable cards and parse clock times using date", () => {
  const result = formatCourseCards([
    { courseName: "数据结构", classBeginTime: "09:00:00", classEndTime: "10:30:00", teacherName: "张老师", classroom: "教一-101" },
    { name: "英语", start: Date.parse("2026-10-15T03:00:00.000Z"), end: Date.parse("2026-10-15T04:00:00.000Z"), state: "待开始", attempts: 0 }
  ], { title: "今日课程", date: "20261015" });

  assert.match(result, /【今日课程】\n\n课程：数据结构\n时间：2026-10-15 09:00–10:30/u);
  assert.match(result, /教师：张老师\n教室：教一-101/u);
  assert.match(result, /\n\n【今日课程】\n\n课程：英语\n时间：2026-10-15 11:00–12:00/u);
  assert.match(result, /状态：待开始\n尝试：0 次/u);
  assert.equal(formatCourseCards([]), "");
});

test("help menus show concise copyable examples and keep admin commands private", () => {
  const userHelp = helpMessage(false);
  const adminHelp = helpMessage(true);
  const adminOnlyHelp = helpMessage(true, "admin");
  const userAdminHelp = helpMessage(false, "admin");

  assert.match(userHelp, /【账号与课程】/u);
  assert.match(userHelp, /【打卡设置】/u);
  assert.match(userHelp, /【提醒与通知】/u);
  assert.match(userHelp, /绑定学号 学号 密码\n查询课表/u);
  assert.match(userHelp, /开启打卡\n关闭打卡\n启动打卡 高等数学\n停止打卡 高等数学/u);
  assert.match(userHelp, /签到时间 所有 固定 10\n签到时间 所有 随机 5 10\n签到时间 高等数学 固定 10\n签到时间 高等数学 随机 5 10\n停止打卡课程名单/u);
  assert.equal(userHelp.split("\n").filter((line) => line.startsWith("通知 ")).length, 3);
  assert.match(userHelp, /通知 全部\n通知 仅失败\n通知 关闭/u);
  assert.doesNotMatch(userHelp, /^(?:我的ID|账号列表|状态|查询课程|课表|单课时间|不打卡名单|解绑|测试通知)$/mu);
  assert.doesNotMatch(userHelp, /管理员菜单|绑定 CODE|删除账号|示例学号|20260001/u);
  assert.equal(adminHelp, userHelp);
  assert.equal(userAdminHelp, "");
  assert.match(adminOnlyHelp, /【管理员帮助】/u);
  assert.match(adminOnlyHelp, /【管理员 · 常用指令】/u);
  assert.match(adminOnlyHelp, /绑定学号 学号 密码\n查询课表 20260001\n开启打卡 20260001\n关闭打卡 20260001/u);
  assert.match(adminOnlyHelp, /停止打卡 20260001 高等数学\n启动打卡 20260001 高等数学/u);
  assert.match(adminOnlyHelp, /签到时间 20260001 所有 固定 10\n签到时间 20260001 所有 随机 5 10\n签到时间 20260001 高等数学 固定 10\n签到时间 20260001 高等数学 随机 5 10/u);
  assert.match(adminOnlyHelp, /停止打卡课程名单 20260001\n通知 20260001 全部\n通知 20260001 仅失败\n通知 20260001 关闭/u);
  assert.match(adminOnlyHelp, /管理员操作请先指定学号/u);
  assert.match(adminOnlyHelp, /管理员默认以本人模式操作。\n进入管理员模式\n退出管理员模式\n管理员模式下所有账号指令都必须带学号。/u);
  assert.match(adminOnlyHelp, /切换模式只改变可操作范围，不影响后台打卡。/u);
  assert.match(adminOnlyHelp, /【账号管理】\n添加学号 20260001 示例密码\n删除学号 20260001\n删除后按提示完成二次确认。/u);
  assert.doesNotMatch(adminOnlyHelp, /单课时间|不打卡名单 20260001|管理菜单|绑定 CODE|添加账号|删除账号|更新密码|刷新课表|日志/u);
  assert.ok(adminHelp.length <= 1300);
  assert.ok(userHelp.length <= 1300);
  assert.ok(adminOnlyHelp.length <= 1300);
});
