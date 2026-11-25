import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const WINDOWS_RENAME_RETRY_MS = [20, 40, 80, 160, 320, 640];
const TRANSIENT_RENAME_ERRORS = new Set(["EACCES", "EBUSY", "EPERM"]);

export async function writeJsonAtomically(file, value, { space = 2 } = {}) {
  const json = JSON.stringify(value, null, space);
  await mkdir(dirname(file), { recursive: true });
  const tempFile = file + "." + process.pid + "." + randomBytes(8).toString("hex") + ".tmp";
  let written = false;
  try {
    await writeFile(tempFile, json, { encoding: "utf8", mode: 0o600, flag: "wx" });
    written = true;
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(tempFile, file);
        return;
      } catch (error) {
        // Windows can reject replacement while a scanner or reader holds a file handle.
        const delay = WINDOWS_RENAME_RETRY_MS[attempt];
        if (process.platform !== "win32" || !TRANSIENT_RENAME_ERRORS.has(error?.code) || delay === undefined) throw error;
        await wait(delay);
      }
    }
  } catch (error) {
    if (written || error?.code !== "EEXIST") await rm(tempFile, { force: true }).catch(() => {});
    throw error;
  }
}
