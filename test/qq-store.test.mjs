import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createQqStore } from "../src/qq/store.mjs";

test("不同 QQ 并行投递，同一 QQ 的下一条等前一条完成", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ucas-qq-lanes-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createQqStore({ directory, appId: "lanes" });
  await store.bindVerified("user-a", "account-a");
  await store.bindVerified("user-b", "account-b");
  for (const [content, accountId] of [["a1", "account-a"], ["a2", "account-a"], ["b1", "account-b"]]) {
    await store.enqueueNotification({ id: content, accountId, content, kind: "success" });
  }
  const first = Promise.withResolvers();
  const firstStarted = Promise.withResolvers();
  const other = Promise.withResolvers();
  const delivered = [];
  const running = store.drainNotifications({ concurrency: 2, send: async (_user, content) => {
    delivered.push(content);
    if (content === "a1") { firstStarted.resolve(); await first.promise; }
    if (content === "b1") other.resolve();
  } });
  const deadlineReached = Promise.withResolvers();
  const deadline = setTimeout(() => deadlineReached.reject(new Error("第二个 QQ 的消息未并行发送")), 3_000);
  try {
    await Promise.race([Promise.all([firstStarted.promise, other.promise]), deadlineReached.promise]);
    assert.deepEqual(delivered.toSorted(), ["a1", "b1"]);
  } finally {
    clearTimeout(deadline);
    first.resolve();
    await running;
  }
  assert.equal(delivered.at(-1), "a2");
});

test("发送轮次结束后遗留的本进程租约立即恢复，活跃租约仍防止重复发送", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ucas-qq-orphan-lease-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const open = () => createQqStore({ directory, appId: "orphan-lease", adminOpenids: [] });
  const store = open();
  await store.bindVerified("user", "account");
  const notification = (id) => ({ id, accountId: "account", kind: "success", content: id });
  await store.enqueueNotification(notification("already-sent"));
  await store.drainNotifications({ send: async () => {} });
  await store.enqueueNotification(notification("next-message"));
  const file = join(directory, "qq-orphan-lease.json");
  const state = JSON.parse(await readFile(file, "utf8"));
  state.senderLease = { token: "ended-drain", pid: process.pid, expiresAt: Date.now() + 300_000 };
  await writeFile(file, JSON.stringify(state));

  const delivered = [];
  const result = await store.drainNotifications({ send: async (_user, content) => {
    const competingDrain = await open().drainNotifications({ send: async () => assert.fail("live lease was taken") });
    assert.equal(competingDrain.pending, 1);
    delivered.push(content);
  } });
  assert.equal(result.sent, 1);
  assert.deepEqual(delivered, ["next-message"]);
  assert.equal(JSON.parse(await readFile(file, "utf8")).senderLease, null);
});

test("过期的即将签到提醒不会在恢复网络后迟发", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ucas-qq-expiry-"));
  const store = createQqStore({ directory, appId: "expiry", adminOpenids: [] });
  try {
    const code = await store.createBindingCode("account");
    await store.bind("user", code.code);
    assert.equal(await store.enqueueNotification({ id: "already-expired", accountId: "account", kind: "upcoming", content: "即将签到", expiresAt: Date.now() - 1 }), false);
    await store.enqueueNotification({ id: "expired-in-queue", accountId: "account", kind: "upcoming", content: "即将签到", expiresAt: Date.now() + 60_000 });
    const file = join(directory, "qq-expiry.json");
    const state = JSON.parse(await readFile(file, "utf8"));
    state.notifications[0].expiresAt = Date.now() - 1;
    await writeFile(file, JSON.stringify(state));
    let sent = false;
    const result = await store.drainNotifications({ send: async () => { sent = true; } });
    assert.equal(sent, false);
    assert.equal(result.skipped, 1);
    assert.equal(result.pending, 0);
  } finally {
    if (resolve(directory).startsWith(resolve(tmpdir()))) await rm(directory, { recursive: true, force: true });
  }
});

test("QQ 存储持久化授权、绑定、去重和通知队列", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ucas-qq-store-"));
  const bootstrapToken = "temporary-bootstrap-secret";
  const store = createQqStore({ directory, appId: "client/blue", bootstrapToken, adminOpenids: [] });
  const file = join(directory, "qq-client_blue.json");
  try {
    assert.equal(await store.isAdmin("qq-admin"), false);
    assert.equal(await store.claimAdmin("qq-admin", "wrong-token"), false);
    assert.equal(await store.claimAdmin("qq-admin", bootstrapToken), false);
    await store.recordInbound("seed-legacy-admin-state");
    const legacyState = JSON.parse(await readFile(file, "utf8"));
    legacyState.admins = ["qq-admin"];
    legacyState.bootstrapClaimed = true;
    await writeFile(file, JSON.stringify(legacyState));
    assert.equal(await store.isAdmin("qq-admin"), false, "空环境名单也应忽略持久化 legacy admins");
    const envAdminStore = createQqStore({
      directory, appId: "client/blue", bootstrapToken, adminOpenids: ["qq-env-admin"]
    });
    assert.equal(await envAdminStore.isAdmin("qq-env-admin"), true);
    assert.equal(await envAdminStore.isAdmin("qq-admin"), false, "非空环境名单应覆盖持久化旧名单");
    assert.equal(await envAdminStore.claimAdmin("another-user", bootstrapToken), false);
    const emptyAdminStore = createQqStore({ directory, appId: "client/blue", bootstrapToken, adminOpenids: [] });
    assert.equal(await emptyAdminStore.isAdmin("qq-env-admin"), false, "清空环境名单应撤销所有管理员权限");
    assert.equal(await emptyAdminStore.isAdmin("qq-admin"), false, "清空环境名单不能恢复旧 bootstrap 管理员");

    const staleCode = await store.createBindingCode("20260001");
    const firstCode = await store.createBindingCode("20260001");
    await assert.rejects(store.bind("qq-user-a", staleCode.code), /无效或已过期/);
    assert.deepEqual(await store.bind("qq-user-a", firstCode.code), { accountId: "20260001" });
    await assert.rejects(store.bind("qq-user-a", firstCode.code), /无效或已过期/);

    const secondCode = await store.createBindingCode("20260002");
    await assert.rejects(store.bind("qq-user-a", secondCode.code), /该 QQ 已绑定其他学号/);
    await store.bind("qq-user-d", secondCode.code);
    assert.equal((await store.listBindings("qq-user-a")).length, 1);

    const replacementCode = await store.createBindingCode("20260001");
    await store.bind("qq-user-b", replacementCode.code);
    assert.equal((await store.getBindings("20260001")).length, 2);
    await store.unbind("20260001", "qq-user-a");
    assert.deepEqual(await store.getBinding("20260001"), { userId: "qq-user-b", mode: "all" });
    assert.deepEqual(await store.listBindings("qq-user-a"), []);

    await store.setPreference("20260002", "failure");
    assert.equal(await store.enqueueNotification({ id: "filtered-success", accountId: "20260002", kind: "success", content: "ok" }), false);
    assert.equal(await store.enqueueNotification({ id: "event-failure", accountId: "20260002", kind: "failure", content: "failed" }), true);
    assert.equal(await store.enqueueNotification({ id: "event-failure", accountId: "20260002", kind: "failure", content: "duplicate" }), false);
    assert.equal(await store.enqueueNotification({ id: "event-schedule-error", accountId: "20260002", kind: "schedule_error", content: "schedule failed" }), true);
    assert.equal(await store.enqueueNotification({ id: "filtered-daily", accountId: "20260002", kind: "daily_done", content: "done" }), false);
    assert.equal(await store.enqueueNotification({ id: "filtered-upcoming", accountId: "20260002", kind: "upcoming", content: "upcoming" }), false);
    await store.setPreference("20260002", "all");
    assert.equal(await store.enqueueNotification({ id: "event-upcoming", accountId: "20260002", kind: "upcoming", content: "upcoming" }), true);

    await store.unbind("20260002");
    assert.equal((await store.getSummary()).pending, 0);

    assert.equal(await store.recordInbound("inbound-1"), true);
    const reopenedStore = createQqStore({ directory, appId: "client/blue", bootstrapToken: "different-runtime-secret", adminOpenids: [] });
    assert.equal(await reopenedStore.recordInbound("inbound-1"), false);
    assert.equal(await reopenedStore.recordInbound("inbound-2"), true);

    assert.equal(await store.enqueueNotification({ id: "send-success", accountId: "20260001", kind: "success", content: "signed in" }), true);
    const sent = [];
    const drainResult = await store.drainNotifications({
      send: async (userId, content, metadata) => {
        sent.push({ userId, content, metadata });
        await store.setRuntimeStatus({ state: "sending", accessToken: "must-not-persist", note: bootstrapToken });
      }
    });
    assert.equal(drainResult.sent, 1);
    assert.deepEqual(sent, [{
      userId: "qq-user-b",
      content: "signed in",
      metadata: { accountId: "20260001", kind: "success" }
    }]);
    assert.equal(await store.getRuntimeStatus().then((status) => status.accessToken), "[已隐藏]");
    assert.equal(await store.getRuntimeStatus().then((status) => status.note), "[已隐藏]");

    assert.equal(await store.enqueueNotification({ id: "retry-event", accountId: "20260001", kind: "failure", content: "retry me" }), true);
    let attempts = 0;
    const firstDrain = await store.drainNotifications({
      send: async () => {
        attempts += 1;
        const error = new Error("temporary network issue");
        error.retryable = true;
        error.retryAfterMs = 2_500;
        throw error;
      }
    });
    assert.equal(firstDrain.retried, 1);
    assert.equal(firstDrain.pending, 1);
    const retryState = JSON.parse(await readFile(file, "utf8"));
    const retryRow = retryState.notifications.find(({ id }) => id === "retry-event");
    assert.ok(retryRow.nextAttemptAt >= Date.now() + 2_000, "应尊重服务端 Retry-After 时间");
    retryRow.nextAttemptAt = Date.now();
    await writeFile(file, JSON.stringify(retryState));
    const secondDrain = await store.drainNotifications({ send: async () => { attempts += 1; } });
    assert.equal(secondDrain.sent, 1);
    assert.equal(attempts, 2);

    await store.enqueueNotification({ id: "permission-event", accountId: "20260001", kind: "failure", content: "reject me" });
    const rejected = await store.drainNotifications({
      send: async () => {
        const error = new Error("permission denied");
        error.status = 403;
        throw error;
      }
    });
    assert.equal(rejected.failed, 1);

    const summary = await store.getSummary();
    assert.equal(summary.sent, 2);
    assert.equal(summary.failed, 1);
    assert.equal(summary.pending, 0);
    assert.equal(summary.bindings.find((binding) => binding.accountId === "20260001").userHint.includes("qq-user-b"), false);

    await store.enqueueNotification({ id: "removed-account", accountId: "20260001", kind: "success", content: "must be cancelled" });
    await store.unbind("20260001");
    let sentRemoved = false;
    await store.drainNotifications({ send: async () => { sentRemoved = true; } });
    assert.equal(sentRemoved, false);

    const raw = await readFile(file, "utf8");
    assert.equal(raw.includes(bootstrapToken), false);
    assert.equal(raw.includes(firstCode.code), false);
    assert.equal(raw.includes(replacementCode.code), false);
    assert.equal(raw.includes("must-not-persist"), false);
    assert.equal(raw.includes("qq-user-b"), true, "绑定关系需持久保存供后续消息路由");
  } finally {
    if (resolve(directory).startsWith(resolve(tmpdir()))) await rm(directory, { recursive: true, force: true });
  }
});

test("已验证绑定支持共享学号，所有角色的 QQ 只能绑定一个学号", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ucas-qq-verified-bind-"));
  const store = createQqStore({ directory, appId: "verified", adminOpenids: [] });
  try {
    assert.deepEqual(await store.bindVerified("qq-user-a", "20260001"), { accountId: "20260001" });
    await store.setPreference("20260001", "failure");
    assert.deepEqual(await store.bindVerified("qq-user-a", "20260001"), { accountId: "20260001" });
    assert.deepEqual(await store.getBinding("20260001"), { userId: "qq-user-a", mode: "failure" }, "重复绑定应保留偏好");
    await store.bindVerified("qq-user-b", "20260001");
    assert.deepEqual(await store.getBinding("20260001", "qq-user-a"), { userId: "qq-user-a", mode: "failure" });
    assert.deepEqual(await store.getBinding("20260001", "qq-user-b"), { userId: "qq-user-b", mode: "all" });
    await assert.rejects(store.bindVerified("qq-user-a", "20260002"), /该 QQ 已绑定其他学号/);
    await assert.rejects(store.bindVerified("qq-user-a", "20260002", { allowMultiple: true }), /该 QQ 已绑定其他学号/);
    await assert.rejects(store.bindVerified("qq-user-b", "20260002", { allowMultiple: true }), /该 QQ 已绑定其他学号/);
    assert.deepEqual((await store.listBindings("qq-user-a")).map(({ accountId }) => accountId), ["20260001"]);
  } finally {
    if (resolve(directory).startsWith(resolve(tmpdir()))) await rm(directory, { recursive: true, force: true });
  }
});

test("管理员模式默认关闭、仅环境管理员可开启并在环境撤销后清除", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ucas-qq-admin-mode-"));
  const store = createQqStore({ directory, appId: "admin-mode", adminOpenids: ["configured-admin", "other-admin"] });
  const file = join(directory, "qq-admin-mode.json");
  try {
    assert.equal(await store.getAdminMode("configured-admin"), false, "环境管理员的模式默认关闭");
    assert.equal(await store.setAdminMode("ordinary-user", true), false, "普通用户不能开启管理员模式");
    assert.equal(await store.getAdminMode("ordinary-user"), false);
    assert.equal(await store.setAdminMode("configured-admin", true), true);
    assert.equal(await store.getAdminMode("configured-admin"), true);

    const reopened = createQqStore({ directory, appId: "admin-mode", adminOpenids: ["configured-admin", "other-admin"] });
    assert.equal(await reopened.getAdminMode("configured-admin"), true, "管理员模式应跨进程重开持久保存");
    const summary = await reopened.getSummary();
    assert.equal(JSON.stringify(summary).includes("configured-admin"), false, "summary 不得泄露管理员 OpenID");

    assert.equal(await reopened.setAdminMode("configured-admin", false), false, "管理员可以退出模式");
    assert.equal(await reopened.getAdminMode("configured-admin"), false);
    assert.equal(await reopened.setAdminMode("configured-admin", true), true);

    const persisted = JSON.parse(await readFile(file, "utf8"));
    persisted.adminModes["ordinary-user"] = true;
    persisted.adminModes["other-admin"] = false;
    await writeFile(file, JSON.stringify(persisted));
    const revoked = createQqStore({ directory, appId: "admin-mode", adminOpenids: ["other-admin"] });
    assert.equal(await revoked.getAdminMode("configured-admin"), false, "撤销 env 管理员后模式立即失效");
    assert.equal(await revoked.getAdminMode("other-admin"), false);
    const pruned = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(pruned.adminModes, {}, "mode 操作应清除过期、非管理员和非 true 条目");
  } finally {
    if (resolve(directory).startsWith(resolve(tmpdir()))) await rm(directory, { recursive: true, force: true });
  }
});

test("通知队列和去重记录有界，过多崩溃尝试会终止", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ucas-qq-limits-"));
  const store = createQqStore({ directory, appId: "limits", bootstrapToken: "", adminOpenids: [] });
  const file = join(directory, "qq-limits.json");
  try {
    const code = await store.createBindingCode("20260009");
    await store.bind("qq-limits-user", code.code);
    const now = Date.now();
    const old = now - 15 * 24 * 60 * 60 * 1000;
    const state = JSON.parse(await readFile(file, "utf8"));
    state.notifications = Array.from({ length: 1_000 }, (_, index) => ({
      id: `pending-${index}`,
      accountId: "20260009",
      userId: "qq-limits-user",
      kind: "failure",
      content: "pending",
      status: "pending",
      attempts: 0,
      nextAttemptAt: now + 60_000,
      createdAt: old
    }));
    state.notificationIds = { "pending-0": old, "old-terminal": old };
    await writeFile(file, JSON.stringify(state));

    assert.equal(await store.enqueueNotification({ id: "queue-full-event", accountId: "20260009", kind: "failure", content: "overflow" }), false);
    const bounded = JSON.parse(await readFile(file, "utf8"));
    assert.equal(bounded.notifications.filter(({ status }) => ["pending", "sending"].includes(status)).length, 1_000);
    assert.equal(Object.hasOwn(bounded.notificationIds, "old-terminal"), false);
    assert.equal(Object.hasOwn(bounded.notificationIds, "pending-0"), true, "未完成事件的去重记录不能过期清理");
    assert.equal(Object.hasOwn(bounded.notificationIds, "queue-full-event"), true);

    bounded.notifications = [{
      id: "crashed-event",
      accountId: "20260009",
      userId: "qq-limits-user",
      kind: "failure",
      content: "interrupted",
      status: "sending",
      attempts: 5,
      attemptToken: "interrupted",
      leasePid: 2_147_483_647,
      leaseUntil: now + 60_000
    }];
    bounded.notificationIds["crashed-event"] = now;
    bounded.notificationStats = { sent: 0, failed: 0 };
    bounded.senderLease = { token: "dead-sender", pid: 2_147_483_647, expiresAt: now + 60_000 };
    await writeFile(file, JSON.stringify(bounded));
    let sent = false;
    const result = await store.drainNotifications({ send: async () => { sent = true; } });
    assert.equal(result.failed, 1);
    assert.equal(sent, false, "崩溃恢复次数达到上限后不应继续发送");
    assert.equal((await store.getSummary()).pending, 0);
    assert.equal((await store.getSummary()).failed, 1);
  } finally {
    if (resolve(directory).startsWith(resolve(tmpdir()))) await rm(directory, { recursive: true, force: true });
  }
});
