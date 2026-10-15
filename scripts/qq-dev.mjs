import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const config = resolve(root, "qq.local.env");
const mode = process.argv[2] || "--dev";
if (!["--dev", "--init", "--bot", "--build"].includes(mode)) throw new Error("未知 QQ 调试模式");
try {
  await writeFile(config, `# QQ 本地调试专用。此文件已被 Git 忽略，不要分享或提交。
# 只需填写 AppSecret，其他随机密钥首次生成后请保留。
QQ_BOT_ENABLED=1
QQ_BOT_APP_ID=
QQ_BOT_APP_SECRET=
# 私聊“我的ID”，把返回的 OpenID 填在下面；多个管理员用逗号分隔。
QQ_BOT_ADMIN_OPENIDS=

# 与原项目账号、加密密钥及数据隔离，不会加载原 data/ 中的任务。
AUTO_SIGN_DATA_DIR=./data-qq-dev
AUTO_SIGN_SECRET=${randomBytes(32).toString("hex")}
UCAS_ACCESS_KEY=${randomBytes(24).toString("base64url")}
AUTO_SIGN_LOCK_PORT=43860
QQ_BOT_LOCK_PORT=43859
APP_HOST=127.0.0.1
HOSTNAME=127.0.0.1
APP_PORT=3112
APP_BASE_PATH=
LOCAL_DESKTOP_MODE=1
`, { flag: "wx", mode: 0o600 });
  console.log(`已生成私有配置：${config}`);
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.log(`使用已有私有配置：${config}`);
}
if (mode !== "--init") {
  const { parseEnv } = await import("node:util");
  if (typeof parseEnv !== "function") throw new Error("QQ 本地调试请使用 Node.js 22 或更高版本");
  Object.assign(process.env, parseEnv(await readFile(config, "utf8")));
  process.env.QQ_LOCAL_DEBUG = "1";
  if (resolve(root, process.env.AUTO_SIGN_DATA_DIR || "data") !== resolve(root, "data-qq-dev")
    || process.env.APP_HOST !== "127.0.0.1" || process.env.HOSTNAME !== "127.0.0.1") {
    throw new Error("QQ 调试必须使用 data-qq-dev 和 127.0.0.1 回环地址，请恢复本地隔离配置");
  }
  // Load into the environment rather than passing --env-file to Next: Next
  // forwards execArgv to build workers, where that CLI flag is not permitted.
  const args = mode === "--build" ? ["node_modules/next/dist/bin/next", "build"]
    : mode === "--bot" ? ["src/qq/run.mjs"] : ["scripts/run.mjs", "dev"];
  const child = spawn(process.execPath, args, { cwd: root, env: process.env, stdio: "inherit" });
  child.on("exit", (code) => { process.exitCode = code ?? 1; });
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill());
}
