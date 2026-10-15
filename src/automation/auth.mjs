import { createHmac, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "ucas_course_access";

// The portable Windows launcher opts into this mode only together with an
// explicit loopback bind. Requiring both values prevents an accidentally
// inherited LOCAL_DESKTOP_MODE=1 from disabling authentication on a public
// deployment.
export function localDesktopMode() {
  return process.env.LOCAL_DESKTOP_MODE === "1"
    && process.env.APP_HOST === "127.0.0.1"
    && process.env.HOSTNAME === "127.0.0.1";
}

function accessKey() {
  return process.env.UCAS_ACCESS_KEY ?? process.env.AUTO_SIGN_ADMIN_TOKEN ?? "";
}

function cookiePath() {
  const basePath = process.env.APP_BASE_PATH || process.env.NEXT_PUBLIC_BASE_PATH || "";
  return basePath.startsWith("/") && basePath !== "/" ? basePath : "/";
}

export function accessReady() {
  return localDesktopMode() || accessKey().length >= 16;
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

// Server-side callers use the same access proof as the web application. This
// value must only be sent to our loopback backend, never included in replies.
export function accessCookieHeader() {
  if (localDesktopMode()) return "";
  if (!accessReady()) throw new Error("后台访问密钥尚未配置");
  return `${COOKIE_NAME}=${cookieValue()}`;
}

export function validAccessKey(value) {
  if (localDesktopMode()) return false;
  return accessReady() && safeEqual(value, accessKey());
}

export function authorized(request) {
  if (localDesktopMode()) return true;
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
