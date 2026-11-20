import { parseCourseTime } from "../schedule.mjs";

const SHANGHAI_TIME_ZONE = "Asia/Shanghai";

function displayText(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
}

function displayLines(value) {
  if (value === null || value === undefined) return "";
  return String(value).split(/\r\n?|\n/u).map(displayText).join("\n").trim();
}

export function card(title, fields = [], { footer, icon } = {}) {
  const heading = displayText(title) || "消息";
  const badge = displayText(icon);
  const lines = (Array.isArray(fields) ? fields : []).flatMap((field) => {
    const [rawLabel, rawValue] = Array.isArray(field) ? field : [field?.label, field?.value];
    const label = displayText(rawLabel);
    const value = displayText(rawValue);
    return label && value ? [`· ${label}：${value}`] : [];
  });
  const note = displayLines(footer);
  const body = [badge ? `${badge} ${heading}` : `▸ ${heading}`];
  if (lines.length > 0) body.push(...lines);
  if (note) body.push("", note);
  return body.join("\n");
}

function timestamp(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (typeof value === "string" && value.trim()) return Date.parse(value);
  return NaN;
}

function shanghaiParts(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SHANGHAI_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(value);
  return Object.fromEntries(parts.map(({ type, value: partValue }) => [type, partValue]));
}

export function formatShanghaiTime(value, { date = true } = {}) {
  const valueAt = timestamp(value);
  if (!Number.isFinite(valueAt)) return "时间未知";
  const parts = shanghaiParts(valueAt);
  const time = `${parts.hour}:${parts.minute}`;
  return date ? `${parts.year}-${parts.month}-${parts.day} ${time}` : time;
}

function courseTime(value, date, includeDate) {
  if (value === null || value === undefined || value === "") return "";
  const raw = displayText(value);
  if (/^\d{1,2}:\d{2}(?::\d{2})?$/u.test(raw)) {
    if (typeof date === "string" && /^\d{8}$/u.test(date)) {
      const parsed = parseCourseTime(raw, date);
      return parsed === null ? "" : formatShanghaiTime(parsed, { date: includeDate });
    }
    return raw.length === 5 ? raw : raw.slice(0, 5);
  }
  return formatShanghaiTime(value, { date: includeDate });
}

export function formatCourseCards(rows, { title = "课程", date } = {}) {
  if (!Array.isArray(rows)) return "";
  const hasDate = Boolean(date);
  const cards = rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const name = displayText(row.courseName ?? row.name);
    const startValue = row.start ?? row.startAt ?? row.classBeginTime ?? row.startTime;
    const endValue = row.end ?? row.endAt ?? row.classEndTime ?? row.endTime;
    const start = courseTime(startValue, date, hasDate);
    const end = courseTime(endValue, date, false);
    const time = start && end ? `${start}–${end}` : start || end;
    const fields = [
      { label: "课程", value: name },
      { label: "时间", value: time },
      { label: "教师", value: row.teacherName ?? row.teacher },
      { label: "教室", value: row.classroom ?? row.classRoom ?? row.roomName },
      { label: "状态", value: row.state },
      { label: "尝试", value: Number.isInteger(row.attempts) ? `${row.attempts} 次` : "" }
    ];
    return [card(title, fields)];
  });
  return cards.join("\n\n");
}

const LIBRARY_HELP = [
  "▸ 图书馆余座（免绑定）",
  "  查询图书馆座位",
  "  订阅自助区 / 关闭订阅"
];

const USER_HELP = [
  "📖 使用指南",
  "单课设置中的“课程名”填完整课程名，方括号内容可省略。",
  "",
  "▸ 账号与查询",
  "  绑定学号 学号 密码",
  "  查询课表 / 状态 / 解绑",
  "",
  "▸ 打卡操作",
  "  立即签到 课程名 [打卡机扫码|课堂扫码]",
  "  开启打卡 / 关闭打卡",
  "  启动打卡 课程名 / 停止打卡 课程名",
  "  停止打卡课程名单",
  "",
  "▸ 签到时间（提前 1～30 分钟）",
  "  签到时间 所有|课程名 固定 10",
  "  签到时间 所有|课程名 随机 5 10",
  "",
  "▸ 签到方式",
  "  签到方式 所有|课程名 打卡机扫码|课堂扫码",
  "",
  "▸ 消息通知",
  "  通知 全部|仅失败|关闭",
  "",
  ...LIBRARY_HELP
].join("\n");

const ADMIN_HELP = [
  "🛠️ 管理员目录",
  "管理员模式下所有账号指令均须指定学号，切换模式不影响后台打卡。",
  "",
  "▸ 模式切换",
  "  进入管理员模式 / 退出管理员模式",
  "",
  "▸ 查看与诊断",
  "  账号列表",
  "  状态 学号 / 查询课表 学号 / 刷新课表 学号",
  "  日志 / 日志 学号",
  "",
  "▸ 账号管理",
  "  添加学号 学号 密码",
  "  删除学号 学号（需二次确认）",
  "  更新密码 学号 新密码",
  "  绑定码 学号 / 解绑 学号（解绑该学号全部 QQ）",
  "",
  "▸ 打卡与方式代管",
  "  立即签到 学号 课程名 [打卡机扫码|课堂扫码]",
  "  开启打卡 学号 / 关闭打卡 学号",
  "  启动打卡 学号 课程名 / 停止打卡 学号 课程名",
  "  停止打卡课程名单 学号",
  "  签到时间 学号 所有|课程名 固定 10",
  "  签到时间 学号 所有|课程名 随机 5 10",
  "  签到方式 学号 所有|课程名 打卡机扫码|课堂扫码",
  "",
  "▸ 全局通知（对该学号全部 QQ 生效）",
  "  通知 学号 全部|仅失败|关闭",
  "  测试通知 学号"
].join("\n");

const USER_HELP_FOR_ADMIN = [
  USER_HELP,
  "",
  "▸ 管理员入口",
  "  进入管理员模式 / 管理员帮助"
].join("\n");

export function helpMessage(isAdmin = false, section = "main") {
  if (section === "admin") return isAdmin ? ADMIN_HELP : "";
  return isAdmin ? USER_HELP_FOR_ADMIN : USER_HELP;
}
