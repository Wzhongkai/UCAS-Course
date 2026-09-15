import { createHmac, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "ucas_course_access";

function accessKey() {
  return process.env.UCAS_ACCESS_KEY ?? process.env.AUTO_SIGN_ADMIN_TOKEN ?? "";
}

function cookiePath() {
  const basePath = process.env.APP_BASE_PATH || process.env.NEXT_PUBLIC_BASE_PATH || "";
  return basePath.startsWith("/") && basePath !== "/" ? basePath : "/";
}

export function accessReady() {
  return accessKey().length >= 16;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieValue() {
  return createHmac("sha256", accessKey())
    .update("ucas-course-access-v1")
    .digest("hex");
}

export function validAccessKey(value) {
  return accessReady() && safeEqual(value, accessKey());
}

export function authorized(request) {
  if (!accessReady()) return false;
  const cookie = request.cookies.get(COOKIE_NAME)?.value ?? "";
  return safeEqual(cookie, cookieValue());
}

export function sameOrigin(request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function setAccessCookie(response, request) {
  const secure = request.headers.get("x-forwarded-proto") === "https" || request.nextUrl.protocol === "https:";
  response.cookies.set(COOKIE_NAME, cookieValue(), {
    httpOnly: true,
    secure,
    sameSite: "strict",
    path: cookiePath(),
    maxAge: 7 * 24 * 60 * 60
  });
}

export function clearAccessCookie(response) {
  response.cookies.set(COOKIE_NAME, "", { httpOnly: true, path: cookiePath(), maxAge: 0 });
}
