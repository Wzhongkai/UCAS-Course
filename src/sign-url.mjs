const SIGN_URL = "https://iclass.ucas.edu.cn:8181/app/course/stu_scan_sign.action";

/**
 * @typedef {"timeTableId" | "courseSchedId"} SignMethod
 * @typedef {{ name: SignMethod, value: string }} SignIdentifier
 */

/** @type {SignMethod} */
export const DEFAULT_SIGN_METHOD = "timeTableId";

export const SIGN_METHOD_LABELS = Object.freeze({
  timeTableId: "打卡机扫码",
  courseSchedId: "课堂扫码"
});

/** @param {unknown} value @param {boolean} [strict] @returns {SignMethod} */
export function normalizeSignMethod(value, strict = false) {
  if (value === "timeTableId" || value === "courseSchedId") return value;
  if (strict) throw new Error("签到方式无效，请选择打卡机扫码或课堂扫码");
  return DEFAULT_SIGN_METHOD;
}

/** @param {unknown} value @returns {SignMethod | null} */
export function parseSignMethodInput(value) {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  if (clean === "打卡机扫码" || clean === "timeTableId") return "timeTableId";
  if (clean === "课堂扫码" || clean === "courseSchedId") return "courseSchedId";
  return null;
}

/** @param {unknown} method @returns {string} */
export function signMethodLabel(method) {
  if (method === "courseSchedId") return SIGN_METHOD_LABELS.courseSchedId;
  if (method === "timeTableId") return SIGN_METHOD_LABELS.timeTableId;
  return SIGN_METHOD_LABELS[DEFAULT_SIGN_METHOD];
}

/** @param {unknown} value */
export function normalizeCourseUuid(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!/^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/iu.test(raw)) return null;
  return raw.replaceAll("-", "").toUpperCase();
}

/** @param {unknown} value */
export function normalizeCourseSchedId(value) {
  const id = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  return /^\d{7}$/.test(id) ? id : null;
}

/** @param {unknown} uuid @param {unknown} courseSchedId @param {unknown} [preferredMethod] @returns {SignIdentifier | null} */
export function selectSignIdentifier(uuid, courseSchedId, preferredMethod = DEFAULT_SIGN_METHOD) {
  const method = normalizeSignMethod(preferredMethod);
  const timeTableId = normalizeCourseUuid(uuid);
  const numericId = normalizeCourseSchedId(courseSchedId);
  if (method === "courseSchedId") {
    if (numericId) return { name: "courseSchedId", value: numericId };
    return timeTableId ? { name: "timeTableId", value: timeTableId } : null;
  }
  if (timeTableId) return { name: "timeTableId", value: timeTableId };
  return numericId ? { name: "courseSchedId", value: numericId } : null;
}

/** @param {SignIdentifier} identifier @param {number} timestamp @param {string} [userId] */
export function buildSignInUrl(identifier, timestamp, userId) {
  const params = new URLSearchParams({ [identifier.name]: identifier.value, timestamp: String(timestamp) });
  if (userId) params.set("id", userId);
  return `${SIGN_URL}?${params}`;
}
