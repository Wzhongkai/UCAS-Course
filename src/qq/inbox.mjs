import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { dataDirectory } from "../automation/store.mjs";
import { withFileLock } from "../automation/file-lock.mjs";
import { writeJsonAtomically } from "../automation/atomic-json.mjs";

const RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1000;
const REPLY_TTL_MS = 5 * 60 * 1000;
const PROCESSING_TTL_MS = 120 * 1000;
const MAX_RECEIPTS = 5_000;
const MAX_REPLY_PARTS = 4;
const RECOVERY_REPLY = "上次指令执行中断，结果可能已生效，请查看账号状态后重新发送。";
const BUSY_REPLY = "当前消息较多，请稍后重试。";

function safeAppId(value) {
  return String(value ?? "local").trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "local";
}

function cleanId(value, label) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 200) {
    throw new Error(`${label}无效`);
  }
  return value.trim();
}

function secretKey(secret) {
  if (typeof secret !== "string" || !/^[a-f\d]{64}$/i.test(secret)) {
    throw new Error("AUTO_SIGN_SECRET 必须是 64 位十六进制字符串");
  }
  return Buffer.from(secret, "hex");
}

function encryptReply(reply, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(reply, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
}

function decryptReply(value, key) {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64"));
    decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(value.ciphertext, "base64")),
      decipher.final()
    ]).toString("utf8");
  } catch {
    throw new Error("QQ 收件箱回复解密失败，密钥不匹配或数据已损坏");
  }
}

function emptyState() {
  return { version: 1, receipts: {} };
}

async function readState(file) {
  try {
    const state = JSON.parse(await readFile(file, "utf8"));
    if (!state || state.version !== 1 || !state.receipts || typeof state.receipts !== "object") {
      throw new Error("QQ 收件箱文件格式无效");
    }
    return state;
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw error;
  }
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function makeDelivery(receipt, key) {
  return {
    id: receipt.id,
    userId: receipt.userId,
    reply: decryptReply(receipt.encryptedReply, key),
    sentParts: receipt.sentParts ?? 0,
    createdAt: new Date(receipt.at).toISOString()
  };
}

function completeInterruptedReceipt(receipt, key, now) {
  receipt.state = "complete";
  receipt.encryptedReply = encryptReply(RECOVERY_REPLY, key);
  receipt.sentParts = 0;
  receipt.ackedParts = [];
  receipt.totalParts = null;
  receipt.completedAt = now;
  receipt.expiresAt = now + REPLY_TTL_MS;
}

function cleanupState(state, now, key) {
  let changed = false;
  for (const [id, receipt] of Object.entries(state.receipts)) {
    if (receipt.state === "processing" && (!isProcessAlive(receipt.pid) || now - receipt.at > PROCESSING_TTL_MS)) {
      completeInterruptedReceipt(receipt, key, now);
      changed = true;
      continue;
    }
    if (receipt.state === "complete" && receipt.expiresAt <= now) {
      receipt.state = "expired";
      receipt.expiredAt = now;
      delete receipt.encryptedReply;
      delete receipt.ackedParts;
      changed = true;
    }
    if (["done", "expired"].includes(receipt.state) && now - receipt.at >= RECEIPT_RETENTION_MS) {
      delete state.receipts[id];
      changed = true;
    }
  }
  return changed;
}

function fixedBusyDelivery(id, userId, now) {
  return {
    id,
    userId,
    reply: BUSY_REPLY,
    sentParts: 0,
    createdAt: new Date(now).toISOString()
  };
}

export function createInbox({
  directory = dataDirectory,
  appId = process.env.QQ_BOT_APP_ID || "local",
  secret = process.env.AUTO_SIGN_SECRET || ""
} = {}) {
  const file = resolve(directory, `qq-${safeAppId(appId)}.inbox.json`);
  const key = secretKey(secret);

  const transact = (callback) => withFileLock(file, async () => {
    const state = await readState(file);
    const result = await callback(state);
    await writeJsonAtomically(file, state);
    return result;
  });

  async function begin({ id, userId } = {}) {
    const cleanMessageId = cleanId(id, "消息编号");
    const cleanUserId = cleanId(userId, "QQ 用户");
    return transact((state) => {
      const now = Date.now();
      cleanupState(state, now, key);
      const existing = state.receipts[cleanMessageId];
      if (existing) {
        if (existing.userId !== cleanUserId) return { done: true };
        if (existing.state === "complete") return makeDelivery(existing, key);
        return { done: true };
      }

      if (Object.keys(state.receipts).length >= MAX_RECEIPTS) {
        return fixedBusyDelivery(cleanMessageId, cleanUserId, now);
      }
      state.receipts[cleanMessageId] = {
        id: cleanMessageId,
        userId: cleanUserId,
        pid: process.pid,
        at: now,
        state: "processing"
      };
      return { execute: true };
    });
  }

  async function complete(id, reply) {
    const cleanMessageId = cleanId(id, "消息编号");
    if (typeof reply !== "string") throw new Error("指令回复必须是文本");
    return transact((state) => {
      const now = Date.now();
      cleanupState(state, now, key);
      const receipt = state.receipts[cleanMessageId];
      if (!receipt) throw new Error("QQ 指令收据不存在或已过期");
      if (receipt.state === "complete") return makeDelivery(receipt, key);
      if (receipt.state !== "processing") throw new Error("QQ 指令收据已完成或已过期");
      if (!isProcessAlive(receipt.pid) || now - receipt.at > PROCESSING_TTL_MS) {
        completeInterruptedReceipt(receipt, key, now);
        return makeDelivery(receipt, key);
      }
      receipt.state = "complete";
      receipt.encryptedReply = encryptReply(reply, key);
      receipt.sentParts = 0;
      receipt.ackedParts = [];
      receipt.totalParts = null;
      receipt.completedAt = now;
      receipt.expiresAt = now + REPLY_TTL_MS;
      return makeDelivery(receipt, key);
    });
  }

  async function pending() {
    return transact((state) => {
      const now = Date.now();
      cleanupState(state, now, key);
      return Object.values(state.receipts)
        .filter((receipt) => receipt.state === "complete" && receipt.expiresAt > now)
        .map((receipt) => makeDelivery(receipt, key));
    });
  }

  async function ack(id, part, total) {
    const cleanMessageId = cleanId(id, "消息编号");
    if (!Number.isInteger(part) || !Number.isInteger(total) || total < 1 || total > MAX_REPLY_PARTS || part < 1 || part > total) {
      throw new Error("QQ 回复分片序号无效");
    }
    await transact((state) => {
      const now = Date.now();
      cleanupState(state, now, key);
      const receipt = state.receipts[cleanMessageId];
      if (!receipt || receipt.state !== "complete") return;
      if (receipt.totalParts !== null && receipt.totalParts !== total) throw new Error("QQ 回复分片总数不一致");
      receipt.totalParts = total;
      receipt.ackedParts ??= [];
      if (!receipt.ackedParts.includes(part)) receipt.ackedParts.push(part);
      receipt.ackedParts.sort((left, right) => left - right);
      let contiguousParts = 0;
      while (receipt.ackedParts.includes(contiguousParts + 1)) contiguousParts += 1;
      receipt.sentParts = contiguousParts;
      receipt.updatedAt = now;
      if (receipt.ackedParts.length >= total) {
        receipt.state = "done";
        receipt.doneAt = now;
        delete receipt.encryptedReply;
        delete receipt.ackedParts;
      }
    });
  }

  return { begin, complete, pending, ack };
}
