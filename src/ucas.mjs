const BASE = "https://iclass.ucas.edu.cn:8181";
const LOGIN_UA = "student_5.0.1.2_android_12_20__110000";
const API_UA = "student_5.0.1.2_android_12_20_100000000000000_110000";
const VERIFICATION_URL =
  "http://iclass.ucas.edu.cn:88/ve/webservices/mobileCheck.shtml?method=mobileLogin&username=${0}&password=${1}&lx=${2}";

async function requestJson(fetchImpl, url, options, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      ...options,
      cache: "no-store",
      signal: controller.signal
    });
    if (!response.ok) {
      const error = new Error(`UCAS HTTP ${response.status}`);
      error.status = response.status;
      if (response.status === 429) {
        const retryAfter = response.headers.get("retry-after");
        const seconds = Number(retryAfter);
        error.retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 60_000;
      }
      throw error;
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export class UcasClient {
  constructor({ username, password, fetchImpl = fetch }) {
    this.username = username;
    this.password = password;
    this.fetchImpl = fetchImpl;
    this.userId = "";
    this.sessionId = "";
    this.loggedInAt = 0;
  }

  async login() {
    const body = new URLSearchParams({
      phone: this.username,
      password: this.password,
      verificationType: "1",
      verificationUrl: VERIFICATION_URL,
      userLevel: "1"
    });
    const data = await requestJson(this.fetchImpl, `${BASE}/app/user/login.action`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": LOGIN_UA
      },
      body: body.toString()
    });
    if (data?.STATUS !== "0" || !data?.result?.id || !data?.result?.sessionId) {
      throw new Error("UCAS 登录失败，请检查学号和密码");
    }
    this.userId = String(data.result.id);
    this.sessionId = String(data.result.sessionId);
    this.loggedInAt = Date.now();
  }

  async ensureLogin() {
    if (!this.sessionId || Date.now() - this.loggedInAt > 10 * 60_000) {
      await this.login();
    }
  }

  async schedule(date) {
    await this.ensureLogin();
    const url = new URL(`${BASE}/app/course/get_stu_course_sched.action`);
    url.searchParams.set("id", this.userId);
    url.searchParams.set("dateStr", date);
    const data = await requestJson(this.fetchImpl, url, {
      method: "GET",
      headers: { sessionId: this.sessionId, "User-Agent": API_UA }
    });
    if (data?.STATUS !== "0") {
      throw new Error("UCAS 课表查询失败");
    }
    return Array.isArray(data.result) ? data.result : [];
  }

  async sign(courseSchedId, timestamp) {
    await this.ensureLogin();
    const url = new URL(`${BASE}/app/course/stu_scan_sign.action`);
    url.searchParams.set("courseSchedId", courseSchedId);
    url.searchParams.set("timestamp", String(timestamp));
    url.searchParams.set("id", this.userId);
    return requestJson(this.fetchImpl, url, {
      method: "GET",
      headers: { sessionId: this.sessionId, "User-Agent": API_UA }
    });
  }

  async serverTimestamp() {
    const url = new URL(`${BASE}/app/common/get_timestamp.do`);
    url.searchParams.set("id", String(Math.floor(Math.random() * 1_000_000)));
    const data = await requestJson(this.fetchImpl, url, {
      method: "POST",
      headers: { "User-Agent": API_UA, Connection: "Keep-Alive" }
    }, 6_000);
    if (data?.STATUS !== "0" || typeof data.timestamp !== "number") {
      throw new Error("UCAS 时间戳响应无效");
    }
    return data.timestamp;
  }
}
