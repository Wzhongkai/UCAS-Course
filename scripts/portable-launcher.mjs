import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
const PORT = parsePort(process.env.UCAS_PORT ?? process.env.APP_PORT ?? "3100");
const STARTUP_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 250;

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error("UCAS_PORT/APP_PORT 必须是 1024 到 65535 之间的端口");
  }
  return port;
}

function applicationDirectory() {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) throw new Error("未找到 %LOCALAPPDATA%，无法创建本地数据目录");
    return join(localAppData, "UCAS-Course");
  }
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "UCAS-Course");
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "UCAS-Course");
}

function parseEnvFile(text) {
  const values = {};
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/u);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

async function readExistingSecrets(file) {
  try {
    return parseEnvFile(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

async function ensureSecrets(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try { await chmod(directory, 0o700); } catch (error) {
    if (process.platform !== "win32") throw error;
  }
  const file = join(directory, "secrets.env");
  let existing;
  try {
    existing = await readExistingSecrets(file);
  } catch (error) {
    throw new Error(`读取本地运行密钥失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (existing.AUTO_SIGN_SECRET !== undefined) {
    const keys = Object.keys(existing);
    if (keys.length !== 1 || !/^[a-f\d]{64}$/iu.test(existing.AUTO_SIGN_SECRET)) {
      throw new Error(`本地运行密钥文件中的 AUTO_SIGN_SECRET 格式错误：${file}`);
    }
    try { await chmod(file, 0o600); } catch (error) {
      if (process.platform !== "win32") throw error;
    }
    return { AUTO_SIGN_SECRET: existing.AUTO_SIGN_SECRET, file };
  }
  if (Object.keys(existing).length > 0) {
    throw new Error("本地运行密钥文件包含未知配置，未覆盖任何内容");
  }
  const secret = randomBytes(32).toString("hex");
  const contents = [
    "# UCAS Course 本地运行密钥；请勿复制到项目目录或提交到 Git。",
    `AUTO_SIGN_SECRET=${secret}`,
    ""
  ].join("\n");
  try {
    await writeFile(file, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return { AUTO_SIGN_SECRET: secret, file };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const raced = await readExistingSecrets(file);
    if (Object.keys(raced).length !== 1 || !/^[a-f\d]{64}$/iu.test(raced.AUTO_SIGN_SECRET || "")) {
      throw new Error("并发创建的本地运行密钥文件格式错误，未覆盖任何内容");
    }
    return { AUTO_SIGN_SECRET: raced.AUTO_SIGN_SECRET, file };
  }
}

function runtimePath() {
  return join(PACKAGE_ROOT, "runtime", process.platform === "win32" ? "node.exe" : "node");
}

function childIsRunning(child) {
  return child && child.exitCode === null && child.signalCode === null;
}

function runTaskkill(pid) {
  return new Promise((resolve) => {
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
    killer.once("error", () => resolve());
    killer.once("exit", () => resolve());
  });
}

async function terminateChild(child) {
  if (!childIsRunning(child)) return;
  if (process.platform === "win32") await runTaskkill(child.pid);
  else child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000))
  ]);
  if (childIsRunning(child)) child.kill("SIGKILL");
}

async function waitForHttp(url, children, failure) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (failure.error) throw failure.error;
    if (children.some((child) => !childIsRunning(child))) {
      throw new Error("网页或后台进程在服务就绪前退出");
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
      if (response.status >= 200 && response.status < 500) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`网页服务在 ${STARTUP_TIMEOUT_MS / 1_000} 秒内未就绪：${url}`);
}

async function openBrowser(url) {
  try {
    let opener;
    if (process.platform === "win32") {
      const command = process.env.ComSpec || "cmd.exe";
      opener = spawn(command, ["/d", "/s", "/c", `start "" "${url}"`], {
        detached: true,
        stdio: "ignore",
        windowsHide: true
      });
    } else {
      const command = process.platform === "darwin" ? "open" : "xdg-open";
      opener = spawn(command, [url], { detached: true, stdio: "ignore" });
    }
    const opened = await new Promise((resolve) => {
      opener.once("error", (error) => {
        console.error(`无法自动打开浏览器：${error.message}。请手动打开 ${url}`);
        resolve(false);
      });
      opener.once("exit", (code) => {
        if (code !== 0) console.error(`无法自动打开浏览器（退出码 ${code}）。请手动打开 ${url}`);
        resolve(code === 0);
      });
    });
    opener.unref();
    return opened;
  } catch (error) {
    console.error(`无法自动打开浏览器：${error instanceof Error ? error.message : String(error)}。请手动打开 ${url}`);
    return false;
  }
}

let activeChildren = [];

async function main() {
  const dataRoot = applicationDirectory();
  const { AUTO_SIGN_SECRET } = await ensureSecrets(dataRoot);
  const dataDirectory = join(dataRoot, "data");
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const node = runtimePath();
  await access(node);

  // Do not inherit a server access key. The desktop mode intentionally uses
  // loopback-only access and authenticates the process boundary instead.
  const environment = { ...process.env };
  delete environment.UCAS_ACCESS_KEY;
  delete environment.AUTO_SIGN_ADMIN_TOKEN;
  Object.assign(environment, {
    AUTO_SIGN_SECRET,
    AUTO_SIGN_DATA_DIR: dataDirectory,
    LOCAL_DESKTOP_MODE: "1",
    APP_HOST: "127.0.0.1",
    APP_PORT: String(PORT),
    HOSTNAME: "127.0.0.1",
    PORT: String(PORT),
    APP_BASE_PATH: "",
    NEXT_PUBLIC_BASE_PATH: "",
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1"
  });

  const server = spawn(node, [join(PACKAGE_ROOT, "server.js")], {
    cwd: PACKAGE_ROOT,
    env: environment,
    stdio: "inherit",
    windowsHide: false
  });
  const worker = spawn(node, [join(PACKAGE_ROOT, "src", "worker-multi.mjs")], {
    cwd: PACKAGE_ROOT,
    env: environment,
    stdio: "inherit",
    windowsHide: false
  });
  const children = [server, worker];
  activeChildren = children;
  const failure = { error: null };
  let requested = false;
  let ready = false;
  let stopCode = 0;
  let stopped;
  const stoppedPromise = new Promise((resolve) => { stopped = resolve; });
  for (const child of children) {
    child.once("error", (error) => { failure.error = error; });
    child.once("exit", (code, signal) => {
      if (!ready) return;
      if (!requested) stopCode = code === 0 ? 1 : (code || 1);
      stopped();
    });
  }

  await waitForHttp(`http://127.0.0.1:${PORT}/`, children, failure);
  ready = true;
  if (children.some((child) => !childIsRunning(child))) {
    throw new Error("网页或后台进程在服务就绪后意外退出");
  }
  console.log(`UCAS Course 已启动：http://127.0.0.1:${PORT}/`);
  console.log(`本地数据目录：${dataRoot}`);
  await openBrowser(`http://127.0.0.1:${PORT}/`);

  const stop = () => { requested = true; stopped(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("SIGHUP", stop);
  await stoppedPromise;
  return { children, code: stopCode };
}

let result;
try {
  result = await main();
} catch (error) {
  console.error(`UCAS Course 启动失败：${error instanceof Error ? error.message : String(error)}`);
  result = { children: activeChildren, code: 1 };
}

for (const child of [...(result.children || [])].reverse()) {
  try { await terminateChild(child); }
  catch (error) { console.error(`清理子进程失败：${error instanceof Error ? error.message : String(error)}`); }
}
process.exitCode = result.code;
