// Integration smoke test for the actual compiled Next routes. All credentials
// and records are fabricated and live only in a dedicated temporary directory.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createQqStore } from "../src/qq/store.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const directory = await mkdtemp(join(tmpdir(), "ucas-qq-http-"));
const key = randomBytes(24).toString("hex");
const listener = createServer();
await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const baseOrigin = `http://127.0.0.1:${port}`;
const basePath = process.env.VERIFY_APP_BASE_PATH || "";
const base = baseOrigin + basePath;
const child = spawn(process.execPath, [resolve(root, ".next/standalone/server.js")], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: "production", HOSTNAME: "127.0.0.1", PORT: String(port),
    APP_HOST: "127.0.0.1", APP_BASE_PATH: basePath, LOCAL_DESKTOP_MODE: "0",
    UCAS_ACCESS_KEY: key, AUTO_SIGN_SECRET: randomBytes(32).toString("hex"),
    AUTO_SIGN_DATA_DIR: directory, QQ_BOT_APP_ID: "test-production",
    QQ_BOT_APP_SECRET: "", QQ_BOT_ENABLED: "0", QQ_BOT_BOOTSTRAP_TOKEN: "", QQ_BOT_ADMIN_OPENIDS: ""
  },
  stdio: "ignore"
});
const exited = new Promise((resolve) => child.once("exit", resolve));
let cookie = "";
const post = (path, body, { origin = baseOrigin, authenticated = true } = {}) => fetch(base + path, {
  method: "POST", headers: { "Content-Type": "application/json", Origin: origin, ...(authenticated && cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify(body)
});
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await fetch(base + "/api/qq"); ready = true; break; } catch { /* server is still starting */ }
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, "production server did not start; run npm run qq:build first");
  assert.equal((await fetch(base + "/api/qq")).status, 401);
  assert.equal((await post("/api/qq", { action: "code", accountId: "unknown" }, { authenticated: false })).status, 401);
  assert.equal((await post("/api/qq/schedule", { accountId: "unknown", date: "20261015" }, { authenticated: false })).status, 401);
  const login = await post("/api/access", { key });
  assert.equal(login.status, 200);
  cookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal((await post("/api/qq", {}, { origin: "https://invalid.example" })).status, 403);
  assert.equal((await post("/api/qq/schedule", { accountId: "unknown", date: "20261015" }, { origin: "https://invalid.example" })).status, 403);
  assert.equal((await post("/api/qq/schedule", { accountId: "unknown", date: "20260230" })).status, 400);
  assert.equal((await post("/api/qq/schedule", { accountId: "unknown", date: "20261015" })).status, 404);
  const added = await post("/api/automation", { action: "add", username: "http-test-account", password: "http-test-password", enabled: false });
  assert.equal(added.status, 200);
  const settings = (await added.json()).settings;
  const account = settings.accounts[0];
  assert.equal(account.enabled, false);
  assert.equal(JSON.stringify(settings).includes("http-test-password"), false);
  const timing = await post("/api/automation", { action: "course-timing", accountId: account.id, courseName: "测试课程", timing: { mode: "fixed", fixedMinutes: 12 } });
  assert.equal(timing.status, 200);
  const updated = (await timing.json()).settings;
  assert.equal(updated.accounts[0].courseTimingOverrides["测试课程"].fixedMinutes, 12);
  const code = await post("/api/qq", { action: "code", accountId: account.id });
  assert.equal(code.status, 200);
  const binding = await code.json();
  const store = createQqStore({ directory, appId: "test-production", bootstrapToken: "", adminOpenids: [] });
  await store.bind("http-test-qq", binding.code);
  assert.equal((await post("/api/qq", { action: "preference", accountId: account.id, mode: "failure" })).status, 200);
  const after = await (await fetch(base + "/api/automation", { headers: { Cookie: cookie } })).json();
  assert.equal(after.settings.updatedAt, updated.updatedAt, "QQ-only changes must not reset sign worker state");
  const summary = await (await fetch(base + "/api/qq", { headers: { Cookie: cookie } })).json();
  assert.equal(summary.bindings[0].mode, "failure");
  assert.equal(summary.bindings[0].userHint.includes("http-test-qq"), false);
  assert.equal(JSON.stringify(summary).includes(key), false);
  assert.equal((await post("/api/qq", { action: "preference", accountId: account.id, mode: "invalid" })).status, 400);
  assert.equal((await post("/api/qq", { action: "code", accountId: "missing" })).status, 404);
  console.log("生产接口验证通过：身份验证、同源保护、课表查询参数校验、暂停添加、单课程时间、绑定与通知模式、密钥隔离。");
} finally {
  child.kill();
  await exited;
  if (basename(directory).startsWith("ucas-qq-http-") && resolve(directory).startsWith(resolve(tmpdir()))) {
    await rm(directory, { recursive: true, force: true });
  }
}
