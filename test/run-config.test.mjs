import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceRunScript = join(sourceRoot, "scripts", "run.mjs");

async function createScenario(mode, envContents) {
  const directory = await mkdtemp(join(tmpdir(), "ucas-run-config-"));
  const markers = join(directory, "markers");
  const root = join(directory, "app");
  const runScript = join(root, "scripts", "run.mjs");
  const fixtureScript = `
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const scriptPath = process.argv[1].replaceAll("\\\\", "/");
const role = scriptPath.endsWith("/next/dist/bin/next") ? "next"
  : scriptPath.endsWith("/worker-multi.mjs") ? "worker"
    : scriptPath.endsWith("/qq/run.mjs") ? "qq" : "unknown";
writeFileSync(join(process.env.RUN_TEST_MARKERS, role + ".json"), JSON.stringify({
  role,
  QQ_BOT_ENABLED: process.env.QQ_BOT_ENABLED ?? null,
  APP_PORT: process.env.APP_PORT ?? null,
  argv: process.argv.slice(2)
}));
const stopFile = join(process.env.RUN_TEST_MARKERS, "stop");
const timer = setInterval(() => {
  if (existsSync(stopFile)) {
    clearInterval(timer);
    process.exit(0);
  }
}, 10);
`;

  await mkdir(markers, { recursive: true });
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "node_modules", "next", "dist", "bin"), { recursive: true });
  await mkdir(join(root, "src", "qq"), { recursive: true });
  await writeFile(runScript, await readFile(sourceRunScript));
  await writeFile(join(root, ".env.local"), envContents);
  await writeFile(join(root, "node_modules", "next", "dist", "bin", "next"), fixtureScript);
  await writeFile(join(root, "src", "worker-multi.mjs"), fixtureScript);
  await writeFile(join(root, "src", "qq", "run.mjs"), fixtureScript);

  const env = { ...process.env, APP_HOST: "127.0.0.1", APP_PORT: "3110", QQ_LOCAL_DEBUG: "1", RUN_TEST_MARKERS: markers };
  delete env.QQ_BOT_ENABLED;
  const runner = spawn(process.execPath, [runScript, mode], { cwd: root, env, stdio: "ignore" });
  const exit = new Promise((resolvePromise, rejectPromise) => {
    runner.once("error", rejectPromise);
    runner.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });

  async function waitForRoles(roles) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const found = new Set(await readdir(markers));
      if (roles.every((role) => found.has(`${role}.json`))) return;
      if (runner.exitCode !== null) throw new Error(`启动脚本提前退出：${runner.exitCode}`);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    throw new Error(`子进程未及时启动：${roles.join(", ")}`);
  }

  async function record(role) {
    return JSON.parse(await readFile(join(markers, `${role}.json`), "utf8"));
  }

  async function dispose() {
    await writeFile(join(markers, "stop"), "");
    let timeout;
    try {
      await Promise.race([
        exit,
        new Promise((_, rejectPromise) => {
          timeout = setTimeout(() => rejectPromise(new Error("启动脚本未正常退出")), 5_000);
        })
      ]);
    } finally {
      clearTimeout(timeout);
    }
    const relativeDirectory = relative(resolve(tmpdir()), resolve(directory));
    if (relativeDirectory && !relativeDirectory.startsWith("..")) {
      await rm(directory, { recursive: true, force: true });
    }
  }

  return { waitForRoles, record, markers, dispose };
}

test("start 加载 .env.local，且保留已有进程环境变量", async () => {
  const scenario = await createScenario("start", "QQ_BOT_ENABLED=1\nAPP_PORT=3999\n");
  try {
    await scenario.waitForRoles(["next", "worker", "qq"]);
    const next = await scenario.record("next");
    const qq = await scenario.record("qq");
    assert.equal(next.QQ_BOT_ENABLED, "1");
    assert.equal(next.APP_PORT, "3110", "已有 APP_PORT 应优先于 .env.local");
    assert.equal(qq.QQ_BOT_ENABLED, "1");
    assert.equal(qq.APP_PORT, "3110");
  } finally {
    await scenario.dispose();
  }
});

test("dev 不加载项目 .env.local 到启动进程", async () => {
  const scenario = await createScenario("dev", "QQ_BOT_ENABLED=1\nAPP_PORT=3999\n");
  try {
    await scenario.waitForRoles(["next", "worker"]);
    const next = await scenario.record("next");
    assert.equal(next.QQ_BOT_ENABLED, null);
    assert.equal(next.APP_PORT, "3110");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    assert.equal((await readdir(scenario.markers)).includes("qq.json"), false);
  } finally {
    await scenario.dispose();
  }
});
