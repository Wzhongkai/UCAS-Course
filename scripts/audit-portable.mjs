import { readFile, readdir } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";

const root = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("用法：node scripts/audit-portable.mjs <package-directory>");

const forbiddenFiles = new Set([
  ".env", ".env.local", ".env.production", ".env.development", "secrets.env",
  "automation.json", "status.json", "events.json", "completed.json", "auto-sign.log"
]);
const textExtensions = new Set([".js", ".mjs", ".cjs", ".json", ".ts", ".tsx", ".css", ".html", ".txt", ".md", ".cmd", ".sh", ".map"]);
const secretNames = ["AUTO_SIGN_SECRET", "UCAS_ACCESS_KEY", "AUTO_SIGN_ADMIN_TOKEN"];
const secrets = secretNames.map((name) => process.env[name]).filter((value) => value?.length >= 16);

try {
  const envText = await readFile(resolve(".env.local"), "utf8");
  for (const line of envText.split(/\r?\n/u)) {
    const match = line.match(/^\s*(?:export\s+)?(AUTO_SIGN_SECRET|UCAS_ACCESS_KEY|AUTO_SIGN_ADMIN_TOKEN)\s*=\s*(.*?)\s*$/u);
    if (!match) continue;
    const value = match[2].replace(/^(?:"(.*)"|'(.*)')$/u, (_whole, double, single) => double ?? single);
    if (value.length >= 16) secrets.push(value);
  }
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const location = relative(root, path);
    if (entry.isSymbolicLink()) throw new Error(`便携包中不应包含符号链接：${location}`);
    if (entry.isDirectory()) {
      if (entry.name === "data") throw new Error(`便携包中包含运行数据目录：${location}`);
      await inspect(path);
    } else if (entry.isFile()) {
      if (forbiddenFiles.has(basename(path))) throw new Error(`便携包中包含私有文件：${location}`);
      if (!textExtensions.has(extname(path).toLowerCase())) continue;
      const content = await readFile(path, "utf8");
      for (const secret of secrets) {
        if (content.includes(secret)) throw new Error(`便携包中包含本机密钥：${location}`);
      }
    } else {
      throw new Error(`便携包中包含不支持的文件类型：${location}`);
    }
  }
}

await inspect(root);
console.log(`便携包敏感信息检查通过：${root.split(sep).at(-1)}`);
