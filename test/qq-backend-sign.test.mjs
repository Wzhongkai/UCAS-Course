import assert from "node:assert/strict";
import test from "node:test";
import { createBackendSignAction } from "../src/qq/backend.mjs";
import { BackendSignError, createBackendSignService } from "../src/qq/backend-sign-service.mjs";
import { createScheduleRateLimiter } from "../src/qq/backend-schedule-service.mjs";
import { groupCourses } from "../src/schedule.mjs";

const date = "20261015";
const uuidA = "00112233445566778899AABBCCDDEEFF";

function makeAccount(overrides = {}) {
  return {
    id: "acct-1",
    enabled: true,
    signMethod: "timeTableId",
    courseSignMethodOverrides: {},
    credentials: { username: "20260001", password: "secret" },
    ...overrides
  };
}

test("立即签到默认按课程配置方式执行，成功后记录完成键避免计划重复签到", async () => {
  const completedKeys = [];
  const signCalls = [];
  const rawCourses = [{
    id: "1234567",
    uuid: uuidA,
    courseName: "高等数学",
    classBeginTime: "09:00:00",
    classEndTime: "10:30:00",
    signStatus: "0"
  }];
  const expectedKey = `acct-1:${groupCourses(rawCourses, date)[0].key}`;

  const service = createBackendSignService({
    readSettings: async () => ({ accounts: [makeAccount({ courseSignMethodOverrides: { 高等数学: "courseSchedId" } })] }),
    createClient: () => ({
      async login() {},
      async schedule() { return rawCourses; },
      async serverTimestamp() { return Date.parse("2026-10-15T08:55:00+08:00"); },
      async sign(params, timestamp) {
        signCalls.push({ params, timestamp });
        return { data: { STATUS: "0", result: { stuSignStatus: "1", stuSignId: "S-100" } }, signParameter: params.method };
      }
    }),
    markCompleted: async (key) => { completedKeys.push(key); },
    now: () => Date.parse("2026-10-15T08:55:00+08:00")
  });

  const result = await service({ accountId: "acct-1", courseName: "  高等数学 ", date });
  assert.deepEqual(result, {
    status: "signed",
    date,
    courseName: "高等数学",
    signParameter: "courseSchedId",
    stuSignId: "S-100"
  });
  assert.equal(signCalls.length, 1);
  assert.equal(signCalls[0].params.method, "courseSchedId");
  assert.deepEqual(completedKeys, [expectedKey]);
});

test("立即签到支持临时指定方式，并优先选择当前进行中的未签课次", async () => {
  const completedKeys = [];
  const signCalls = [];
  const rawCourses = [
    { id: "1234561", uuid: uuidA, courseName: "高等数学", classBeginTime: "08:00:00", classEndTime: "09:00:00", signStatus: "1" },
    { id: "1234562", uuid: uuidA, courseName: "高等数学", classBeginTime: "14:00:00", classEndTime: "15:30:00", signStatus: "0" }
  ];
  const afternoonKey = `acct-1:${groupCourses(rawCourses, date)[1].key}`;

  const service = createBackendSignService({
    readSettings: async () => ({ accounts: [makeAccount({ signMethod: "timeTableId" })] }),
    createClient: () => ({
      async login() {},
      async schedule() { return rawCourses; },
      async serverTimestamp() { throw new Error("clock unavailable"); },
      async sign(params) {
        signCalls.push(params);
        return { data: { STATUS: "0", result: { stuSignStatus: "1", stuSignId: "S-200" } }, signParameter: "courseSchedId" };
      }
    }),
    markCompleted: async (key) => { completedKeys.push(key); },
    now: () => Date.parse("2026-10-15T13:45:00+08:00")
  });

  const result = await service({ accountId: "acct-1", courseName: "高等数学", signMethod: "courseSchedId", date });
  assert.equal(result.status, "signed");
  assert.equal(result.signParameter, "courseSchedId");
  assert.equal(signCalls[0].courseSchedId, "1234562");
  assert.equal(signCalls[0].method, "courseSchedId");
  assert.deepEqual(completedKeys, [afternoonKey]);
});

test("立即签到处理已签到、未找到、上游失败与频控", async () => {
  const completedKeys = [];
  let courses = [{ id: "1234567", uuid: uuidA, courseName: "线性代数", classBeginTime: "09:00:00", classEndTime: "10:30:00", signStatus: "1" }];
  const service = createBackendSignService({
    readSettings: async () => ({ accounts: [makeAccount()] }),
    createClient: () => ({
      async login() {},
      async schedule() { return courses; },
      async serverTimestamp() { return Date.parse("2026-10-15T08:50:00+08:00"); },
      async sign() { return { data: { STATUS: "1", ERRMSG: "签到未开始" }, signParameter: "timeTableId" }; }
    }),
    rateLimiter: createScheduleRateLimiter({ accountLimit: 3, globalLimit: 10 }),
    markCompleted: async (key) => { completedKeys.push(key); },
    now: () => Date.parse("2026-10-15T08:50:00+08:00")
  });

  const already = await service({ accountId: "acct-1", courseName: "线性代数", date });
  assert.equal(already.status, "already_signed");
  assert.equal(completedKeys.length, 1);

  const missing = await service({ accountId: "acct-1", courseName: "不存在课程", date });
  assert.equal(missing.status, "not_found");
  assert.equal(completedKeys.length, 1);

  courses = [{ id: "1234567", uuid: uuidA, courseName: "线性代数", classBeginTime: "09:00:00", classEndTime: "10:30:00", signStatus: "0" }];
  const failed = await service({ accountId: "acct-1", courseName: "线性代数", date });
  assert.equal(failed.status, "failed");
  assert.equal(failed.reason, "签到未开始");
  assert.equal(completedKeys.length, 1);

  await assert.rejects(
    () => service({ accountId: "acct-1", courseName: "线性代数", date }),
    (error) => error instanceof BackendSignError && error.status === 429
  );
});

test("机器人通过回环后台接口发起立即签到，并在异常时不泄露内部错误", async () => {
  const requests = [];
  const signNow = createBackendSignAction({
    env: { APP_PORT: "3112", APP_BASE_PATH: "/course" },
    cookieHeader: () => "ucas_course_access=proof",
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return Response.json({ status: "signed", courseName: "高等数学", signParameter: "courseSchedId", stuSignId: "10" });
    }
  });

  const result = await signNow("acct-1", "高等数学", "courseSchedId");
  assert.equal(result.status, "signed");
  assert.equal(requests[0].url, "http://127.0.0.1:3112/course/api/qq/sign");
  assert.equal(requests[0].options.headers.cookie, "ucas_course_access=proof");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    accountId: "acct-1",
    courseName: "高等数学",
    signMethod: "courseSchedId"
  });

  const failing = createBackendSignAction({
    env: { APP_PORT: "3112" },
    cookieHeader: () => "",
    fetchImpl: async () => { throw new Error("secret internal host 10.0.0.5"); }
  });
  await assert.rejects(() => failing("acct-1", "高等数学"), (error) => {
    assert.equal(error.message, "后台立即签到暂时不可用，请稍后重试");
    assert.doesNotMatch(error.message, /10\.0\.0\.5|secret/);
    return true;
  });
});
