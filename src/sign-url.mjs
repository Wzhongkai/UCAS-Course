const SIGN_URL = "https://iclass.ucas.edu.cn:8181/app/course/stu_scan_sign.action";

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

/**
 * @typedef {{ name: "timeTableId" | "courseSchedId", value: string }} SignIdentifier
 */

/** @param {unknown} uuid @param {unknown} courseSchedId @returns {SignIdentifier | null} */
export function selectSignIdentifier(uuid, courseSchedId) {
  const timeTableId = normalizeCourseUuid(uuid);
  if (timeTableId) return { name: "timeTableId", value: timeTableId };
  const numericId = normalizeCourseSchedId(courseSchedId);
  return numericId ? { name: "courseSchedId", value: numericId } : null;
}

/** @param {SignIdentifier} identifier @param {number} timestamp @param {string} [userId] */
export function buildSignInUrl(identifier, timestamp, userId) {
  const params = new URLSearchParams({ [identifier.name]: identifier.value, timestamp: String(timestamp) });
  if (userId) params.set("id", userId);
  return `${SIGN_URL}?${params}`;
}
