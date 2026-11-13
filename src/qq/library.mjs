import { card, formatShanghaiTime } from "./format.mjs";

const SEAT_URL = "https://seat.ucasr.cn/api/layout/getremainseat";
export const SELF_STUDY_AREA = "三层中厅自助学习区";
export const LIBRARY_POLL_MS = 15_000;
const AREAS = [["三层南区", 0], [SELF_STUDY_AREA, 3], ["二层北区", 4]];

export function validSeatCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export async function fetchLibrarySeats({ fetchImpl = fetch, signal } = {}) {
  const timeout = AbortSignal.timeout(5_000);
  const response = await fetchImpl(SEAT_URL, {
    redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  });
  if (!response.ok) throw new Error("图书馆余座接口响应失败");
  const payload = await response.json();
  if (payload?.code !== 200 || !Array.isArray(payload.data) || !AREAS.every(([, index]) => validSeatCount(payload.data[index]))) {
    throw new Error("图书馆余座接口数据无效");
  }
  return { counts: Object.fromEntries(AREAS.map(([area, index]) => [area, payload.data[index]])), observedAt: Date.now() };
}

export function formatLibrarySeats({ counts, observedAt }) {
  return card("雁栖馆 · 余座查询", [
    ...AREAS.map(([area]) => [area, `${counts[area]} 席`]),
    ["查询时间", `${formatShanghaiTime(observedAt)}（北京时间）`]
  ], { footer: "余座仅供参考，以图书馆预约小程序为准。" });
}

export function formatLibraryChange(previous, current, observedAt) {
  return card("雁栖馆 · 自助区余座变化", [
    ["区域", SELF_STUDY_AREA],
    ["余座", `${previous} 席 → ${current} 席`],
    ["检测时间", `${formatShanghaiTime(observedAt)}（北京时间）`]
  ], { footer: "不再提醒可发送“关闭订阅”。" });
}

export function createLibraryPoller({ store, query, signal, log = () => {} }) {
  let inFlight;
  let failed = false;
  return function poll() {
    if (signal?.aborted) return Promise.resolve();
    inFlight ??= (async () => {
      try {
        if (!await store.hasLibrarySubscriptions() || signal?.aborted) return;
        const { counts, observedAt } = await query();
        if (signal?.aborted) return;
        await store.observeLibrarySeats(counts[SELF_STUDY_AREA], observedAt);
        failed = false;
      } catch {
        if (!failed && !signal?.aborted) log("图书馆余座监测暂时失败，保留上次结果并稍后重试");
        failed = true;
      }
    })().finally(() => { inFlight = undefined; });
    return inFlight;
  };
}
