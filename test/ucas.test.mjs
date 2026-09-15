import test from "node:test";
import assert from "node:assert/strict";
import { UcasClient } from "../src/ucas.mjs";

test("按原项目格式发送登录、课表、时间戳和签到请求", async () => {
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
  await client.sign("1234567", 1789380000000);

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
  assert.equal(new URL(calls[3].url).searchParams.get("courseSchedId"), "1234567");
  assert.equal(new URL(calls[3].url).searchParams.get("id"), "user-1");
  assert.equal(calls[3].options.headers.sessionId, "session-1");
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
