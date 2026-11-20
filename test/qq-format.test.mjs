import assert from "node:assert/strict";
import test from "node:test";
import { card, formatCourseCards, formatShanghaiTime, helpMessage } from "../src/qq/format.mjs";

test("card uses plain-text fields, filters blank values, and separates its footer", () => {
  assert.equal(card("标题", [
    { label: "课程", value: " 数据结构 " },
    ["教师", "张老师"],
    { label: "教师", value: "  " },
    { label: "空字段", value: null }
  ], { footer: "请及时查看" }), "▸ 标题\n· 课程：数据结构\n· 教师：张老师\n\n请及时查看");
  assert.equal(card("标题", [{ label: "课程", value: "" }], { icon: "✅" }), "✅ 标题");
  assert.equal(card("删除确认", [], { footer: "请复制以下指令：\n删除账号 20260001 确认 ABC123" }), "▸ 删除确认\n\n请复制以下指令：\n删除账号 20260001 确认 ABC123");
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

  assert.match(result, /▸ 今日课程\n· 课程：数据结构\n· 时间：2026-10-15 09:00–10:30/u);
  assert.match(result, /· 教师：张老师\n· 教室：教一-101/u);
  assert.match(result, /\n\n▸ 今日课程\n· 课程：英语\n· 时间：2026-10-15 11:00–12:00/u);
  assert.match(result, /· 状态：待开始\n· 尝试：0 次/u);
  assert.equal(formatCourseCards([]), "");
});

test("help menus show distinct user and admin directories and keep admin commands private", () => {
  const userHelp = helpMessage(false);
  const adminPersonalHelp = helpMessage(true);
  const adminOnlyHelp = helpMessage(true, "admin");
  const userAdminHelp = helpMessage(false, "admin");

  assert.match(userHelp, /📖 使用指南/u);
  assert.match(userHelp, /▸ 账号与查询\n  绑定学号 学号 密码\n  查询课表 \/ 状态 \/ 解绑/u);
  assert.match(userHelp, /▸ 打卡操作\n  立即签到 课程名 \[打卡机扫码\|课堂扫码\]\n  开启打卡 \/ 关闭打卡\n  启动打卡 课程名 \/ 停止打卡 课程名\n  停止打卡课程名单/u);
  assert.match(userHelp, /▸ 签到时间（提前 1～30 分钟）\n  签到时间 所有\|课程名 固定 10\n  签到时间 所有\|课程名 随机 5 10/u);
  assert.match(userHelp, /▸ 签到方式\n  签到方式 所有\|课程名 打卡机扫码\|课堂扫码/u);
  assert.match(userHelp, /▸ 消息通知\n  通知 全部\|仅失败\|关闭/u);
  assert.match(userHelp, /▸ 图书馆余座（免绑定）\n  查询图书馆座位\n  订阅自助区 \/ 关闭订阅/u);
  assert.doesNotMatch(userHelp, /UUID|7位|120|管理员|绑定码|添加学号|删除学号|更新密码|日志|20260001/u);
  assert.equal(userAdminHelp, "");

  assert.ok(adminPersonalHelp.startsWith(userHelp));
  assert.match(adminPersonalHelp, /▸ 管理员入口\n  进入管理员模式 \/ 管理员帮助/u);

  assert.notEqual(adminOnlyHelp, userHelp);
  assert.match(adminOnlyHelp, /🛠️ 管理员目录/u);
  assert.match(adminOnlyHelp, /▸ 模式切换\n  进入管理员模式 \/ 退出管理员模式/u);
  assert.match(adminOnlyHelp, /▸ 查看与诊断\n  账号列表\n  状态 学号 \/ 查询课表 学号 \/ 刷新课表 学号\n  日志 \/ 日志 学号/u);
  assert.match(adminOnlyHelp, /▸ 账号管理\n  添加学号 学号 密码\n  删除学号 学号（需二次确认）\n  更新密码 学号 新密码\n  绑定码 学号 \/ 解绑 学号（解绑该学号全部 QQ）/u);
  assert.match(adminOnlyHelp, /▸ 打卡与方式代管\n  立即签到 学号 课程名 \[打卡机扫码\|课堂扫码\]\n  开启打卡 学号 \/ 关闭打卡 学号\n  启动打卡 学号 课程名 \/ 停止打卡 学号 课程名\n  停止打卡课程名单 学号\n  签到时间 学号 所有\|课程名 固定 10\n  签到时间 学号 所有\|课程名 随机 5 10\n  签到方式 学号 所有\|课程名 打卡机扫码\|课堂扫码/u);
  assert.match(adminOnlyHelp, /▸ 全局通知（对该学号全部 QQ 生效）\n  通知 学号 全部\|仅失败\|关闭\n  测试通知 学号/u);
  assert.doesNotMatch(adminOnlyHelp, /UUID|7位|120|图书馆余座|绑定学号 学号 密码|20260001/u);
  assert.ok(adminPersonalHelp.length <= 1300);
  assert.ok(userHelp.length <= 1300);
  assert.ok(adminOnlyHelp.length <= 1300);
});
