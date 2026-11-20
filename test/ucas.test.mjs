import test from "node:test";
import assert from "node:assert/strict";
import { UcasClient } from "../src/ucas.mjs";

test("登录、查课表、校时后优先用 UUID 签到", async () => {
  const calls = [];
  const responses = [
    { STATUS: "0", result: { id: "user-1", sessionId: "session-1" } },
    { STATUS: "0", result: [] },
    { STATUS: "0", timestamp: 1789380000000 },
    { STATUS: "0", result: { stuSignId: "1", stuSignStatus: "1" } }
  ];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    return Response.json(responses.shift());
  };
  const client = new UcasClient({ username: "20260001", password: "secret", fetchImpl });

  await client.schedule("20260914");
  await client.serverTimestamp();
  const signed = await client.sign({ uuid: "00112233-4455-6677-8899-aabbccddeeff", courseSchedId: "1234567" }, 1789380000000);
  assert.equal(signed.signParameter, "timeTableId");
  assert.equal(signed.data.result.stuSignStatus, "1");

  assert.equal(calls.length, 4);
  assert.equal(new URL(calls[0].url).pathname, "/app/user/login.action");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(new URLSearchParams(calls[0].options.body).get("phone"), "20260001");
  assert.equal(new URLSearchParams(calls[0].options.body).get("password"), "secret");
  assert.equal(new URLSearchParams(calls[0].options.body).get("verificationType"), "1");
  assert.equal(calls[1].options.headers.sessionId, "session-1");
  assert.equal(new URL(calls[1].url).searchParams.get("dateStr"), "20260914");
  assert.equal(calls[2].options.method, "POST");
  assert.equal(new URL(calls[2].url).pathname, "/app/common/get_timestamp.do");
  assert.equal(calls[3].options.method, "GET");
  assert.equal(new URL(calls[3].url).searchParams.get("timeTableId"), "00112233445566778899AABBCCDDEEFF");
  assert.equal(new URL(calls[3].url).searchParams.get("courseSchedId"), null);
  assert.equal(new URL(calls[3].url).searchParams.get("id"), "user-1");
  assert.equal(calls[3].options.headers.sessionId, "session-1");
});

test("没有有效 UUID 时才发数字场次 ID，签到失败不再用另一种编号补发", async () => {
  const signedUrls = [];
  const client = new UcasClient({
    username: "20260001", password: "secret",
    fetchImpl: async (input) => {
      const url = new URL(input);
      if (url.pathname.endsWith("login.action")) return Response.json({ STATUS: "0", result: { id: "user-1", sessionId: "session-1" } });
      signedUrls.push(url);
      return Response.json({ STATUS: "1" });
    }
  });
  const fallback = await client.sign({ uuid: "invalid", courseSchedId: 1234567 }, 1789380000000);
  assert.equal(fallback.signParameter, "courseSchedId");
  assert.equal(signedUrls[0].searchParams.get("courseSchedId"), "1234567");
  assert.equal(signedUrls[0].searchParams.has("timeTableId"), false);
  await client.sign({ uuid: "00112233445566778899AABBCCDDEEFF", courseSchedId: "1234567" }, 1789380000000);
  assert.equal(signedUrls.length, 2);
  assert.equal(signedUrls[1].searchParams.has("courseSchedId"), false);
  await assert.rejects(client.sign({ uuid: "", courseSchedId: "42" }, 1789380000000), /缺少有效/);
  assert.equal(signedUrls.length, 2);
});

test("指定课堂扫码时优先发 7 位课程号，缺 7 位编号时自动回退 UUID", async () => {
  const signedUrls = [];
  const client = new UcasClient({
    username: "20260001", password: "secret",
    fetchImpl: async (input) => {
      const url = new URL(input);
      if (url.pathname.endsWith("login.action")) return Response.json({ STATUS: "0", result: { id: "user-1", sessionId: "session-1" } });
      signedUrls.push(url);
      return Response.json({ STATUS: "0", result: { stuSignId: "2", stuSignStatus: "1" } });
    }
  });
  const classroom = await client.sign({ uuid: "00112233445566778899AABBCCDDEEFF", courseSchedId: "1234567", method: "courseSchedId" }, 1789380000000);
  assert.equal(classroom.signParameter, "courseSchedId");
  assert.equal(signedUrls[0].searchParams.get("courseSchedId"), "1234567");
  assert.equal(signedUrls[0].searchParams.has("timeTableId"), false);

  const fallbackUuid = await client.sign({ uuid: "00112233445566778899AABBCCDDEEFF", courseSchedId: "", method: "courseSchedId" }, 1789380000000);
  assert.equal(fallbackUuid.signParameter, "timeTableId");
  assert.equal(signedUrls[1].searchParams.get("timeTableId"), "00112233445566778899AABBCCDDEEFF");
  assert.equal(signedUrls[1].searchParams.has("courseSchedId"), false);
});

test("UCAS 课表状态 2 且没有结果时识别为当天无课", async () => {
  const responses = [
    { STATUS: "0", result: { id: "user-1", sessionId: "session-1" } },
    { STATUS: "2" }
  ];
  const client = new UcasClient({
    username: "20260001",
    password: "secret",
    fetchImpl: async () => Response.json(responses.shift())
  });
  assert.deepEqual(await client.schedule("20260915"), []);
});

test("成功状态但课表结果格式异常时仍视为查询失败", async () => {
  const responses = [
    { STATUS: "0", result: { id: "user-1", sessionId: "session-1" } },
    { STATUS: "0" }
  ];
  const client = new UcasClient({
    username: "20260001",
    password: "secret",
    fetchImpl: async () => Response.json(responses.shift())
  });
  await assert.rejects(client.schedule("20260915"), /响应格式错误/);
});
