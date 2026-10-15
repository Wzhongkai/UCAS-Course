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

export function card(title, fields = [], { footer } = {}) {
  const heading = displayText(title) || "消息";
  const lines = (Array.isArray(fields) ? fields : []).flatMap((field) => {
    const [rawLabel, rawValue] = Array.isArray(field) ? field : [field?.label, field?.value];
    const label = displayText(rawLabel);
    const value = displayText(rawValue);
    return label && value ? [`${label}：${value}`] : [];
  });
  const note = displayLines(footer);
  const body = [`【${heading}】`];
  if (lines.length > 0) body.push("", ...lines);
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

const USER_HELP = [
  "【账号与课程】",
  "帮助",
  "绑定学号 学号 密码",
  "查询课表",
  "",
  "【打卡设置】",
  "开启打卡",
  "关闭打卡",
  "启动打卡 高等数学",
  "停止打卡 高等数学",
  "签到时间 所有 固定 10",
  "签到时间 所有 随机 5 10",
  "签到时间 高等数学 固定 10",
  "签到时间 高等数学 随机 5 10",
  "停止打卡课程名单",
  "",
  "【提醒与通知】",
  "通知 全部",
  "通知 仅失败",
  "通知 关闭"
].join("\n");

const ADMIN_MAIN_HELP = [
  "【管理员 · 常用指令】",
  "绑定学号 学号 密码",
  "查询课表 20260001",
  "开启打卡 20260001",
  "关闭打卡 20260001",
  "停止打卡 20260001 高等数学",
  "启动打卡 20260001 高等数学",
  "签到时间 20260001 所有 固定 10",
  "签到时间 20260001 所有 随机 5 10",
  "签到时间 20260001 高等数学 固定 10",
  "签到时间 20260001 高等数学 随机 5 10",
  "停止打卡课程名单 20260001",
  "通知 20260001 全部",
  "通知 20260001 仅失败",
  "通知 20260001 关闭",
  "管理员操作请先指定学号。"
].join("\n");

const ADMIN_HELP = [
  "【管理员帮助】",
  "管理员默认以本人模式操作。",
  "进入管理员模式",
  "退出管理员模式",
  "管理员模式下所有账号指令都必须带学号。",
  "切换模式只改变可操作范围，不影响后台打卡。",
  "",
  ...ADMIN_MAIN_HELP.split("\n"),
  "",
  "【账号管理】",
  "添加学号 20260001 示例密码",
  "删除学号 20260001",
  "删除后按提示完成二次确认。"
].join("\n");

export function helpMessage(isAdmin = false, section = "main") {
  if (section === "admin") return isAdmin ? ADMIN_HELP : "";
  return USER_HELP;
}
