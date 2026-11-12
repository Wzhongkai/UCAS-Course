import { createServer } from "node:net";
import { createQqStore, LIBRARY_NOTIFICATION } from "./store.mjs";
import { createCommandHandler } from "./commands.mjs";
import { readPublicSettings } from "../automation/store.mjs";
import { QqClient, createPacedSender } from "./client.mjs";
import { createGateway } from "./gateway.mjs";
import { createInbox } from "./inbox.mjs";
import { createLibraryPoller, fetchLibrarySeats, LIBRARY_POLL_MS } from "./library.mjs";

const log = (message) => console.log(`[QQ] ${message}`);
if (process.env.QQ_BOT_ENABLED !== "1" || !process.env.QQ_BOT_APP_ID || !process.env.QQ_BOT_APP_SECRET) {
  log("尚未启用或缺少凭证，QQ 接入未启动。填写本地配置后重启即可。");
} else {
  const lock = createServer();
  const lockPort = Number(process.env.QQ_BOT_LOCK_PORT || 43858);
  try {
    await new Promise((resolve, reject) => {
      lock.once("error", reject);
      lock.listen(lockPort, "127.0.0.1", resolve);
    });
    const store = createQqStore();
    const inbox = createInbox();
    const shutdown = new AbortController();
    const api = new QqClient({ appId: process.env.QQ_BOT_APP_ID, appSecret: process.env.QQ_BOT_APP_SECRET, signal: shutdown.signal });
    const send = createPacedSender(api, { signal: shutdown.signal });
    const libraryQuery = () => fetchLibrarySeats({ signal: shutdown.signal });
    const handleCommand = createCommandHandler({ store, libraryQuery });
    const pollLibrary = createLibraryPoller({ store, query: libraryQuery, signal: shutdown.signal, log });
    const gateway = createGateway({ api, store, inbox, handleCommand, send, log });
    let draining = false;
    let stopped = false;
    let drainTask = Promise.resolve();
    const drain = async () => {
      if (draining || stopped) return;
      draining = true;
      try {
        let accounts;
        await store.drainNotifications({
          signal: shutdown.signal,
          accountExists: async (id) => {
            accounts ??= new Set((await readPublicSettings()).accounts.map((account) => account.id));
            return accounts.has(id);
          },
          send: (userId, content, delivery) => send(userId, content, {
            beforeSend: async () => {
              // Recheck after the send queue's pacing delay. A binding may
              // have been revoked while an older message was waiting.
              const accountExists = delivery.kind === LIBRARY_NOTIFICATION
                || (await readPublicSettings()).accounts.some((account) => account.id === delivery.accountId);
              const allowed = accountExists && await store.canReceiveNotification(userId, delivery);
              if (!allowed) {
                const error = new Error("通知接收关系已变化");
                error.retryable = false;
                throw error;
              }
            }
          })
        });
      } catch { log("通知队列处理失败，稍后重试"); }
      finally { draining = false; }
    };
    const timer = setInterval(() => { if (!draining && !stopped) drainTask = drain(); }, 3000);
    let libraryTask = pollLibrary();
    const libraryTimer = setInterval(() => { libraryTask = pollLibrary(); }, LIBRARY_POLL_MS);
    async function stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      clearInterval(libraryTimer);
      shutdown.abort();
      await gateway.stop();
      await Promise.allSettled([drainTask, libraryTask]);
      lock.close();
    }
    process.on("SIGINT", () => { void stop(); });
    process.on("SIGTERM", () => { void stop(); });
    await gateway.start();
  } catch {
    log("QQ 接入未启动：本地端口已被占用或配置无效，请检查是否已有机器人实例。");
    lock.close();
    process.exitCode = 1;
  }
}
