import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQqStore } from "../src/qq/store.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "qq-multi-binding-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, file: join(directory, "qq-multi.json"), store: createQqStore({ directory, appId: "multi" }) };
}

test("旧版单人绑定与待发送消息可迁移，新增 QQ 不接收旧消息", async (t) => {
  const { store, file } = await fixture(t);
  const now = Date.now();
  await writeFile(file, JSON.stringify({ version: 1,
    bindings: { student: { userId: "qq-original", mode: "failure", boundAt: "2026-10-15T00:00:00Z" } },
    notificationIds: { "legacy-event": now },
    notifications: [{ id: "legacy-event", accountId: "student", userId: "qq-original", kind: "failure", content: "old", status: "pending", attempts: 0, nextAttemptAt: now }]
  }));
  const oldId = (await store.getSummary()).bindings[0].bindingId;
  await store.bindVerified("qq-new", "student");
  assert.deepEqual(await store.getBinding("student", "qq-original"), { userId: "qq-original", mode: "failure" });
  assert.equal((await store.getSummary()).bindings.find((row) => row.bindingId === oldId)?.mode, "failure");
  assert.equal(JSON.parse(await readFile(file, "utf8")).version, 2);
  const sent = [];
  await store.drainNotifications({ send: async (user) => sent.push(user) });
  assert.deepEqual(sent, ["qq-original"]);
  assert.equal(await store.enqueueNotification({ id: "legacy-event", accountId: "student", kind: "failure", content: "repeat" }), false);
  assert.equal(JSON.stringify(await store.getSummary()).includes("qq-original"), false);
});

test("成功和失败通知按每个 QQ 的独立偏好投递并去重", async (t) => {
  const { store } = await fixture(t);
  for (const user of ["qq-all", "qq-failure", "qq-off"]) await store.bindVerified(user, "student");
  await store.setPreference("student", "failure", "qq-failure");
  await store.setPreference("student", "off", "qq-off");
  const event = (id, kind) => ({ id, kind, accountId: "student", content: id });
  assert.equal(await store.enqueueNotification(event("success", "success")), true);
  assert.equal(await store.enqueueNotification(event("failure", "failure")), true);
  assert.equal(await store.enqueueNotification(event("failure", "failure")), false);
  const sent = [];
  const result = await store.drainNotifications({ send: async (user, content) => sent.push(`${user}:${content}`) });
  assert.deepEqual(sent.sort(), ["qq-all:failure", "qq-all:success", "qq-failure:failure"]);
  assert.equal(result.sent, 3);
  assert.equal(result.pending, 0);
});

test("一个接收人拒收时其他 QQ 仍收到同一事件", async (t) => {
  const { store } = await fixture(t);
  await store.bindVerified("qq-reject", "student");
  await store.bindVerified("qq-ok", "student");
  await store.enqueueNotification({ id: "failure", accountId: "student", kind: "failure", content: "failure" });
  const received = [];
  const result = await store.drainNotifications({ send: async (user) => {
    if (user === "qq-reject") { const error = new Error("rejected"); error.status = 403; throw error; }
    received.push(user);
  } });
  assert.deepEqual(received, ["qq-ok"]);
  assert.equal(result.failed, 1);
  assert.equal(result.sent, 1);
});

test("单人关闭通知或解绑只取消自己的队列；解绑后可改绑其他学号", async (t) => {
  const { store } = await fixture(t);
  await store.bindVerified("qq-a", "student");
  await store.bindVerified("qq-b", "student");
  await store.enqueueNotification({ id: "one", accountId: "student", kind: "success", content: "one" });
  await store.setPreference("student", "off", "qq-a");
  assert.equal((await store.getSummary()).pending, 1);
  assert.equal((await store.getBinding("student", "qq-b")).mode, "all");
  await store.unbind("student", "qq-a");
  await store.bindVerified("qq-a", "other-student");
  const received = [];
  await store.drainNotifications({ send: async (user) => received.push(user) });
  assert.deepEqual(received, ["qq-b"]);
  assert.equal((await store.listBindings("qq-a"))[0].accountId, "other-student");
});

test("并发操作始终保证一个 QQ 一个学号，同时允许多个 QQ 加入同一学号", async (t) => {
  const { store, directory } = await fixture(t);
  const otherProcess = createQqStore({ directory, appId: "multi" });
  const results = await Promise.allSettled([store.bindVerified("qq-a", "one"), otherProcess.bindVerified("qq-a", "two")]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const accountId = (await store.listBindings("qq-a"))[0].accountId;
  await Promise.all([store.bindVerified("qq-b", accountId), otherProcess.bindVerified("qq-c", accountId)]);
  await store.bindVerified("qq-b", accountId);
  assert.equal((await store.getBindings(accountId)).length, 3);
  const code = await store.createBindingCode("other");
  await assert.rejects(store.bind("qq-b", code.code), /已绑定其他学号/u);
});

test("多接收人的未完成事件保留去重记录，测试通知只发给指定 QQ", async (t) => {
  const { store, file } = await fixture(t);
  await store.bindVerified("qq-a", "student");
  await store.bindVerified("qq-b", "student");
  await store.enqueueNotification({ id: "shared", accountId: "student", kind: "success", content: "shared" });
  const state = JSON.parse(await readFile(file, "utf8"));
  state.notificationIds.shared = Date.now() - 15 * 24 * 60 * 60_000;
  await writeFile(file, JSON.stringify(state));
  await store.enqueueNotification({ id: "test", accountId: "student", userId: "qq-a", kind: "failure", content: "test" });
  assert.ok(Object.hasOwn(JSON.parse(await readFile(file, "utf8")).notificationIds, "shared"));
  const sent = [];
  await store.drainNotifications({ send: async (user, content) => sent.push(`${user}:${content}`) });
  assert.deepEqual(sent.sort(), ["qq-a:shared", "qq-a:test", "qq-b:shared"]);
});
