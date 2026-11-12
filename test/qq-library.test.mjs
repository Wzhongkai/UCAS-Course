import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCommandHandler } from "../src/qq/commands.mjs";
import { createLibraryPoller, fetchLibrarySeats, SELF_STUDY_AREA } from "../src/qq/library.mjs";
import { createQqStore, LIBRARY_NOTIFICATION } from "../src/qq/store.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "qq-library-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const open = () => createQqStore({ directory, appId: "library-test" });
  return { store: open(), open };
}

const observedAt = Date.parse("2026-11-12T09:20:00Z");
const sample = (count, time = observedAt) => ({
  counts: { "三层南区": 12, [SELF_STUDY_AREA]: count, "二层北区": 7 }, observedAt: time
});

test("查询只映射首页已知区域，0 有效，异常响应不会冒充余座", async () => {
  const query = (payload) => fetchLibrarySeats({ fetchImpl: async (url, options) => {
    assert.equal(url, "https://seat.ucasr.cn/api/layout/getremainseat");
    assert.equal(options.headers, undefined);
    return Response.json(payload);
  } });
  assert.deepEqual((await query({ code: 200, data: [12, 900, 901, 0, 7] })).counts, sample(0).counts);
  await assert.rejects(query({ code: 500, data: [12, 0, 0, 0, 7] }), /数据无效/u);
  await assert.rejects(query({ code: 200, data: [12, 0, 0, false, 7] }), /数据无效/u);
  await assert.rejects(query({ code: 200, data: [12, 0, 0, 0] }), /数据无效/u);
});

test("未绑学号也能查询和开关订阅，重新开启不补发旧变化", async (t) => {
  const { store, open } = await fixture(t);
  let snapshot = sample(0);
  const handle = createCommandHandler({ store, libraryQuery: async () => snapshot });
  const sendCommand = (content) => handle({ userId: "qq-reader", content });
  const reply = await sendCommand("查询图书馆座位");
  assert.match(reply, /三层南区：12 席\n三层中厅自助学习区：0 席\n二层北区：7 席/u);
  assert.match(reply, /2026-11-12 17:20/u);
  assert.match(await sendCommand("订阅自助区"), /订阅已开启/u);
  assert.equal(await open().hasLibrarySubscriptions(), true);
  snapshot = sample(5, observedAt + 60_000);
  assert.match(await sendCommand("启动订阅"), /正在订阅/u);
  assert.equal(await open().observeLibrarySeats(5, snapshot.observedAt), 1);
  assert.match(await sendCommand("关闭订阅"), /订阅已关闭/u);
  assert.equal((await store.getSummary()).pending, 0);
  assert.equal(await open().hasLibrarySubscriptions(), false);
  snapshot = sample(2, observedAt + 120_000);
  assert.match(await sendCommand("启动订阅"), /当前余座：2 席/u);
  assert.equal(await store.observeLibrarySeats(2, observedAt + 180_000), 0);
});

test("轮询仅在有订阅时请求，重启后保留基准，失败和未变化不提醒", async (t) => {
  const { store, open } = await fixture(t);
  let calls = 0;
  const snapshots = [sample(0), null, sample(4, observedAt + 120_000), sample(4, observedAt + 180_000), sample(0, observedAt + 240_000)];
  const query = async () => {
    calls += 1;
    const item = snapshots.shift();
    if (!item) throw new Error("upstream unavailable");
    return item;
  };
  const first = createLibraryPoller({ store, query });
  await first();
  assert.equal(calls, 0);
  await store.subscribeLibrarySeats("qq-reader");
  await Promise.all([first(), first()]);
  assert.equal(calls, 1);
  assert.equal((await store.getSummary()).pending, 0);
  const restarted = open();
  const poll = createLibraryPoller({ store: restarted, query });
  for (let index = 0; index < 4; index++) await poll();
  const deliveries = [];
  const result = await restarted.drainNotifications({
    accountExists: () => { throw new Error("Library must not check course accounts"); },
    send: (userId, content, delivery) => deliveries.push({ userId, content, delivery })
  });
  assert.equal(result.sent, 2);
  assert.ok(deliveries.every((item) => item.userId === "qq-reader" && item.delivery.kind === LIBRARY_NOTIFICATION));
  assert.match(deliveries[0].content, /0 席 → 4 席/u);
  assert.match(deliveries[1].content, /4 席 → 0 席/u);
  await restarted.unsubscribeLibrarySeats("qq-reader");
  await restarted.subscribeLibrarySeats("qq-reader");
  assert.equal(await restarted.canReceiveNotification("qq-reader", deliveries[1].delivery), false);
});
