import test from "node:test";
import assert from "node:assert/strict";
import { QqClient, QqApiError, createPacedSender } from "../src/qq/client.mjs";

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}

test("QQ 凭证缓存、并发刷新和私聊请求遵循官方接口", async () => {
  const calls = [];
  const client = new QqClient({ appId: "123", appSecret: "private-test-secret", fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("getAppAccessToken")) return json({ access_token: "access-one", expires_in: "7200" });
    if (url.endsWith("/gateway")) return json({ url: "wss://api.bot.qq.com/websocket/" });
    return json({ id: "reply-id" });
  } });
  assert.deepEqual(await Promise.all([client.getToken(), client.getToken()]), ["access-one", "access-one"]);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].options.body), { appId: "123", clientSecret: "private-test-secret" });
  assert.equal(await client.getGateway(), "wss://api.bot.qq.com/websocket/");
  await client.sendMessage("user/one", "签到成功", { msgId: "incoming", msgSeq: 2 });
  const sent = calls.at(-1);
  assert.equal(sent.url, "https://api.bot.qq.com/v2/users/user%2Fone/messages");
  assert.equal(sent.options.headers.Authorization, "QQBot access-one");
  assert.deepEqual(JSON.parse(sent.options.body), { msg_type: 0, content: "签到成功", msg_id: "incoming", msg_seq: 2 });
  await client.sendMessage("user", "主动通知");
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { msg_type: 0, content: "主动通知" });
});

test("QQ HTTP 200 业务错误仍被拒绝且不会泄露服务端文本或密钥", async () => {
  const client = new QqClient({ appId: "123", appSecret: "secret-test", fetchImpl: async () => json({ code: 100016, message: "secret-test wrong" }) });
  await assert.rejects(client.getToken(), (error) => {
    assert.ok(error instanceof QqApiError);
    assert.equal(error.code, 100016);
    assert.equal(error.retryable, false);
    assert.equal(error.message.includes("secret-test"), false);
    return true;
  });
});

test("非 JSON 的永久 HTTP 错误不重试，非 JSON 的 5xx 可有限重试", async () => {
  for (const status of [400, 403, 503]) {
    const client = new QqClient({ appId: "123", appSecret: "secret", fetchImpl: async () => new Response("not-json", { status }) });
    await assert.rejects(client.getToken(), (error) => error.status === status && error.retryable === (status >= 500));
  }
});

test("显式凭证失效只刷新重试一次，拒收不重试，频控保留 Retry-After", async () => {
  let tokens = 0;
  let requests = 0;
  let outcome = "expired";
  const client = new QqClient({ appId: "123", appSecret: "secret", fetchImpl: async (url) => {
    if (url.endsWith("getAppAccessToken")) return json({ access_token: `token-${++tokens}`, expires_in: 7200 });
    requests++;
    if (outcome === "expired" && requests === 1) return json({ code: 11244 }, 401);
    if (outcome === "refused") return json({ code: 40054013, message: "private content" });
    if (outcome === "rate") return json({ code: 40034100 }, 429, { "retry-after": "12" });
    return json({ id: "ok" });
  } });
  await client.sendMessage("user", "x");
  assert.equal(tokens, 2);
  assert.equal(requests, 2);
  outcome = "refused";
  await assert.rejects(client.sendMessage("user", "x"), (error) => error.code === 40054013 && !error.retryable && !error.message.includes("private"));
  assert.equal(requests, 3);
  outcome = "rate";
  await assert.rejects(client.sendMessage("user", "x"), (error) => error.retryable && error.retryAfterMs === 12_000);
});

test("token 到期前刷新，网关不能把 token 发送到第三方主机", async () => {
  let now = 0;
  let tokens = 0;
  const client = new QqClient({ appId: "123", appSecret: "secret", now: () => now, fetchImpl: async (url) => {
    if (url.endsWith("getAppAccessToken")) return json({ access_token: `token-${++tokens}`, expires_in: 120 });
    return json({ url: "wss://attacker.example/websocket" });
  } });
  await client.getToken();
  now = 61_000;
  await client.getToken();
  assert.equal(tokens, 2);
  await assert.rejects(client.getGateway(), QqApiError);
});

test("同一 QQ 保持发送间隔，另一个 QQ 无需等前一条消息", async () => {
  let clock = 0;
  const times = [];
  const sender = createPacedSender({ sendMessage: async (user, content) => {
    times.push([user, clock]);
    if (content === "bad") throw new Error("test");
    return content;
  } }, { intervalMs: 2100, now: () => clock, wait: async (ms) => { clock += ms; } });
  const results = await Promise.allSettled([sender("first", "bad"), sender("other", "good"), sender("first", "last")]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[2].value, "last");
  assert.deepEqual(times, [["first", 0], ["other", 0], ["first", 2100]]);
});

test("排队期间撤回授权后，在实际 HTTP 发送前再次检查并停止投递", async () => {
  let allowed = true;
  const sent = [];
  const sender = createPacedSender({ sendMessage: async (user) => { sent.push(user); } }, {
    intervalMs: 100, now: () => 0, wait: async () => { allowed = false; }
  });
  await sender("first", "x");
  await assert.rejects(sender("first", "x", { beforeSend: async () => {
    if (!allowed) throw new Error("revoked");
  } }), /revoked/);
  assert.deepEqual(sent, ["first"]);
});
