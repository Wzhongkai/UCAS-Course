import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withFileLock } from "../src/automation/file-lock.mjs";

const lockModuleUrl = pathToFileURL(fileURLToPath(new URL("../src/automation/file-lock.mjs", import.meta.url))).href;

test("跨进程文件锁串行执行回调", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ucas-file-lock-"));
  const file = join(directory, "state.json");
  const childScript = `import { withFileLock } from ${JSON.stringify(lockModuleUrl)}; await withFileLock(process.argv[1], async () => { console.log("locked"); await new Promise((resolve) => setTimeout(resolve, 350)); });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", childScript, file], { stdio: ["ignore", "pipe", "pipe"] });
  const childExit = new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("exit", (code) => resolvePromise(code));
  });
  try {
    let output = "";
    await new Promise((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => rejectPromise(new Error("子进程未及时获得文件锁")), 5_000);
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (output.includes("locked")) {
          clearTimeout(timeout);
          resolvePromise();
        }
      });
      child.once("error", rejectPromise);
      child.once("exit", (code) => {
        if (!output.includes("locked")) rejectPromise(new Error(`子进程提前退出：${code}`));
      });
    });

    const startedAt = Date.now();
    let entered = false;
    await withFileLock(file, async () => { entered = true; });
    assert.equal(entered, true);
    assert.ok(Date.now() - startedAt >= 250, "父进程应等待子进程释放锁");
    const code = await childExit;
    assert.equal(code, 0);
  } finally {
    child.kill();
    if (resolve(directory).startsWith(resolve(tmpdir()))) await rm(directory, { recursive: true, force: true });
  }
});

test("清理死进程锁但保留活进程锁", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ucas-file-lock-stale-"));
  const file = join(directory, "state.json");
  const lockDirectory = `${file}.lock`;
  try {
    await mkdir(lockDirectory);
    await writeFile(join(lockDirectory, "owner.json"), JSON.stringify({ pid: 2_147_483_647, token: "dead" }));
    let activeCallbacks = 0;
    let maxActiveCallbacks = 0;
    let completedCallbacks = 0;
    await Promise.all(Array.from({ length: 8 }, () => withFileLock(file, async () => {
      activeCallbacks += 1;
      maxActiveCallbacks = Math.max(maxActiveCallbacks, activeCallbacks);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
      activeCallbacks -= 1;
      completedCallbacks += 1;
    })));
    assert.equal(completedCallbacks, 8);
    assert.equal(maxActiveCallbacks, 1, "并发清理陈旧锁时仍应保持单一持有者");

    await mkdir(lockDirectory);
    await writeFile(join(lockDirectory, "owner.json"), JSON.stringify({ pid: process.pid, token: "live" }));
    await assert.rejects(
      withFileLock(file, async () => assert.fail("不应进入活进程持有的锁"), { timeoutMs: 100 }),
      (error) => error.code === "ELOCKTIMEOUT"
    );
    assert.deepEqual(JSON.parse(await readFile(join(lockDirectory, "owner.json"), "utf8")), { pid: process.pid, token: "live" });
  } finally {
    if (resolve(directory).startsWith(resolve(tmpdir()))) await rm(directory, { recursive: true, force: true });
  }
});
