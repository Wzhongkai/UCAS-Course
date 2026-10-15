import { accessCookieHeader } from "../automation/auth.mjs";

function backendUrl(env) {
  const port = Number(env.APP_PORT || "3100");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("后台端口配置无效");
  const basePath = (env.APP_BASE_PATH || "").replace(/^\/+|\/+$/gu, "");
  if (/[\\?#%\s]/u.test(basePath) || /(?:^|\/)\.{1,2}(?:\/|$)/u.test(basePath)) {
    throw new Error("后台路径配置无效");
  }
  return new URL(`${basePath ? `/${basePath}` : ""}/api/qq/schedule`, `http://127.0.0.1:${port}`);
}

export function createBackendScheduleQuery({
  env = process.env,
  fetchImpl = fetch,
  cookieHeader = accessCookieHeader,
  timeoutMs = 25_000
} = {}) {
  return async (accountId, date) => {
    const url = backendUrl(env);
    const cookie = cookieHeader();
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: url.origin,
          ...(cookie ? { cookie } : {})
        },
        body: JSON.stringify({ accountId, date }),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) throw new Error("后台查询失败");
      const body = await response.json();
      if (!Array.isArray(body?.courses) || body.date !== String(date).replaceAll("-", "")) {
        throw new Error("后台课表格式无效");
      }
      return body.courses;
    } catch {
      // Network errors and upstream bodies can contain internal addresses or
      // credentials. The command handler only receives a fixed public error.
      throw new Error("后台课表查询暂时不可用，请稍后重试");
    }
  };
}
