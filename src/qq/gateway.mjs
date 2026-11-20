import WebSocket from "ws";

export function splitReply(value, size = 1400) {
  const chars = Array.from(String(value));
  const chunks = [];
  while (chars.length && chunks.length < 4) {
    const candidate = chars.slice(0, size);
    const newline = candidate.lastIndexOf("\n");
    const length = chars.length > size && newline >= size / 2 ? newline + 1 : Math.min(size, chars.length);
    chunks.push(chars.splice(0, length).join(""));
  }
  if (chars.length) chunks[3] = `${Array.from(chunks[3]).slice(0, size - 24).join("")}\n内容较多，请按学号分别查询。`;
  return chunks;
}

export function createGateway({ api, store, inbox, handleCommand, send, WebSocketImpl = WebSocket, log = () => {}, reconnectMs = 3000, replyRetryMs = 3000 }) {
  let stopped = true;
  let socket;
  let heartbeat;
  let reconnect;
  let helloTimeout;
  let awaitingAck = false;
  let sessionId = "";
  let sequence = null;
  let processedSequence = null;
  let failures = 0;
  let generation = 0;
  let queued = 0;
  let tail = Promise.resolve();
  let replyWork = Promise.resolve();
  let replyTimer;
  let flushing = false;
  let dispatchFailed = false;
  const delivering = new Set();
  const replyRetries = new Map();
  const rates = new Map();

  async function status(connected, lastError = "") {
    try { await store.setRuntimeStatus({ connected, lastError, updatedAt: new Date().toISOString() }); }
    catch { log("QQ 运行状态保存失败"); }
  }

  function write(packet) {
    if (socket?.readyState !== 1) return;
    socket.send(JSON.stringify(packet));
  }

  function clearTimers() {
    clearInterval(heartbeat);
    clearTimeout(helloTimeout);
  }

  function retry() {
    clearTimers();
    if (stopped || reconnect) return;
    const delay = Math.min(60_000, reconnectMs * 2 ** Math.min(failures++, 5));
    reconnect = setTimeout(() => { reconnect = undefined; void connect(); }, delay);
  }

  function allowed(userId) {
    const minute = Math.floor(Date.now() / 60_000);
    const item = rates.get(userId);
    if (rates.size > 2000) for (const [id, value] of rates) if (value.minute !== minute) rates.delete(id);
    const next = item?.minute === minute ? { minute, count: item.count + 1 } : { minute, count: 1 };
    rates.set(userId, next);
    return next.count <= 20;
  }

  async function deliver(delivery) {
    if (stopped || delivering.has(delivery.id) || (replyRetries.get(delivery.id)?.nextAt ?? 0) > Date.now()) return;
    delivering.add(delivery.id);
    const chunks = splitReply(delivery.reply);
    try {
      if (chunks.length === 0) {
        await inbox.ack(delivery.id, 1, 1);
        replyRetries.delete(delivery.id);
        return;
      }
      for (let index = delivery.sentParts; index < chunks.length; index++) {
        if (stopped) return;
        try {
          await send(delivery.userId, chunks[index], { msgId: delivery.id, msgSeq: index + 1 });
        } catch (error) {
          // A retransmission with the same message id/sequence can be rejected
          // as duplicate after QQ already accepted the first request.
          if (error?.code !== 40054005) throw error;
        }
        await inbox.ack(delivery.id, index + 1, chunks.length);
      }
      replyRetries.delete(delivery.id);
    } catch (error) {
      if (error?.retryable === false) {
        for (let part = 1; part <= chunks.length; part++) await inbox.ack(delivery.id, part, chunks.length);
        replyRetries.delete(delivery.id);
        log("QQ 回复被平台拒绝，请检查好友关系、消息权限或被动回复时限");
      } else {
        const attempts = (replyRetries.get(delivery.id)?.attempts ?? 0) + 1;
        replyRetries.set(delivery.id, { attempts, nextAt: Date.now() + Math.max(Math.min(1000 * 2 ** Math.min(attempts, 5), 30_000), error?.retryAfterMs || 0) });
        log("QQ 回复暂未确认，已保留回执稍后重试，不会重复执行指令");
      }
    } finally {
      delivering.delete(delivery.id);
    }
  }

  async function flushReplies() {
    if (stopped || flushing || !sessionId || socket?.readyState !== 1) return;
    flushing = true;
    try {
      const pending = await inbox.pending();
      const retained = new Set(pending.map((item) => item.id));
      for (const id of replyRetries.keys()) if (!retained.has(id)) replyRetries.delete(id);
      for (const delivery of pending) {
        if (stopped) break;
        await deliver(delivery);
      }
    } catch { log("QQ 回复回执暂时无法读取，稍后重试"); }
    finally { flushing = false; }
  }

  async function dispatch(packet) {
    if (packet.t === "READY") {
      sessionId = packet.d?.session_id ?? "";
      failures = 0;
      log("QQ 机器人已连接，等待私聊指令");
      await status(true);
    } else if (packet.t === "RESUMED") {
      failures = 0;
      await status(true);
    } else if (packet.t === "C2C_MESSAGE_CREATE") {
      const data = packet.d;
      const userId = data?.author?.user_openid || data?.author?.id;
      if (!userId || data?.author?.bot || !data?.id || typeof data.content !== "string") return;
      if (!allowed(userId)) return;
      const receipt = await inbox.begin({ id: data.id, userId });
      if (receipt.done) return;
      let delivery = receipt;
      if (receipt.execute) {
        let reply;
        try { reply = await handleCommand({ userId, content: data.content }); }
        catch { reply = "⚠️ 暂时无法完成\n\n请稍后重试，也可发送“状态”查看当前配置。"; }
        delivery = await inbox.complete(data.id, reply);
      }
      await deliver(delivery);
    }
  }

  async function packetReceived(packet, token, epoch) {
    if (packet.s != null) sequence = packet.s;
    if (packet.op === 10) {
      clearTimeout(helloTimeout);
      const interval = Number(packet.d?.heartbeat_interval);
      if (!Number.isFinite(interval) || interval < 1000 || interval > 120_000) { socket?.close(); return; }
      if (sessionId && processedSequence != null) {
        write({ op: 6, d: { token: `QQBot ${token}`, session_id: sessionId, seq: processedSequence } });
      } else {
        write({ op: 2, d: { token: `QQBot ${token}`, intents: 1 << 25, shard: [0, 1] } });
      }
      awaitingAck = false;
      clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        if (awaitingAck) { socket?.terminate(); return; }
        awaitingAck = true;
        write({ op: 1, d: sequence });
      }, interval);
    } else if (packet.op === 11) {
      awaitingAck = false;
      // Keep the web dashboard heartbeat fresh without persisting private data.
      if (sessionId) await status(true);
    } else if (packet.op === 7) {
      socket?.close();
    } else if (packet.op === 9) {
      sessionId = ""; sequence = null; processedSequence = null;
      socket?.close();
    } else if (packet.op === 0) {
      if (queued >= 100) { socket?.close(); return; }
      queued++;
      tail = tail.catch(() => {}).then(async () => {
        try {
          if (stopped || dispatchFailed || epoch !== generation) return;
          await dispatch(packet);
          // A checkpoint is safe once the result is durably recoverable.
          processedSequence = packet.s ?? processedSequence;
        } catch {
          dispatchFailed = true;
          log("QQ 指令收据保存失败，将重连恢复；请查看状态后再操作");
          socket?.terminate();
        } finally { queued--; }
      });
    }
  }

  async function connect() {
    if (stopped) return;
    const version = ++generation;
    dispatchFailed = false;
    try {
      await status(false, "正在连接 QQ");
      const [url, token] = await Promise.all([api.getGateway(), api.getToken()]);
      if (stopped || version !== generation) return;
      socket = new WebSocketImpl(url, { maxPayload: 1024 * 1024, handshakeTimeout: 15_000 });
      helloTimeout = setTimeout(() => socket?.terminate(), 20_000);
      socket.on("message", (raw) => {
        if (stopped || version !== generation) return;
        let packet;
        try { packet = JSON.parse(raw.toString()); } catch { return; }
        void packetReceived(packet, token, version).catch(() => { log("QQ 事件处理失败"); });
      });
      socket.on("error", () => { log("QQ 连接异常，将自动重连"); });
      socket.on("close", (code) => {
        if (version !== generation) return;
        void status(false, stopped ? "已停止" : `QQ 连接关闭（${code}）`);
        if ([4006, 4007, 4010, 4011].includes(code)) { sessionId = ""; processedSequence = null; sequence = null; }
        if ([4013, 4014, 4914, 4915].includes(code)) {
          stopped = true;
          clearTimers();
          log(`QQ 权限或机器人状态不允许连接（${code}），请在平台检查后重启`);
          return;
        }
        retry();
      });
    } catch {
      await status(false, "连接失败，请检查凭证、网络和平台权限");
      log("QQ 连接失败，将自动重试；不会输出密钥");
      retry();
    }
  }

  return {
    async start() {
      if (!stopped) return;
      stopped = false;
      replyTimer = setInterval(() => { if (!flushing) replyWork = flushReplies(); }, replyRetryMs);
      await connect();
    },
    async stop() {
      stopped = true;
      generation++;
      clearTimers();
      clearInterval(replyTimer);
      clearTimeout(reconnect);
      reconnect = undefined;
      socket?.terminate();
      await tail.catch(() => {});
      await replyWork.catch(() => {});
      await status(false, "已停止");
    },
    // Wait for queued commands in tests and during orderly shutdown.
    async idle() { await tail; await replyWork; }
  };
}
