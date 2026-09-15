import { spawn } from "node:child_process";
import { resolve } from "node:path";

const mode = process.argv[2];
if (mode !== "dev" && mode !== "start") {
  console.error("用法：node scripts/run.mjs dev|start");
  process.exit(1);
}

const root = resolve(import.meta.dirname, "..");
const nextBin = resolve(root, "node_modules/next/dist/bin/next");
const appHost = process.env.APP_HOST || "127.0.0.1";
const appPort = process.env.APP_PORT || "3100";
console.log(`UCAS 网页启动地址：http://127.0.0.1:${appPort}（WSL/本机浏览器）`);
const next = spawn(process.execPath, [nextBin, mode, "-H", appHost, "-p", appPort], {
  cwd: root,
  env: process.env,
  stdio: "inherit"
});
const worker = spawn(process.execPath, ["--env-file-if-exists=.env.local", "src/worker-multi.mjs"], {
  cwd: root,
  env: process.env,
  stdio: "inherit"
});

let stopping = false;
function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  next.kill();
  worker.kill();
  process.exitCode = exitCode;
}

next.on("exit", (code) => stop(code ?? 1));
worker.on("exit", (code) => stop(code ?? 1));
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
