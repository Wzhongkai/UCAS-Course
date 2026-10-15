import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInbox } from "../src/qq/inbox.mjs";

const inboxModuleUrl = pathToFileURL(fileURLToPath(new URL("../src/qq/inbox.mjs", import.meta.url))).href;
const recoveryReply = "上次指令执行中断，结果可能已生效，请查看账号状态后重新发送。";

test("收件箱去重、加密回复和分片确认", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ucas-qq-inbox-"));
  const secret = "0123456789abcdef".repeat(4);
  const inbox = createInbox({ directory, appId: "app/one", secret });
  const file = join(directory, "qq-app_one.inbox.json");
  try {
    assert.deepEqual(await inbox.begin({ id: "message-1", userId: "qq-user" }), { execute: true });
    assert.deepEqual(await inbox.begin({ id: "message-1", userId: "qq-user" }), { done: true });

    const replyText = "绑定码=BINDCODE1234；密码=PASSWORD123";
    const delivery = await inbox.complete("message-1", replyText);
    assert.deepEqual(delivery, {
      id: "message-1",
      userId: "qq-user",
      reply: replyText,
      sentParts: 0,
      createdAt: delivery.createdAt
    });
    assert.equal((await inbox.begin({ id: "message-1", userId: "qq-user" })).reply, replyText);

    const raw = await readFile(file, "utf8");
    assert.equal(raw.includes("BINDCODE1234"), false);
    assert.equal(raw.includes("PASSWORD123"), false);
    await assert.rejects(createInbox({ directory, appId: "app/one", secret: "f".repeat(64) }).pending(), /密钥不匹配/);

    await inbox.ack("message-1", 1, 2);
    assert.equal((await inbox.pending()).find(({ id }) => id === "message-1").sentParts, 1);
    await inbox.ack("message-1", 1, 2);
    assert.equal((await inbox.pending()).find(({ id }) => id === "message-1").sentParts, 1, "重复确认不能重复计数");
    await inbox.ack("message-1", 2, 2);
    assert.equal((await inbox.pending()).some(({ id }) => id === "message-1"), false);
    assert.deepEqual(await inbox.begin({ id: "message-1", userId: "qq-user" }), { done: true });

    const otherApp = createInbox({ directory, appId: "app-two", secret });
    assert.deepEqual(await otherApp.begin({ id: "message-1", userId: "qq-user" }), { execute: true });
  } finally {
    if (resolve(directory).startsWith(resolve(tmpdir()))) await rm(directory, { recursive: true, force: true });
  }
});

test("重启恢复、五分钟回复过期和24小时收据清理", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ucas-qq-inbox-recovery-"));
  const secret = "abcdef0123456789".repeat(4);
  const file = join(directory, "qq-restart.inbox.json");
  try {
    const childScript = `const { createInbox } = await import(${JSON.stringify(inboxModuleUrl)}); const inbox = createInbox({ directory: process.argv[1], appId: "restart", secret: process.env.INBOX_TEST_SECRET }); await inbox.begin({ id: "crashed-message", userId: "qq-recovery-user" });`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", childScript, directory], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, INBOX_TEST_SECRET: secret }
    });
    const exitCode = await new Promise((resolvePromise, rejectPromise) => {
      child.once("error", rejectPromise);
      child.once("exit", resolvePromise);
    });
    assert.equal(exitCode, 0);

    const inbox = createInbox({ directory, appId: "restart", secret });
    const recovered = await inbox.pending();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].id, "crashed-message");
    assert.equal(recovered[0].reply, recoveryReply);
    assert.equal((await inbox.begin({ id: "crashed-message", userId: "qq-recovery-user" })).reply, recoveryReply);

    const shortLived = await inbox.complete("crashed-message", "temporary reply");
    assert.equal(shortLived.reply, recoveryReply, "恢复收据不可被迟到的执行结果覆盖");
    let state = JSON.parse(await readFile(file, "utf8"));
    state.receipts["crashed-message"].expiresAt = Date.now() - 1;
    await writeFile(file, JSON.stringify(state));
    assert.deepEqual(await inbox.pending(), []);
    assert.deepEqual(await inbox.begin({ id: "crashed-message", userId: "qq-recovery-user" }), { done: true });

    state = JSON.parse(await readFile(file, "utf8"));
    state.receipts["crashed-message"].at = Date.now() - 24 * 60 * 60 * 1000 - 1;
    await writeFile(file, JSON.stringify(state));
    assert.deepEqual(await inbox.begin({ id: "crashed-message", userId: "qq-recovery-user" }), { execute: true });
  } finally {
    if (resolve(directory).startsWith(resolve(tmpdir()))) await rm(directory, { recursive: true, force: true });
  }
});

test("收件箱达到上限时返回固定忙碌回复且不执行新指令", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ucas-qq-inbox-cap-"));
  const secret = "0123abcd".repeat(8);
  const inbox = createInbox({ directory, appId: "cap", secret });
  const file = join(directory, "qq-cap.inbox.json");
  try {
    const receipts = Object.fromEntries(Array.from({ length: 5_000 }, (_, index) => [`queued-${index}`, {
      id: `queued-${index}`,
      userId: "qq-user",
      pid: process.pid,
      at: Date.now(),
      state: "processing"
    }]));
    await writeFile(file, JSON.stringify({ version: 1, receipts }));
    const result = await inbox.begin({ id: "overflow", userId: "qq-user" });
    assert.equal(result.id, "overflow");
    assert.equal(result.reply, "当前消息较多，请稍后重试。");
    const state = JSON.parse(await readFile(file, "utf8"));
    assert.equal(Object.hasOwn(state.receipts, "overflow"), false);
    assert.equal(Object.keys(state.receipts).length, 5_000);
  } finally {
    if (resolve(directory).startsWith(resolve(tmpdir()))) await rm(directory, { recursive: true, force: true });
  }
});
