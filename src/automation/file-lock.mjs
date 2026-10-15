import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by another user. Treat all
    // errors other than ESRCH conservatively as a live process.
    return error?.code !== "ESRCH";
  }
}

async function readOwner(lockDirectory) {
  try {
    const owner = JSON.parse(await readFile(join(lockDirectory, "owner.json"), "utf8"));
    if (!Number.isSafeInteger(owner.pid) || typeof owner.token !== "string") return null;
    return owner;
  } catch {
    // A newly-created lock can briefly have no complete owner file. Never
    // remove a lock whose owner cannot be identified safely.
    return null;
  }
}

async function readJsonFile(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function removeDeadLock(lockDirectory) {
  const first = await readOwner(lockDirectory);
  if (!first || isProcessAlive(first.pid)) return false;

  const reaperFile = join(lockDirectory, "reaper.json");
  const claim = { pid: process.pid, token: randomBytes(16).toString("hex"), ownerToken: first.token };
  try {
    // Exclusive creation serializes contenders that observed the same dead
    // owner. The synchronous write ensures nobody mistakes a live claimant
    // for an ownerless, half-written marker.
    writeFileSync(reaperFile, JSON.stringify(claim), { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") return false;

    // A process can itself die while reaping. Recover its abandoned claim by
    // moving the dead generation to a token-specific path that remains as a
    // tombstone, so a waiter with stale observations cannot move a new lock.
    const previousClaim = await readJsonFile(reaperFile);
    if (!previousClaim || isProcessAlive(previousClaim.pid)) return false;
    const current = await readOwner(lockDirectory);
    if (!current || current.pid !== first.pid || current.token !== first.token || isProcessAlive(current.pid)) return false;
    const safeToken = first.token.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "unknown";
    try {
      await rename(lockDirectory, `${lockDirectory}.stale-${safeToken}`);
      return true;
    } catch (renameError) {
      if (renameError?.code === "ENOENT" || renameError?.code === "EEXIST" || renameError?.code === "ENOTEMPTY") return false;
      throw renameError;
    }
  }

  let moved = false;
  const current = await readOwner(lockDirectory);
  if (!current || current.pid !== first.pid || current.token !== first.token || isProcessAlive(current.pid)) {
    const marker = await readJsonFile(reaperFile);
    if (marker?.token === claim.token) await rm(reaperFile, { force: true }).catch(() => {});
    return false;
  }

  const safeOwnerToken = first.token.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "unknown";
  const staleDirectory = `${lockDirectory}.stale-${safeOwnerToken}-${claim.token}`;
  try {
    await rename(lockDirectory, staleDirectory);
    moved = true;
    // Moving the directory makes the lock path available atomically. Cleanup
    // can finish afterwards without ever touching a replacement lock.
    await rm(staleDirectory, { recursive: true, force: true }).catch(() => {});
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    if (error?.code === "EEXIST" || error?.code === "ENOTEMPTY") return false;
    throw error;
  } finally {
    if (!moved) {
      const marker = await readJsonFile(reaperFile);
      if (marker?.token === claim.token) await rm(reaperFile, { force: true }).catch(() => {});
    }
  }
}

/**
 * Run callback while holding an inter-process directory lock beside `file`.
 * Lock metadata contains only the process id and a random ownership token.
 */
export async function withFileLock(file, callback, { timeoutMs = 10_000 } = {}) {
  if (typeof callback !== "function") throw new TypeError("callback 必须是函数");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new TypeError("timeoutMs 必须是非负数");

  const lockDirectory = `${file}.lock`;
  await mkdir(dirname(file), { recursive: true });
  const deadline = Date.now() + timeoutMs;

  while (true) {
    let acquired = false;
    let owner;
    try {
      await mkdir(lockDirectory);
      acquired = true;
      owner = { pid: process.pid, token: randomBytes(16).toString("hex"), acquiredAt: Date.now() };
      await writeFile(join(lockDirectory, "owner.json"), JSON.stringify(owner), { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      if (acquired) {
        await rm(lockDirectory, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      if (error?.code !== "EEXIST") throw error;

      if (await removeDeadLock(lockDirectory)) continue;
      if (Date.now() >= deadline) {
        const timeoutError = new Error(`等待文件锁超时：${file}`);
        timeoutError.code = "ELOCKTIMEOUT";
        throw timeoutError;
      }
      await wait(Math.min(25 + Math.floor(Math.random() * 25), Math.max(1, deadline - Date.now())));
      continue;
    }

    try {
      return await callback();
    } finally {
      const current = await readOwner(lockDirectory);
      if (current?.pid === owner.pid && current.token === owner.token) {
        await rm(lockDirectory, { recursive: true, force: true });
      }
    }
  }
}
