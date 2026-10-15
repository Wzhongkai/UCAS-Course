import test from "node:test";
import assert from "node:assert/strict";
import {
  BackendScheduleError,
  createBackendScheduleService,
  createScheduleRateLimiter,
  normalizeScheduleDate
} from "../src/qq/backend-schedule-service.mjs";

test("课程查询日期只接受真实的 yyyyMMdd 或 yyyy-MM-dd 日期", () => {
  assert.equal(normalizeScheduleDate("20261015"), "20261015");
  assert.equal(normalizeScheduleDate("2024-02-29"), "20240229");
  assert.throws(() => normalizeScheduleDate("2023-02-29"), (error) => error instanceof BackendScheduleError && error.status === 400);
  assert.throws(() => normalizeScheduleDate("20261032"), (error) => error instanceof BackendScheduleError && error.status === 400);
  assert.throws(() => normalizeScheduleDate("2026-1-5"), (error) => error instanceof BackendScheduleError && error.status === 400);
});

test("后台课程查询读取存储凭证、不要求账号启用并投影安全课程字段", async () => {
  const credentials = { username: "20260001", password: "private-password" };
  const calls = [];
  const service = createBackendScheduleService({
    readSettings: async () => ({ accounts: [{ id: "account-1", enabled: false, credentials }] }),
    createClient: (receivedCredentials) => {
      assert.deepEqual(receivedCredentials, credentials);
      return {
        async login() { calls.push("login"); },
        async schedule(date) {
          calls.push(date);
          return [
            {
              id: "course-1",
              uuid: "uuid-1",
              courseName: "高等数学",
              teacherName: "张老师",
              weekDay: "星期四",
              classBeginTime: "08:00",
              classEndTime: "09:40",
              signStatus: "0",
              classroom: "教学楼 1",
              password: "upstream-secret",
              sessionId: "upstream-session",
              authorization: "private-header",
              extra: { secret: "private-object" }
            },
            null
          ];
        }
      };
    }
  });

  const result = await service({ accountId: "account-1", date: "2026-10-15" });
  assert.deepEqual(calls, ["login", "20261015"]);
  assert.deepEqual(result, {
    date: "20261015",
    total: 1,
    courses: [{
      id: "course-1",
      uuid: "uuid-1",
      courseName: "高等数学",
      teacherName: "张老师",
      weekDay: "星期四",
      classBeginTime: "08:00",
      classEndTime: "09:40",
      signStatus: "0",
      classroom: "教学楼 1"
    }]
  });
  assert.equal(JSON.stringify(result).includes("upstream-secret"), false);
  assert.equal(JSON.stringify(result).includes("private-password"), false);
});

test("课程查询限流区分账号、全局窗口并限制账号桶数量", () => {
  let currentTime = 1_000;
  const limiter = createScheduleRateLimiter({
    accountLimit: 2,
    accountWindowMs: 5_000,
    globalLimit: 3,
    globalWindowMs: 1_000,
    maxAccountBuckets: 10,
    now: () => currentTime
  });

  assert.equal(limiter.consume("account-a"), true);
  assert.equal(limiter.consume("account-a"), true);
  assert.equal(limiter.consume("account-a"), false, "单账号超过上限应被阻止");
  assert.equal(limiter.consume("account-b"), true);
  assert.equal(limiter.consume("account-c"), false, "多个账号共用全局上限");
  currentTime += 1_001;
  assert.equal(limiter.consume("account-c"), true, "全局时间窗口过期后允许查询");
  assert.equal(limiter.consume("account-a"), false, "单账号窗口比全局窗口更长");
  currentTime += 4_000;
  assert.equal(limiter.consume("account-a"), true, "单账号窗口过期后允许查询");

  const bounded = createScheduleRateLimiter({
    accountLimit: 100,
    globalLimit: 1_000,
    maxAccountBuckets: 2,
    now: () => currentTime
  });
  for (let index = 0; index < 100; index += 1) {
    assert.equal(bounded.consume(`account-${index}`), true);
    assert.ok(bounded.accountBucketCount <= 2);
  }
});

test("查询未知账号时返回不含上游或凭据内容的固定错误", async () => {
  const service = createBackendScheduleService({ readSettings: async () => ({ accounts: [] }) });
  await assert.rejects(
    service({ accountId: "missing", date: "20261015" }),
    (error) => error instanceof BackendScheduleError && error.status === 404 && error.message === "账号不存在"
  );
});
