const API_ORIGIN = "https://api.bot.qq.com";
const TOKEN_ERRORS = new Set([11243, 11244]);
const TEMPORARY_ERRORS = new Set([100001, 40034100, 40054006, 40054016, 50055002]);

export class QqApiError extends Error {
  constructor({ status = 0, code = 0, retryAfterMs = 0, retryable = false } = {}) {
    // QQ can put user content in its error messages. Never propagate that text.
    super(`QQ 接口错误（HTTP ${status}，代码 ${code}）`);
    this.name = "QqApiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

export class QqClient {
  constructor({ appId, appSecret, fetchImpl = fetch, timeoutMs = 15_000, now = Date.now, signal }) {
    if (!/^\d+$/.test(appId ?? "") || !appSecret) throw new Error("请配置 QQ 机器人 AppID 和 AppSecret");
    this.appId = appId;
    this.appSecret = appSecret;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.signal = signal;
    this.token = "";
    this.expiresAt = 0;
    this.refreshing = null;
  }

  async request(path, { method = "GET", body, token } = {}) {
    let response;
    let data;
    try {
      response = await this.fetchImpl(`${API_ORIGIN}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `QQBot ${token}` } : {})
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
        redirect: "error"
      });
    } catch {
      throw new QqApiError({ retryable: true });
    }
    const retryHeader = response.headers.get("retry-after");
    const seconds = retryHeader == null ? NaN : Number(retryHeader);
    const retryAfterMs = Number.isFinite(seconds)
      ? Math.max(0, seconds * 1000)
      : Math.max(0, (Date.parse(retryHeader ?? "") || this.now()) - this.now());
    try {
      data = await response.json();
    } catch {
      throw new QqApiError({ status: response.status, retryAfterMs, retryable: response.status === 429 || response.status >= 500 });
    }
    const code = Number(data?.code ?? 0);
    if (!response.ok || code) {
      throw new QqApiError({
        status: response.status, code, retryAfterMs,
        retryable: response.status === 429 || response.status >= 500 || TEMPORARY_ERRORS.has(code)
      });
    }
    return data;
  }

  async getToken() {
    if (this.token && this.now() < this.expiresAt) return this.token;
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const data = await this.request("/app/getAppAccessToken", {
          method: "POST", body: { appId: this.appId, clientSecret: this.appSecret }
        });
        const lifetime = Number(data?.expires_in);
        if (!data?.access_token || !Number.isFinite(lifetime) || lifetime <= 0) throw new QqApiError();
        this.token = data.access_token;
        this.expiresAt = this.now() + Math.max(1, lifetime - Math.min(60, lifetime / 2)) * 1000;
        return this.token;
      })().finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  async call(path, options = {}) {
    const token = await this.getToken();
    try {
      return await this.request(path, { ...options, token });
    } catch (error) {
      // An explicit authentication rejection is safe to retry; a transport
      // timeout is ambiguous and must go through the persisted delivery policy.
      if (error.status !== 401 && !TOKEN_ERRORS.has(error.code)) throw error;
      if (this.token === token) { this.token = ""; this.expiresAt = 0; }
      return this.request(path, { ...options, token: await this.getToken() });
    }
  }

  async getGateway() {
    const data = await this.call("/gateway");
    let url;
    try { url = new URL(data?.url); } catch { throw new QqApiError(); }
    if (url.protocol !== "wss:" || !url.hostname.endsWith(".qq.com") || url.username || url.password) {
      throw new QqApiError();
    }
    return url.href;
  }

  async sendMessage(userId, content, { msgId, msgSeq = 1 } = {}) {
    if (typeof userId !== "string" || !userId || userId.length > 200) throw new QqApiError();
    const body = { msg_type: 0, content: String(content) };
    if (msgId) { body.msg_id = msgId; body.msg_seq = msgSeq; }
    const data = await this.call(`/v2/users/${encodeURIComponent(userId)}/messages`, { method: "POST", body });
    if (!data?.id) throw new QqApiError();
    return data;
  }
}

export function createPacedSender(client, { intervalMs = 2100, now = Date.now, signal, wait = (ms) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new QqApiError({ retryable: true })); return; }
  const onAbort = () => { clearTimeout(timer); reject(new QqApiError({ retryable: true })); };
  const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
}) } = {}) {
  const recipients = new Map();
  return (userId, content, options) => {
    const requestedAt = now();
    for (const [id, recipient] of recipients) {
      if (!recipient.tail && recipient.nextAt <= requestedAt) recipients.delete(id);
    }
    const recipient = recipients.get(userId) ?? { nextAt: 0, tail: undefined };
    recipients.set(userId, recipient);
    const result = (recipient.tail ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (signal?.aborted) throw new QqApiError({ retryable: true });
      const delay = Math.max(0, recipient.nextAt - now());
      if (delay) await wait(delay);
      if (typeof options?.beforeSend === "function") await options.beforeSend();
      if (signal?.aborted) throw new QqApiError({ retryable: true });
      recipient.nextAt = now() + intervalMs;
      try {
        return await client.sendMessage(userId, content, options);
      } catch (error) {
        if (Number.isFinite(error?.retryAfterMs) && error.retryAfterMs > 0) {
          recipient.nextAt = Math.max(recipient.nextAt, now() + error.retryAfterMs);
        }
        throw error;
      }
    }).finally(() => {
      if (recipient.tail !== result) return;
      recipient.tail = undefined;
      if (recipient.nextAt <= now()) recipients.delete(userId);
    });
    recipient.tail = result;
    return result;
  };
}
