import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocketServer } from "ws";
import { createGateway, splitReply } from "../src/qq/gateway.mjs";
import { createInbox } from "../src/qq/inbox.mjs";

async function until(predicate, timeoutMs = 5000) {
  const start = Date.now();
  while (!await predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("等待模拟网关超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("本地模拟 QQ WebSocket 完成鉴权、私聊去重、群消息隔离及断线恢复", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-gateway-test-"));
  const inbox = createInbox({ directory, appId: "test", secret: randomBytes(32).toString("hex") });
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const packets = [];
  const actions = [];
  const replies = [];
  const statuses = [];
  let latest;
  server.on("connection", (ws) => {
    latest = ws;
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }));
    ws.on("message", (raw) => {
      const packet = JSON.parse(raw.toString());
      packets.push(packet);
      if (packet.op === 2) ws.send(JSON.stringify({ op: 0, t: "READY", s: 1, d: { session_id: "test-session" } }));
      if (packet.op === 6) ws.send(JSON.stringify({ op: 0, t: "RESUMED", s: 5, d: {} }));
      if (packet.op === 1) ws.send(JSON.stringify({ op: 11 }));
    });
  });
  const gateway = createGateway({
    api: { getGateway: async () => `ws://127.0.0.1:${server.address().port}`, getToken: async () => "test-token" },
    store: { setRuntimeStatus: async (value) => { statuses.push(value); } },
    inbox,
    handleCommand: async (data) => { actions.push(data); return "处理成功"; },
    send: async (...args) => { replies.push(args); },
    reconnectMs: 10
  });
  try {
    await gateway.start();
    await until(() => statuses.some((value) => value.connected));
    assert.equal(packets[0].d.intents, 1 << 25);
    assert.equal(packets[0].d.token, "QQBot test-token");
    assert.deepEqual(packets[0].d.shard, [0, 1]);
    latest.send("invalid-json");
    const data = { id: "event-1", author: { user_openid: "student-qq" }, content: "关闭打卡 20260001" };
    latest.send(JSON.stringify({ op: 0, t: "C2C_MESSAGE_CREATE", s: 2, d: data }));
    latest.send(JSON.stringify({ op: 0, t: "C2C_MESSAGE_CREATE", s: 3, d: data }));
    latest.send(JSON.stringify({ op: 0, t: "GROUP_AT_MESSAGE_CREATE", s: 4, d: { ...data, id: "group-event" } }));
    await until(() => replies.length === 1);
    await gateway.idle();
    assert.deepEqual(actions, [{ userId: "student-qq", content: "关闭打卡 20260001" }]);
    assert.deepEqual(replies[0], ["student-qq", "处理成功", { msgId: "event-1", msgSeq: 1 }]);
    latest.terminate();
    await until(() => packets.some((packet) => packet.op === 6));
    const resume = packets.find((packet) => packet.op === 6);
    assert.equal(resume.d.session_id, "test-session");
    assert.equal(resume.d.seq, 4);
    await until(() => packets.some((packet) => packet.op === 1), 2500);
  } finally {
    await gateway.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
    if (resolve(directory).startsWith(resolve(tmpdir()))) await rm(directory, { recursive: true, force: true });
  }
});

test("空回复完成收据但不发送，重复 packet 不会再次执行指令", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-empty-reply-test-"));
  const inbox = createInbox({ directory, appId: "test", secret: randomBytes(32).toString("hex") });
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  let ws;
  let connected = false;
  let executions = 0;
  let sends = 0;
  server.on("connection", (socket) => {
    ws = socket;
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }));
    socket.on("message", (raw) => {
      const packet = JSON.parse(raw.toString());
      if (packet.op === 2) socket.send(JSON.stringify({ op: 0, t: "READY", s: 1, d: { session_id: "empty-session" } }));
      if (packet.op === 1) socket.send(JSON.stringify({ op: 11 }));
    });
  });
  const gateway = createGateway({
    api: { getGateway: async () => `ws://127.0.0.1:${server.address().port}`, getToken: async () => "test" },
    store: { setRuntimeStatus: async (value) => { connected = value.connected; } },
    inbox,
    handleCommand: async () => { executions += 1; return ""; },
    send: async () => { sends += 1; },
    replyRetryMs: 20
  });
  try {
    await gateway.start();
    await until(() => connected);
    const data = { id: "empty-command", author: { user_openid: "user" }, content: "管理员帮助" };
    ws.send(JSON.stringify({ op: 0, t: "C2C_MESSAGE_CREATE", s: 2, d: data }));
    ws.send(JSON.stringify({ op: 0, t: "C2C_MESSAGE_CREATE", s: 3, d: data }));
    await until(() => executions === 1);
    await until(async () => (await inbox.pending()).length === 0);
    await gateway.idle();
    assert.equal(executions, 1);
    assert.equal(sends, 0, "空回复不应发送 QQ 消息");
    assert.equal((await inbox.pending()).length, 0, "空回复应完成并清除待处理回执");
  } finally {
    await gateway.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
    if (resolve(directory).startsWith(resolve(tmpdir()))) await rm(directory, { recursive: true, force: true });
  }
});

test("QQ 回复失败后重试加密 outbox，重复事件不会再次执行管理指令", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-reply-test-"));
  const inbox = createInbox({ directory, appId: "test", secret: randomBytes(32).toString("hex") });
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  let ws;
  let connected = false;
  let executions = 0;
  let sends = 0;
  server.on("connection", (socket) => {
    ws = socket;
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }));
    socket.on("message", (raw) => {
      const packet = JSON.parse(raw.toString());
      if (packet.op === 2) socket.send(JSON.stringify({ op: 0, t: "READY", s: 1, d: { session_id: "retry-session" } }));
      if (packet.op === 1) socket.send(JSON.stringify({ op: 11 }));
    });
  });
  const gateway = createGateway({
    api: { getGateway: async () => `ws://127.0.0.1:${server.address().port}`, getToken: async () => "test" },
    store: { setRuntimeStatus: async (value) => { connected = value.connected; } }, inbox,
    handleCommand: async () => { executions++; return "已关闭打卡"; },
    send: async () => { if (++sends === 1) { const error = new Error("timeout"); error.retryable = true; throw error; } },
    replyRetryMs: 20
  });
  try {
    await gateway.start();
    await until(() => connected);
    const d = { id: "retry-command", author: { user_openid: "user" }, content: "关闭打卡 test" };
    ws.send(JSON.stringify({ op: 0, t: "C2C_MESSAGE_CREATE", s: 2, d }));
    await until(() => sends === 1);
    ws.send(JSON.stringify({ op: 0, t: "C2C_MESSAGE_CREATE", s: 3, d }));
    await until(() => sends === 2);
    await gateway.idle();
    assert.equal(executions, 1);
    assert.equal((await inbox.pending()).length, 0);
  } finally {
    await gateway.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
    if (resolve(directory).startsWith(resolve(tmpdir()))) await rm(directory, { recursive: true, force: true });
  }
});

test("长回复最多四条，并按 Unicode 字符切分", () => {
  const parts = splitReply("😀".repeat(3000));
  assert.equal(parts.length, 3);
  assert.equal(parts.join(""), "😀".repeat(3000));
  assert.equal(splitReply("a".repeat(10000)).length, 4);
  const cards = `${"a".repeat(800)}\n${"b".repeat(800)}`;
  assert.equal(splitReply(cards)[0], `${"a".repeat(800)}\n`);
  assert.equal(splitReply(cards).join(""), cards);
});
