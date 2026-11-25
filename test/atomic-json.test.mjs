import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeJsonAtomically } from "../src/automation/atomic-json.mjs";

test("Windows retries an atomic JSON replacement during a sharing violation", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "ucas-atomic-json-"));
  const file = join(directory, "state.json");
  let child;
  let exited;
  try {
    await writeJsonAtomically(file, { version: 1 });
    child = spawn("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "$handle = [IO.File]::Open($env:UCAS_TEST_STATE, 'Open', 'Read', 'Read'); " +
      "try { [Console]::WriteLine('locked'); Start-Sleep -Milliseconds 350 } finally { $handle.Dispose() }"
    ], { env: { ...process.env, UCAS_TEST_STATE: file }, windowsHide: true });
    exited = once(child, "exit");
    const ready = once(child.stdout, "data", { signal: AbortSignal.timeout(5000) });
    const lockResult = await Promise.race([ready.then(([chunk]) => chunk.toString().trim()), exited.then(() => "exited")]);
    assert.equal(lockResult, "locked");
    await writeJsonAtomically(file, { version: 2 });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { version: 2 });
    assert.deepEqual(await readdir(directory), ["state.json"]);
    assert.equal((await exited)[0], 0);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    await exited?.catch(() => {});
    await rm(directory, { force: true, recursive: true, maxRetries: 5 });
  }
});
