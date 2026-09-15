"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { appUrl } from "../app-path";

type SignTiming = {
  mode: "fixed" | "random";
  fixedMinutes: number;
  minMinutes: number;
  maxMinutes: number;
};
type Account = { id: string; username: string; usernameHint: string; enabled: boolean; timing: SignTiming };
type PlanItem = {
  key: string; courseName: string; teacherName: string; courseId: string; courseIds: string[];
  start: number; attemptAt: number; state: string;
  targetCount: number; attempts: number; message: string;
};
type AccountStatus = {
  id: string; enabled: boolean; date: string; lastScheduleAt: number | null;
  nextScheduleAt: number | null; lastError: string;
  scheduleState: "waiting" | "ready" | "no_courses" | "error"; plan: PlanItem[];
};
type WorkerStatus = { updatedAt: string; lastError: string; accounts: AccountStatus[] };
type AutomationResponse = {
  settings: { accounts: Account[] };
  worker: WorkerStatus | null;
  events: { at: string; message: string }[];
  message?: string;
};

function formatTime(timestamp: number | null | undefined) {
  if (!timestamp || !Number.isFinite(timestamp)) return "--";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).format(timestamp);
}

export default function AutomationPanelMulti() {
  const [access, setAccess] = useState<"loading" | "ready" | "unavailable">("loading");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [newPasswords, setNewPasswords] = useState<Record<string, string>>({});
  const [timingDrafts, setTimingDrafts] = useState<Record<string, SignTiming>>({});
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [worker, setWorker] = useState<WorkerStatus | null>(null);
  const [events, setEvents] = useState<{ at: string; message: string }[]>([]);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [clockNow, setClockNow] = useState(0);
  const enabledAccounts = accounts.filter((account) => account.enabled);
  const allDoneToday = enabledAccounts.length > 0 && enabledAccounts.every((account) => {
    const status = worker?.accounts?.find((item) => item.id === account.id);
    return status?.scheduleState === "no_courses" || Boolean(status?.plan?.length && status.plan.every((item) => item.state === "已签到"));
  });

  const load = useCallback(async () => {
    try {
      const response = await fetch(appUrl("/api/automation"), { cache: "no-store" });
      const data = (await response.json()) as AutomationResponse;
      if (response.status === 401) { window.location.assign(appUrl("/access")); return; }
      if (response.status === 503) {
        setAccess("unavailable");
        setMessage(data.message ?? "自动签到服务未配置");
        return;
      }
      if (!response.ok) { setMessage(data.message ?? "读取自动签到状态失败"); return; }
      setAccess("ready");
      const nextAccounts = data.settings.accounts ?? [];
      setAccounts(nextAccounts);
      setTimingDrafts((current) => Object.fromEntries(nextAccounts.map((account) => [
        account.id,
        current[account.id] ?? account.timing
      ])));
      setWorker(data.worker);
      setEvents(data.events ?? []);
    } catch {
      setMessage("无法连接本地服务，请确认网页和后台进程都在运行");
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => { setClockNow(Date.now()); void load(); }, 0);
    const timer = window.setInterval(() => { setClockNow(Date.now()); void load(); }, allDoneToday ? 60_000 : 5_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [load, allDoneToday]);

  async function mutate(body: Record<string, unknown>, successMessage: string) {
    setSaving(true);
    setMessage("");
    try {
      const response = await fetch(appUrl("/api/automation"), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "操作失败");
      setMessage(successMessage);
      await load();
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "操作失败");
      return false;
    } finally { setSaving(false); }
  }

  async function onAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const added = await mutate({ action: "add", username, password }, "账号已添加并启用，后台会获取今天的课表。");
    if (added) { setUsername(""); setPassword(""); }
  }

  async function onRemove(account: Account) {
    if (!window.confirm(`确定删除学号 ${account.username} 的保存信息和后续自动签到任务吗？`)) return;
    await mutate({ action: "remove", accountId: account.id }, `${account.username} 已移除。`);
  }

  async function onUpdatePassword(account: Account) {
    const replacement = newPasswords[account.id] ?? "";
    if (!replacement) { setMessage("请先填写新密码"); return; }
    const saved = await mutate({ action: "password", accountId: account.id, password: replacement }, `${account.username} 的密码已更新。`);
    if (saved) setNewPasswords((current) => ({ ...current, [account.id]: "" }));
  }

  function updateTiming(account: Account, patch: Partial<SignTiming>) {
    setTimingDrafts((current) => ({
      ...current,
      [account.id]: { ...(current[account.id] ?? account.timing), ...patch }
    }));
  }

  async function onSaveTiming(account: Account) {
    const timing = timingDrafts[account.id] ?? account.timing;
    if (timing.mode === "random" && timing.minMinutes > timing.maxMinutes) {
      setMessage("随机区间中，最多提前分钟数不能小于最少提前分钟数");
      return;
    }
    await mutate({ action: "timing", accountId: account.id, timing }, `${account.username} 的签到时间已更新。`);
  }

  const online = worker && clockNow - new Date(worker.updatedAt).getTime() < 15_000;

  return (
    <section id="main-content" className="grid items-start gap-5 xl:grid-cols-[minmax(320px,400px)_minmax(0,1fr)]">
      <div className="space-y-5">
        <div className="panel rounded-2xl p-5 sm:p-6">
          <h2 className="font-[var(--font-serif)] text-2xl font-semibold">自动签到账号</h2>
          <p className="mt-2 text-sm leading-6 text-[color:var(--muted)]">在这里维护多个学号。每个账号独立查询课表、签到和记录结果。</p>
          {access === "loading" ? <p className="mt-5 text-sm">正在读取设置…</p> : null}
          {access === "unavailable" ? <p className="status-banner status-banner--error mt-5 rounded-xl px-3 py-3 text-sm">{message}。请检查服务器配置。</p> : null}
          {access === "ready" ? (
            <>
              <form onSubmit={onAdd} className="mt-5 space-y-4">
                <h3 className="font-semibold">添加学号</h3>
                <label className="block text-sm font-semibold">学号
                  <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" spellCheck={false} required
                    className="focus-ring input-surface mt-2 w-full rounded-xl border border-[color:var(--line)] px-4 py-2.5" />
                </label>
                <label className="block text-sm font-semibold">密码
                  <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required
                    className="focus-ring input-surface mt-2 w-full rounded-xl border border-[color:var(--line)] px-4 py-2.5" />
                </label>
                <button disabled={saving || accounts.length >= 20} className="action-btn action-btn--primary min-h-11 rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60">添加并启用</button>
              </form>
              <p className="mt-4 text-xs leading-5 text-[color:var(--muted)]">最多 20 个账号。密码加密保存在服务器，接口和日志都不会返回密码。</p>
            </>
          ) : null}
          {message && access !== "unavailable" ? <p role="status" className="mt-4 text-sm leading-6">{message}</p> : null}
        </div>
        {access === "ready" ? accounts.map((account) => (
          <div key={account.id} className="panel rounded-2xl p-5 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-[var(--font-serif)] text-xl font-semibold">{account.username}</h3>
              <span className="text-sm">{account.enabled ? "自动签到已启用" : "已暂停"}</span>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" disabled={saving} onClick={() => void mutate({ action: "toggle", accountId: account.id, enabled: !account.enabled }, account.enabled ? "已暂停该账号。" : "已启用该账号。")}
                className="action-btn action-btn--secondary min-h-11 rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60">{account.enabled ? "暂停" : "启用"}</button>
              <button type="button" disabled={saving || !account.enabled} onClick={() => void mutate({ action: "refresh", accountId: account.id }, "已请求重新获取课表。")}
                className="action-btn action-btn--secondary min-h-11 rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60">刷新课表</button>
              <button type="button" disabled={saving} onClick={() => void onRemove(account)}
                className="action-btn action-btn--quiet min-h-11 rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60">移除</button>
            </div>
            <div className="mt-5 rounded-xl border border-[color:var(--line)] bg-[color:var(--surface-raised)] p-4">
              <h4 className="font-semibold">签到时间</h4>
              <p className="mt-1 text-xs leading-5 text-[color:var(--muted)]">每节课单独计算；随机结果对同一账号和课程保持稳定，后台重启不会重新抽取。</p>
              <label className="mt-3 block text-sm font-semibold">方式
                <select value={(timingDrafts[account.id] ?? account.timing).mode}
                  onChange={(event) => updateTiming(account, { mode: event.target.value as SignTiming["mode"] })}
                  className="focus-ring input-surface mt-2 w-full rounded-xl border border-[color:var(--line)] px-4 py-2.5">
                  <option value="fixed">固定提前</option>
                  <option value="random">随机区间</option>
                </select>
              </label>
              {(timingDrafts[account.id] ?? account.timing).mode === "fixed" ? (
                <label className="mt-3 block text-sm font-semibold">提前分钟数
                  <input type="number" min="1" max="120" step="1"
                    value={(timingDrafts[account.id] ?? account.timing).fixedMinutes}
                    onChange={(event) => updateTiming(account, { fixedMinutes: Number(event.target.value) })}
                    className="focus-ring input-surface mt-2 w-full rounded-xl border border-[color:var(--line)] px-4 py-2.5" />
                </label>
              ) : (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="block text-sm font-semibold">最少提前（分钟）
                    <input type="number" min="1" max="120" step="1"
                      value={(timingDrafts[account.id] ?? account.timing).minMinutes}
                      onChange={(event) => updateTiming(account, { minMinutes: Number(event.target.value) })}
                      className="focus-ring input-surface mt-2 w-full rounded-xl border border-[color:var(--line)] px-4 py-2.5" />
                  </label>
                  <label className="block text-sm font-semibold">最多提前（分钟）
                    <input type="number" min="1" max="120" step="1"
                      value={(timingDrafts[account.id] ?? account.timing).maxMinutes}
                      onChange={(event) => updateTiming(account, { maxMinutes: Number(event.target.value) })}
                      className="focus-ring input-surface mt-2 w-full rounded-xl border border-[color:var(--line)] px-4 py-2.5" />
                  </label>
                </div>
              )}
              <button type="button" disabled={saving} onClick={() => void onSaveTiming(account)}
                className="action-btn action-btn--quiet mt-3 min-h-11 rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60">保存签到时间</button>
            </div>
            <label className="mt-4 block text-sm font-semibold">更新密码
              <input type="password" value={newPasswords[account.id] ?? ""} onChange={(event) => setNewPasswords((current) => ({ ...current, [account.id]: event.target.value }))}
                autoComplete="new-password" className="focus-ring input-surface mt-2 w-full rounded-xl border border-[color:var(--line)] px-4 py-2.5" />
            </label>
            <button type="button" disabled={saving || !newPasswords[account.id]} onClick={() => void onUpdatePassword(account)}
              className="action-btn action-btn--quiet mt-3 min-h-11 rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60">保存新密码</button>
          </div>
        )) : null}
      </div>

      <div className="space-y-5">
        <div className="panel rounded-2xl p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-[var(--font-serif)] text-2xl font-semibold">今日签到计划</h2>
            {access === "ready" ? <span className="text-xs text-[color:var(--muted)]">后台：{online ? "运行中" : "未运行或状态过期"}</span> : null}
          </div>
          {access !== "ready" ? <p className="mt-5 text-sm text-[color:var(--muted)]">解锁后查看各账号的课程和结果。</p> : null}
          {access === "ready" && worker?.lastError ? <p className="status-banner status-banner--error mt-4 rounded-xl px-3 py-2 text-sm">{worker.lastError}</p> : null}
          {access === "ready" && accounts.length === 0 ? <p className="mt-5 text-sm text-[color:var(--muted)]">尚未添加账号。</p> : null}
          {access === "ready" ? accounts.map((account) => {
            const status = worker?.accounts?.find((item) => item.id === account.id);
            return (
              <section key={account.id} className="mt-5 border-t border-[color:var(--line)] pt-4">
                <h3 className="text-lg font-semibold">{account.username} · {account.enabled ? "已启用" : "已暂停"}</h3>
                {account.enabled ? <p className="mt-1 text-xs leading-5 text-[color:var(--muted)]">上次查询：{formatTime(status?.lastScheduleAt)}；下次查询：{formatTime(status?.nextScheduleAt)}</p> : null}
                {status?.lastError ? <p className="status-banner status-banner--error mt-3 rounded-xl px-3 py-2 text-sm">{status.lastError}</p> : null}
                {account.enabled && status?.scheduleState === "no_courses" ? <p className="status-banner status-banner--success mt-3 rounded-xl px-3 py-2 text-sm">今日无课，今天不再查询课表；下次将在明日 06:00 查询。</p> : null}
                {account.enabled && status?.scheduleState !== "no_courses" && !status?.plan?.length ? <p className="mt-3 text-sm text-[color:var(--muted)]">尚无课程计划。未查询时会在 06:00 获取；查询失败时每 5 分钟重试。</p> : null}
                {account.enabled && status?.plan?.map((item) => (
                  <article key={item.key} className="clay-card mt-3 rounded-xl border border-[color:var(--line)] bg-[color:var(--surface-raised)] p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2"><h4 className="font-semibold">{item.courseName || "未命名课程"}</h4><span className="text-sm font-semibold text-[color:var(--green)]">{item.state}</span></div>
                    <p className="mt-2 text-xs leading-5 text-[color:var(--muted)]">{item.teacherName ? `${item.teacherName} · ` : ""}{formatTime(item.start)} 上课 · {formatTime(item.attemptAt)} 开始尝试</p>
                    <p className="mt-1 text-xs leading-5 text-[color:var(--muted)]">
                      课程入口 {item.courseIds?.join(" / ") || item.courseId} · 已尝试 {item.attempts} 次
                    </p>
                    {item.targetCount > 1 ? <p className="mt-1 text-xs leading-5 text-[color:var(--muted)]">同一时间段有 {item.targetCount} 个入口，后台会依次轮换尝试，任一成功即停止。</p> : null}
                    {item.message ? <p className="mt-2 text-sm leading-5">{item.message}</p> : null}
                  </article>
                ))}
              </section>
            );
          }) : null}
        </div>
        <div className="panel rounded-2xl p-5 sm:p-6">
          <h2 className="font-[var(--font-serif)] text-2xl font-semibold">运行日志</h2>
          {access !== "ready" ? <p className="mt-5 text-sm text-[color:var(--muted)]">解锁后查看记录。</p> :
            events.length === 0 ? <p className="mt-5 text-sm text-[color:var(--muted)]">暂无记录；后台重启后会开始记录。</p> : (
              <ol className="mt-4 max-h-96 space-y-3 overflow-y-auto pr-1" aria-label="最近运行日志">
                {[...events].reverse().map((event, index) => (
                  <li key={`${event.at}-${index}`} className="border-b border-[color:var(--line)] pb-3 text-sm leading-6 last:border-b-0">
                    <time className="mr-2 text-xs text-[color:var(--muted)]" dateTime={event.at}>{formatTime(new Date(event.at).getTime())}</time>{event.message}
                  </li>
                ))}
              </ol>
            )}
          {access === "ready" ? <p className="mt-3 text-xs text-[color:var(--muted)]">显示最近 100 条，按脱敏学号区分账号。</p> : null}
        </div>
      </div>
    </section>
  );
}
