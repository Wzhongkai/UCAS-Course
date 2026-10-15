import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createBackendScheduleQuery } from "../src/qq/backend.mjs";

test("机器人通过回环后台端口查询课表，只发送账号ID及日期", async (t) => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ url: request.url, headers: request.headers, body: JSON.parse(body) });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ date: "20261015", courses: [{ courseName: "数学", classBeginTime: "08:30" }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const query = createBackendScheduleQuery({
    env: { APP_PORT: String(server.address().port), APP_BASE_PATH: "/ucas/" },
    cookieHeader: () => "ucas_course_access=test-proof"
  });
  assert.deepEqual(await query("account-1", "20261015"), [{ courseName: "数学", classBeginTime: "08:30" }]);
  assert.equal(requests[0].url, "/ucas/api/qq/schedule");
  assert.equal(requests[0].headers.origin, `http://127.0.0.1:${server.address().port}`);
  assert.equal(requests[0].headers.cookie, "ucas_course_access=test-proof");
  assert.deepEqual(requests[0].body, { accountId: "account-1", date: "20261015" });
});

test("后台故障、畸形或日期不匹配响应都不泄露原始错误", async () => {
  for (const response of [
    () => new Response("secret-private", { status: 401 }),
    () => new Response("secret-private"),
    () => Response.json({ date: "20261014", courses: [] }),
    () => Response.json({ date: "20261015", courses: {} }),
    () => { throw new Error("secret-private"); }
  ]) {
    const query = createBackendScheduleQuery({ cookieHeader: () => "", fetchImpl: response });
    await assert.rejects(query("account", "20261015"), { message: "后台课表查询暂时不可用，请稍后重试" });
  }
});

test("后台请求不跟随重定向，并有超时限制", async () => {
  const query = createBackendScheduleQuery({ cookieHeader: () => "", timeoutMs: 1_000, fetchImpl: async (url, options) => {
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store");
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ date: "20261015", courses: [] });
  } });
  assert.deepEqual(await query("account", "20261015"), []);
});

test("端口及路径配置不能把后台凭证送往其他主机", async () => {
  for (const env of [
    { APP_PORT: "http://evil.example" },
    { APP_PORT: "70000" },
    { APP_BASE_PATH: "a/../b" },
    { APP_BASE_PATH: "a?redirect=evil" },
    { APP_BASE_PATH: "a\\evil" },
    { APP_BASE_PATH: "%2f%2fevil.example" }
  ]) {
    let fetched = false;
    const query = createBackendScheduleQuery({ env, cookieHeader: () => "secret", fetchImpl: async () => { fetched = true; } });
    await assert.rejects(query("account", "20261015"));
    assert.equal(fetched, false);
  }
});
