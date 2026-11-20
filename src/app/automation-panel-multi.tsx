"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { appUrl } from "../app-path";
import { DEFAULT_SIGN_METHOD, signMethodLabel } from "../sign-url.mjs";

type SignMethod = "timeTableId" | "courseSchedId";
type SignTiming = {
  mode: "fixed" | "random";
  fixedMinutes: number;
  minMinutes: number;
  maxMinutes: number;
};
type Account = {
  id: string; username: string; usernameHint: string; enabled: boolean; timing: SignTiming;
  signMethod?: SignMethod;
  courseTimingOverrides?: Record<string, SignTiming>;
  courseSignMethodOverrides?: Record<string, SignMethod>;
  courseWhitelist: string[];
};
type PlanItem = {
  key: string; courseName: string; teacherName: string; courseId: string; courseIds: string[];
  start: number; attemptAt: number; state: string;
  targetCount: number; attempts: number; message: string;
  signMethod?: SignMethod; effectiveSignMethod?: SignMethod;
};
type AccountStatus = {
  id: string; enabled: boolean; date: string; lastScheduleAt: number | null;
  nextScheduleAt: number | null; lastError: string;
  scheduleState: "waiting" | "ready" | "no_courses" | "no_matching_courses" | "error"; plan: PlanItem[];
};
type WorkerStatus = { updatedAt: string; lastError: string; accounts: AccountStatus[] };
type AutomationResponse = {
  settings: { accounts: Account[] };
  worker: WorkerStatus | null;
  events: { at: string; message: string }[];
  message?: string;
};
type QqBinding = { accountId: string; bindingId: string; bound: boolean; mode: "all" | "failure" | "off"; userHint: string | null };
type QqStatus = {
  bindings: QqBinding[];
  pending: number;
  failed: number;
  sent: number;
  runtime: Record<string, unknown> | null;
  configured: boolean;
  message?: string;
};
type QqBindingCode = { code: string; expiresAt: string };
type ServerDraftValues = { timing: SignTiming; signMethod: SignMethod; whitelist: string };

function qqRuntimeOnline(runtime: QqStatus["runtime"]) {
  if (!runtime) return false;
  if (runtime.connected !== true || typeof runtime.updatedAt !== "string") return false;
  const updatedAt = Date.parse(runtime.updatedAt);
  return Number.isFinite(updatedAt) && Date.now() - updatedAt < 120_000;
}

function qqRuntimeErrorText(runtime: QqStatus["runtime"]) {
  if (typeof runtime?.lastError !== "string") return "";
  return runtime.lastError.trim().slice(0, 300);
}

function sameTiming(left: SignTiming, right: SignTiming) {
  return left.mode === right.mode
    && left.fixedMinutes === right.fixedMinutes
    && left.minMinutes === right.minMinutes
    && left.maxMinutes === right.maxMinutes;
}

function timingError(timing: SignTiming) {
  if (timing.mode === "fixed") {
    return Number.isInteger(timing.fixedMinutes) && timing.fixedMinutes >= 1 && timing.fixedMinutes <= 30
      ? ""
      : "提前分钟数必须是 1 到 30 的整数";
  }
  if (!Number.isInteger(timing.minMinutes) || !Number.isInteger(timing.maxMinutes)
    || timing.minMinutes < 1 || timing.maxMinutes > 30) {
    return "随机区间必须是 1 到 30 的整数分钟";
  }
  if (timing.minMinutes > timing.maxMinutes) return "最多提前分钟数不能小于最少提前分钟数";
  return "";
}

function timingLabel(timing: SignTiming) {
  return timing.mode === "fixed"
    ? `固定提前 ${timing.fixedMinutes} 分钟`
    : `随机提前 ${timing.minMinutes}–${timing.maxMinutes} 分钟`;
}

function whitelistValue(account: Account) {
  return (account.courseWhitelist ?? []).join("\n");
}

function formatTime(timestamp: number | null | undefined) {
  if (!timestamp || !Number.isFinite(timestamp)) return "--";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).format(timestamp);
}

function planStateTone(state: string) {
  if (state === "已签到") return "pill-tag--emerald";
  if (state === "重试中") return "pill-tag--amber";
  if (state === "准备中") return "pill-tag--blue";
  if (state === "未成功，已停止") return "pill-tag--rose";
  return "";
}

export default function AutomationPanelMulti() {
  const [access, setAccess] = useState<"loading" | "ready" | "unavailable">("loading");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [newPasswords, setNewPasswords] = useState<Record<string, string>>({});
  const [timingDrafts, setTimingDrafts] = useState<Record<string, SignTiming>>({});
  const [signMethodDrafts, setSignMethodDrafts] = useState<Record<string, SignMethod>>({});
  const [whitelistDrafts, setWhitelistDrafts] = useState<Record<string, string>>({});
  const [courseNameDrafts, setCourseNameDrafts] = useState<Record<string, string>>({});
  const [courseTimingDrafts, setCourseTimingDrafts] = useState<Record<string, SignTiming>>({});
  const [courseMethodNameDrafts, setCourseMethodNameDrafts] = useState<Record<string, string>>({});
  const [courseMethodDrafts, setCourseMethodDrafts] = useState<Record<string, SignMethod>>({});
  const serverDraftValues = useRef<Record<string, ServerDraftValues>>({});
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [worker, setWorker] = useState<WorkerStatus | null>(null);
  const [events, setEvents] = useState<{ at: string; message: string }[]>([]);
  const [qq, setQq] = useState<QqStatus | null>(null);
  const [qqError, setQqError] = useState("");
  const [qqBusy, setQqBusy] = useState<Record<string, boolean>>({});
  const [qqMessage, setQqMessage] = useState("");
  const [bindingCodes, setBindingCodes] = useState<Record<string, QqBindingCode>>({});
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [clockNow, setClockNow] = useState(0);
  const [expandedAccounts, setExpandedAccounts] = useState<Record<string, boolean>>({});
  const enabledAccounts = accounts.filter((account) => account.enabled);
  const allDoneToday = enabledAccounts.length > 0 && enabledAccounts.every((account) => {
    const status = worker?.accounts?.find((item) => item.id === account.id);
    return status?.scheduleState === "no_courses" || status?.scheduleState === "no_matching_courses" || Boolean(status?.plan?.length && status.plan.every((item) => item.state === "已签到"));
  });

  const loadQq = useCallback(async () => {
    try {
      const response = await fetch(appUrl("/api/qq"), { cache: "no-store" });
      const data = (await response.json()) as QqStatus;
      if (response.status === 401) return;
      if (!response.ok) {
        setQqError(data.message ?? "读取 QQ 通知状态失败");
        return;
      }
      setQq(data);
      setQqError("");
    } catch {
      setQqError("无法读取 QQ 通知状态");
    }
  }, []);

  const load = useCallback(async () => {
    void loadQq();
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
      const previousServerDrafts = serverDraftValues.current;
      const nextServerDrafts = Object.fromEntries(nextAccounts.map((account) => [account.id, {
        timing: { ...account.timing },
        signMethod: account.signMethod ?? DEFAULT_SIGN_METHOD,
        whitelist: whitelistValue(account)
      }])) as Record<string, ServerDraftValues>;
      setAccounts(nextAccounts);
      setTimingDrafts((current) => Object.fromEntries(nextAccounts.map((account) => {
        const draft = current[account.id];
        const previousServer = previousServerDrafts[account.id]?.timing;
        return [account.id, !draft || !previousServer || sameTiming(draft, previousServer) ? { ...account.timing } : draft];
      })));
      setSignMethodDrafts((current) => Object.fromEntries(nextAccounts.map((account) => {
        const serverMethod = account.signMethod ?? DEFAULT_SIGN_METHOD;
        const draft = current[account.id];
        const previousServer = previousServerDrafts[account.id]?.signMethod;
        return [account.id, !draft || !previousServer || draft === previousServer ? serverMethod : draft];
      })));
      setWhitelistDrafts((current) => Object.fromEntries(nextAccounts.map((account) => {
        const draft = current[account.id];
        const previousServer = previousServerDrafts[account.id]?.whitelist;
        return [account.id, draft === undefined || previousServer === undefined || draft === previousServer ? whitelistValue(account) : draft];
      })));
      setCourseNameDrafts((current) => Object.fromEntries(nextAccounts.map((account) => [account.id, current[account.id] ?? ""])));
      setCourseTimingDrafts((current) => Object.fromEntries(nextAccounts.map((account) => [account.id, current[account.id] ?? { ...account.timing }])));
      setCourseMethodNameDrafts((current) => Object.fromEntries(nextAccounts.map((account) => [account.id, current[account.id] ?? ""])));
      setCourseMethodDrafts((current) => Object.fromEntries(nextAccounts.map((account) => [account.id, current[account.id] ?? (account.signMethod ?? DEFAULT_SIGN_METHOD)])));
      serverDraftValues.current = nextServerDrafts;
      setWorker(data.worker);
      setEvents(data.events ?? []);
    } catch {
      setMessage("无法连接本地服务，请确认网页和后台进程都在运行");
    }
  }, [loadQq]);

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

  async function mutateQq(body: Record<string, unknown>, successMessage: string) {
    const accountId = typeof body.accountId === "string" ? body.accountId : "";
    setQqBusy((current) => ({ ...current, [accountId]: true }));
    setQqMessage("");
    try {
      const response = await fetch(appUrl("/api/qq"), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "QQ 设置操作失败");
      if (body.action === "code" && typeof data.code === "string" && typeof data.expiresAt === "string") {
        setBindingCodes((current) => ({ ...current, [accountId]: { code: data.code, expiresAt: data.expiresAt } }));
      } else {
        setQqMessage(successMessage);
      }
      await loadQq();
    } catch (error) {
      setQqMessage(error instanceof Error ? error.message : "QQ 设置操作失败");
    } finally {
      setQqBusy((current) => ({ ...current, [accountId]: false }));
    }
  }

  async function onUnbindQq(account: Account, binding?: QqBinding) {
    if (!window.confirm(`确定解除 ${account.username} 的${binding ? "这个" : "全部"} QQ 绑定吗？`)) return;
    setBindingCodes((current) => {
      const next = { ...current };
      delete next[account.id];
      return next;
    });
    await mutateQq({ action: "unbind", accountId: account.id, ...(binding ? { bindingId: binding.bindingId } : {}) }, "QQ 已解绑。");
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
    const error = timingError(timing);
    if (error) {
      setMessage(error);
      return;
    }
    await mutate({ action: "timing", accountId: account.id, timing }, `${account.username} 的签到时间已更新。`);
  }

  function updateCourseTiming(account: Account, patch: Partial<SignTiming>) {
    setCourseTimingDrafts((current) => ({
      ...current,
      [account.id]: { ...(current[account.id] ?? account.timing), ...patch }
    }));
  }

  async function onSaveCourseTiming(account: Account) {
    const courseName = (courseNameDrafts[account.id] ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ");
    if (!courseName) {
      setMessage("请填写完整课程名");
      return;
    }
    const timing = courseTimingDrafts[account.id] ?? account.timing;
    const error = timingError(timing);
    if (error) {
      setMessage(error);
      return;
    }
    const saved = await mutate({ action: "course-timing", accountId: account.id, courseName, timing }, `${courseName} 的单课签到时间已保存。`);
    if (saved) setCourseNameDrafts((current) => ({ ...current, [account.id]: "" }));
  }

  async function onRestoreCourseTiming(account: Account, courseName: string) {
    await mutate({ action: "course-timing", accountId: account.id, courseName, timing: null }, `${courseName} 已恢复默认签到时间。`);
  }

  async function onSaveSignMethod(account: Account, resetCourseSignMethodOverrides = false) {
    const signMethod = signMethodDrafts[account.id] ?? account.signMethod ?? DEFAULT_SIGN_METHOD;
    const label = signMethodLabel(signMethod);
    await mutate(
      {
        action: "sign-method",
        accountId: account.id,
        signMethod,
        ...(resetCourseSignMethodOverrides ? { resetCourseSignMethodOverrides: true } : {})
      },
      resetCourseSignMethodOverrides
        ? `${account.username} 的全部课程已统一为${label}（旧单课方式覆盖已清除）。`
        : `${account.username} 的默认签到方式已更新为${label}。`
    );
  }

  async function onSaveCourseSignMethod(account: Account) {
    const courseName = (courseMethodNameDrafts[account.id] ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ");
    if (!courseName) {
      setMessage("请填写完整课程名");
      return;
    }
    const signMethod = courseMethodDrafts[account.id] ?? account.signMethod ?? DEFAULT_SIGN_METHOD;
    const saved = await mutate(
      { action: "course-sign-method", accountId: account.id, courseName, signMethod },
      `${courseName} 的签到方式已设为${signMethodLabel(signMethod)}。`
    );
    if (saved) setCourseMethodNameDrafts((current) => ({ ...current, [account.id]: "" }));
  }

  async function onRestoreCourseSignMethod(account: Account, courseName: string) {
    await mutate(
      { action: "course-sign-method", accountId: account.id, courseName, signMethod: null },
      `${courseName} 已恢复默认签到方式。`
    );
  }

  async function onSaveWhitelist(account: Account) {
    const courseWhitelist = (whitelistDrafts[account.id] ?? "").split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
    await mutate({ action: "whitelist", accountId: account.id, courseWhitelist }, `${account.username} 的课程白名单已保存，后台会重新获取课表。`);
  }

  const online = Boolean(worker && clockNow - new Date(worker.updatedAt).getTime() < 15_000);
  const qqOnline = Boolean(qq?.configured && qqRuntimeOnline(qq.runtime));
  const qqStatusText = qq ? !qq.configured ? "待配置" : qqOnline ? "在线" : "未运行" : qqError ? "状态不可用" : "读取中";
  const qqRuntimeError = qqRuntimeErrorText(qq?.runtime ?? null);

  function isAccountExpanded(accountId: string) {
    if (accountId in expandedAccounts) return expandedAccounts[accountId];
    return accounts.length === 1;
  }

  function toggleAccountExpanded(accountId: string) {
    setExpandedAccounts((current) => ({ ...current, [accountId]: !isAccountExpanded(accountId) }));
  }

  return (
    <section id="main-content" className="space-y-6">
      {access === "ready" ? (
        <div className="grid gap-3.5 sm:grid-cols-3">
          <div className="panel rounded-2xl px-5 py-4">
            <p className="text-xs font-medium text-[color:var(--muted)]">已管理账号</p>
            <div className="mt-1.5 flex items-baseline gap-2 numeric-tabular">
              <span className="text-2xl font-bold tracking-tight text-[color:var(--ink)]">{accounts.length}</span>
              <span className="text-xs text-[color:var(--muted)]">/ 20 · {enabledAccounts.length} 个启用中</span>
            </div>
          </div>
          <div className="panel rounded-2xl px-5 py-4">
            <p className="text-xs font-medium text-[color:var(--muted)]">自动签到后台</p>
            <div className="mt-2 flex items-center gap-2">
              <span className={`live-dot ${online ? "live-dot--online" : "live-dot--offline"}`} />
              <span className="text-sm font-semibold text-[color:var(--ink)]">{online ? "运行中" : "未运行或状态过期"}</span>
            </div>
            <p className="mt-1 numeric-tabular text-[11px] text-[color:var(--muted)]">
              最近心跳：{worker?.updatedAt ? formatTime(new Date(worker.updatedAt).getTime()) : "--"}
            </p>
          </div>
          <div className="panel rounded-2xl px-5 py-4" title={typeof qq?.runtime?.lastError === "string" ? qq.runtime.lastError : undefined}>
            <p className="text-xs font-medium text-[color:var(--muted)]">QQ 机器人</p>
            <div className="mt-2 flex items-center gap-2">
              <span className={`live-dot ${qqOnline ? "live-dot--online" : qq?.configured ? "live-dot--warn" : "live-dot--offline"}`} />
              <span className="text-sm font-semibold text-[color:var(--ink)]">{qqStatusText}</span>
              {qq?.runtime?.connected === true && typeof qq.runtime.updatedAt === "string" && !qqOnline ? (
                <span className="text-[11px] text-amber-700">心跳已过期</span>
              ) : null}
            </div>
            <p className="mt-1 numeric-tabular text-[11px] text-[color:var(--muted)]">
              已发 {qq ? qq.sent : "--"} · 待发 {qq ? qq.pending : "--"} · 失败 {qq ? qq.failed : "--"}
            </p>
          </div>
        </div>
      ) : null}

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(340px,430px)_minmax(0,1fr)]">
        <div className="space-y-5">
          <div className="panel rounded-3xl p-6">
            <h2 className="text-xl font-bold tracking-tight text-[color:var(--ink)]">自动签到账号</h2>
            <p className="mt-1.5 text-xs leading-5 text-[color:var(--muted)]">
              每个账号独立查课、按规则自动签到；密码采用 AES-256-GCM 加密保存，接口和日志不返回密码。
            </p>
            {qqRuntimeError ? (
              <p role="status" className="status-banner status-banner--info mt-3 rounded-xl px-3 py-2 text-xs leading-5">
                QQ 通知状态：{qqRuntimeError}
              </p>
            ) : null}
            {access === "loading" ? <p className="mt-5 text-sm text-[color:var(--muted)]">正在读取设置…</p> : null}
            {access === "unavailable" ? (
              <p className="status-banner status-banner--error mt-5 rounded-xl px-3.5 py-3 text-sm">{message}。请检查服务器配置。</p>
            ) : null}
            {access === "ready" ? (
              <form onSubmit={onAdd} className="mt-5 space-y-3.5">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block text-xs font-semibold text-[color:var(--ink-soft)]">学号
                    <input
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                      placeholder="输入学号"
                      autoComplete="username"
                      spellCheck={false}
                      required
                      className="focus-ring input-surface mt-1.5 w-full rounded-xl border px-3.5 py-2.5 text-sm"
                    />
                  </label>
                  <label className="block text-xs font-semibold text-[color:var(--ink-soft)]">密码
                    <input
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder="输入密码"
                      autoComplete="new-password"
                      required
                      className="focus-ring input-surface mt-1.5 w-full rounded-xl border px-3.5 py-2.5 text-sm"
                    />
                  </label>
                </div>
                <button
                  disabled={saving || accounts.length >= 20}
                  className="action-btn action-btn--primary min-h-10 w-full rounded-xl px-4 py-2 text-sm font-semibold"
                >
                  添加并启用（{accounts.length}/20）
                </button>
              </form>
            ) : null}
            {message && access !== "unavailable" ? (
              <p role="status" className="status-banner status-banner--info mt-4 rounded-xl px-3.5 py-2.5 text-xs leading-5">
                {message}
              </p>
            ) : null}
          </div>

          {access === "ready" ? accounts.map((account) => {
            const bindings = qq?.bindings?.filter((item) => item.accountId === account.id && item.bound) ?? [];
            const code = bindingCodes[account.id];
            const busy = Boolean(qqBusy[account.id]);
            const expanded = isAccountExpanded(account.id);
            const timingOverrideCount = Object.keys(account.courseTimingOverrides ?? {}).length;
            const methodOverrideCount = Object.keys(account.courseSignMethodOverrides ?? {}).length;

            return (
              <div key={account.id} className="panel rounded-3xl p-5 sm:p-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="numeric-tabular text-lg font-bold tracking-tight text-[color:var(--ink)]">{account.username}</h3>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <span className={`pill-tag ${account.enabled ? "pill-tag--emerald" : ""}`}>
                        {account.enabled ? "自动签到中" : "已暂停"}
                      </span>
                      <span className="pill-tag pill-tag--blue">{signMethodLabel(account.signMethod)}</span>
                      <span className="pill-tag">{timingLabel(account.timing)}</span>
                      {bindings.length > 0 ? <span className="pill-tag">QQ ×{bindings.length}</span> : null}
                      {account.courseWhitelist.length > 0 ? <span className="pill-tag">停用 {account.courseWhitelist.length} 门</span> : null}
                    </div>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void mutate({ action: "toggle", accountId: account.id, enabled: !account.enabled }, account.enabled ? "已暂停该账号。" : "已启用该账号。")}
                    className={`action-btn min-h-9 rounded-xl px-3.5 py-1.5 text-xs font-semibold ${account.enabled ? "action-btn--secondary" : "action-btn--primary"}`}
                  >
                    {account.enabled ? "暂停" : "启用"}
                  </button>
                  <button
                    type="button"
                    disabled={saving || !account.enabled}
                    onClick={() => void mutate({ action: "refresh", accountId: account.id }, "已请求重新获取课表。")}
                    className="action-btn action-btn--secondary min-h-9 rounded-xl px-3.5 py-1.5 text-xs font-semibold"
                  >
                    刷新课表
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleAccountExpanded(account.id)}
                    className="action-btn action-btn--quiet min-h-9 rounded-xl px-3.5 py-1.5 text-xs font-semibold"
                  >
                    {expanded ? "收起设置" : "展开设置"}
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void onRemove(account)}
                    className="action-btn action-btn--danger ml-auto min-h-9 rounded-xl px-3 py-1.5 text-xs font-semibold"
                  >
                    移除
                  </button>
                </div>

                {expanded ? (
                  <div className="mt-5 space-y-4 border-t border-[color:var(--line)] pt-5">
                    <div className="sub-card p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h4 className="text-sm font-semibold text-[color:var(--ink)]">QQ 通知与绑定</h4>
                        <span className="pill-tag">{bindings.length ? `已绑定 ${bindings.length} 个 QQ` : "未绑定"}</span>
                      </div>
                      <p className="mt-1.5 text-xs leading-5 text-[color:var(--muted)]">
                        私聊机器人发送“绑定学号 学号 密码”自助绑定；同号可绑多个 QQ，通知与解绑各自独立。
                      </p>
                      {bindings.map((binding) => (
                        <div key={binding.bindingId} className="mt-3 rounded-xl border border-[color:var(--line)] bg-white p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-xs font-semibold text-[color:var(--ink)]">{binding.userHint || "已绑定 QQ"}</span>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void onUnbindQq(account, binding)}
                              className="action-btn action-btn--danger min-h-8 rounded-lg px-2.5 py-1 text-[11px] font-semibold"
                            >
                              解绑此 QQ
                            </button>
                          </div>
                          <select
                            aria-label={`${binding.userHint || "已绑定 QQ"}通知模式`}
                            value={binding.mode}
                            disabled={busy}
                            onChange={(event) => void mutateQq({ action: "preference", accountId: account.id, bindingId: binding.bindingId, mode: event.target.value }, "此 QQ 的通知模式已更新。")}
                            className="focus-ring input-surface mt-2 w-full rounded-xl border px-3 py-2 text-xs font-medium"
                          >
                            <option value="all">全部事件</option>
                            <option value="failure">仅失败</option>
                            <option value="off">关闭通知</option>
                          </select>
                        </div>
                      ))}
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={busy || !qq?.configured}
                          onClick={() => void mutateQq({ action: "code", accountId: account.id }, "绑定码已生成。")}
                          className="action-btn action-btn--secondary min-h-9 rounded-xl px-3.5 py-1.5 text-xs font-semibold"
                        >
                          生成绑定码
                        </button>
                        {bindings.length > 0 ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void onUnbindQq(account)}
                            className="action-btn action-btn--quiet min-h-9 rounded-xl px-3.5 py-1.5 text-xs font-semibold"
                          >
                            解绑全部 QQ
                          </button>
                        ) : null}
                      </div>
                      {code ? (
                        <p role="status" className="status-banner status-banner--info mt-3 rounded-xl px-3 py-2 font-mono text-xs">
                          绑定 {code.code} · 有效期至 {formatTime(new Date(code.expiresAt).getTime())}
                        </p>
                      ) : null}
                      {qqError ? <p className="mt-2 text-xs text-[color:var(--muted)]">{qqError}</p> : null}
                      {qqMessage ? <p role="status" className="mt-2 text-xs font-medium text-[color:var(--accent)]">{qqMessage}</p> : null}
                    </div>

                    <div className="sub-card p-4">
                      <h4 className="text-sm font-semibold text-[color:var(--ink)]">默认签到时间</h4>
                      <p className="mt-1 text-xs leading-5 text-[color:var(--muted)]">
                        开课前 1～30 分钟；随机结果对同一账号和课程保持稳定。
                      </p>
                      <label className="mt-3 block text-xs font-semibold text-[color:var(--ink-soft)]">方式
                        <select
                          value={(timingDrafts[account.id] ?? account.timing).mode}
                          onChange={(event) => updateTiming(account, { mode: event.target.value as SignTiming["mode"] })}
                          className="focus-ring input-surface mt-1.5 w-full rounded-xl border px-3 py-2 text-xs font-medium"
                        >
                          <option value="fixed">固定提前</option>
                          <option value="random">随机区间</option>
                        </select>
                      </label>
                      {(timingDrafts[account.id] ?? account.timing).mode === "fixed" ? (
                        <label className="mt-3 block text-xs font-semibold text-[color:var(--ink-soft)]">提前分钟数（1～30）
                          <input
                            type="number"
                            min="1"
                            max="30"
                            step="1"
                            value={(timingDrafts[account.id] ?? account.timing).fixedMinutes}
                            onChange={(event) => updateTiming(account, { fixedMinutes: Number(event.target.value) })}
                            className="focus-ring input-surface mt-1.5 w-full rounded-xl border px-3 py-2 text-xs"
                          />
                        </label>
                      ) : (
                        <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
                          <label className="block text-xs font-semibold text-[color:var(--ink-soft)]">最少提前（分）
                            <input
                              type="number"
                              min="1"
                              max="30"
                              step="1"
                              value={(timingDrafts[account.id] ?? account.timing).minMinutes}
                              onChange={(event) => updateTiming(account, { minMinutes: Number(event.target.value) })}
                              className="focus-ring input-surface mt-1.5 w-full rounded-xl border px-3 py-2 text-xs"
                            />
                          </label>
                          <label className="block text-xs font-semibold text-[color:var(--ink-soft)]">最多提前（分）
                            <input
                              type="number"
                              min="1"
                              max="30"
                              step="1"
                              value={(timingDrafts[account.id] ?? account.timing).maxMinutes}
                              onChange={(event) => updateTiming(account, { maxMinutes: Number(event.target.value) })}
                              className="focus-ring input-surface mt-1.5 w-full rounded-xl border px-3 py-2 text-xs"
                            />
                          </label>
                        </div>
                      )}
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => void onSaveTiming(account)}
                        className="action-btn action-btn--secondary mt-3 min-h-9 rounded-xl px-3.5 py-1.5 text-xs font-semibold"
                      >
                        保存签到时间
                      </button>
                    </div>

                    <div className="sub-card p-4">
                      <div className="flex items-center justify-between gap-2">
                        <h4 className="text-sm font-semibold text-[color:var(--ink)]">单课程签到时间</h4>
                        {timingOverrideCount > 0 ? <span className="pill-tag">{timingOverrideCount} 门覆盖</span> : null}
                      </div>
                      <label className="mt-3 block text-xs font-semibold text-[color:var(--ink-soft)]">完整课程名
                        <input
                          value={courseNameDrafts[account.id] ?? ""}
                          onChange={(event) => setCourseNameDrafts((current) => ({ ...current, [account.id]: event.target.value }))}
                          maxLength={120}
                          placeholder="例如：高等数学"
                          spellCheck={false}
                          className="focus-ring input-surface mt-1.5 w-full rounded-xl border px-3 py-2 text-xs"
                        />
                      </label>
                      <label className="mt-2.5 block text-xs font-semibold text-[color:var(--ink-soft)]">方式
                        <select
                          value={(courseTimingDrafts[account.id] ?? account.timing).mode}
                          onChange={(event) => updateCourseTiming(account, { mode: event.target.value as SignTiming["mode"] })}
                          className="focus-ring input-surface mt-1.5 w-full rounded-xl border px-3 py-2 text-xs font-medium"
                        >
                          <option value="fixed">固定提前</option>
                          <option value="random">随机区间</option>
                        </select>
                      </label>
                      {(courseTimingDrafts[account.id] ?? account.timing).mode === "fixed" ? (
                        <label className="mt-2.5 block text-xs font-semibold text-[color:var(--ink-soft)]">提前分钟数（1～30）
                          <input
                            type="number"
                            min="1"
                            max="30"
                            step="1"
                            value={(courseTimingDrafts[account.id] ?? account.timing).fixedMinutes}
                            onChange={(event) => updateCourseTiming(account, { fixedMinutes: Number(event.target.value) })}
                            className="focus-ring input-surface mt-1.5 w-full rounded-xl border px-3 py-2 text-xs"
                          />
                        </label>
                      ) : (
                        <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2">
                          <label className="block text-xs font-semibold text-[color:var(--ink-soft)]">最少提前（分）
                            <input
                              type="number"
                              min="1"
                              max="30"
                              step="1"
                              value={(courseTimingDrafts[account.id] ?? account.timing).minMinutes}
                              onChange={(event) => updateCourseTiming(account, { minMinutes: Number(event.target.value) })}
                              className="focus-ring input-surface mt-1.5 w-full rounded-xl border px-3 py-2 text-xs"
                            />
                          </label>
                          <label className="block text-xs font-semibold text-[color:var(--ink-soft)]">最多提前（分）
                            <input
                              type="number"
                              min="1"
                              max="30"
                              step="1"
                              value={(courseTimingDrafts[account.id] ?? account.timing).maxMinutes}
                              onChange={(event) => updateCourseTiming(account, { maxMinutes: Number(event.target.value) })}
                              className="focus-ring input-surface mt-1.5 w-full rounded-xl border px-3 py-2 text-xs"
                            />
                          </label>
                        </div>
                      )}
                      <button
                        type="button"
                        disabled={saving || !(courseNameDrafts[account.id] ?? "").trim()}
                        onClick={() => void onSaveCourseTiming(account)}
                        className="action-btn action-btn--secondary mt-3 min-h-9 rounded-xl px-3.5 py-1.5 text-xs font-semibold"
                      >
                        保存单课时间
                      </button>
                      {timingOverrideCount > 0 ? (
                        <ul className="mt-3.5 space-y-2" aria-label="单课程签到时间覆盖">
                          {Object.entries(account.courseTimingOverrides ?? {}).sort(([left], [right]) => left.localeCompare(right, "zh-CN")).map(([courseName, timing]) => (
                            <li key={courseName} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[color:var(--line)] bg-white px-3 py-2.5">
                              <div>
                                <p className="text-xs font-semibold text-[color:var(--ink)]">{courseName}</p>
                                <p className="mt-0.5 text-[11px] text-[color:var(--muted)]">{timingLabel(timing)}</p>
                              </div>
                              <div className="flex gap-1.5">
                                <button
                                  type="button"
                                  disabled={saving}
                                  onClick={() => {
                                    setCourseNameDrafts((current) => ({ ...current, [account.id]: courseName }));
                                    setCourseTimingDrafts((current) => ({ ...current, [account.id]: { ...timing } }));
                                  }}
                                  className="action-btn action-btn--quiet min-h-8 rounded-lg px-2.5 py-1 text-[11px] font-semibold"
                                >
                                  编辑
                                </button>
                                <button
                                  type="button"
                                  disabled={saving}
                                  onClick={() => void onRestoreCourseTiming(account, courseName)}
                                  className="action-btn action-btn--quiet min-h-8 rounded-lg px-2.5 py-1 text-[11px] font-semibold"
                                >
                                  恢复默认
                                </button>
                              </div>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>

                    <div className="sub-card p-4">
                      <h4 className="text-sm font-semibold text-[color:var(--ink)]">默认签到方式</h4>
                      <p className="mt-1 text-xs leading-5 text-[color:var(--muted)]">
                        打卡机扫码使用 32 位 UUID，课堂扫码使用 7 位课程号；缺号时自动回退。
                      </p>
                      <select
                        aria-label="默认签到路径"
                        value={signMethodDrafts[account.id] ?? account.signMethod ?? DEFAULT_SIGN_METHOD}
                        onChange={(event) => setSignMethodDrafts((current) => ({ ...current, [account.id]: event.target.value as SignMethod }))}
                        className="focus-ring input-surface mt-3 w-full rounded-xl border px-3 py-2 text-xs font-medium"
                      >
                        <option value="timeTableId">打卡机扫码（32位 UUID）</option>
                        <option value="courseSchedId">课堂扫码（7位课程号）</option>
                      </select>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => void onSaveSignMethod(account, false)}
                          className="action-btn action-btn--secondary min-h-9 rounded-xl px-3.5 py-1.5 text-xs font-semibold"
                        >
                          保存默认方式
                        </button>
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => void onSaveSignMethod(account, true)}
                          className="action-btn action-btn--quiet min-h-9 rounded-xl px-3.5 py-1.5 text-xs font-semibold"
                        >
                          应用到全部课程
                        </button>
                      </div>
                    </div>

                    <div className="sub-card p-4">
                      <div className="flex items-center justify-between gap-2">
                        <h4 className="text-sm font-semibold text-[color:var(--ink)]">单课程签到方式</h4>
                        {methodOverrideCount > 0 ? <span className="pill-tag">{methodOverrideCount} 门覆盖</span> : null}
                      </div>
                      <label className="mt-3 block text-xs font-semibold text-[color:var(--ink-soft)]">完整课程名
                        <input
                          value={courseMethodNameDrafts[account.id] ?? ""}
                          onChange={(event) => setCourseMethodNameDrafts((current) => ({ ...current, [account.id]: event.target.value }))}
                          maxLength={120}
                          placeholder="例如：高等数学"
                          spellCheck={false}
                          className="focus-ring input-surface mt-1.5 w-full rounded-xl border px-3 py-2 text-xs"
                        />
                      </label>
                      <label className="mt-2.5 block text-xs font-semibold text-[color:var(--ink-soft)]">签到路径
                        <select
                          value={courseMethodDrafts[account.id] ?? account.signMethod ?? DEFAULT_SIGN_METHOD}
                          onChange={(event) => setCourseMethodDrafts((current) => ({ ...current, [account.id]: event.target.value as SignMethod }))}
                          className="focus-ring input-surface mt-1.5 w-full rounded-xl border px-3 py-2 text-xs font-medium"
                        >
                          <option value="timeTableId">打卡机扫码（32位 UUID）</option>
                          <option value="courseSchedId">课堂扫码（7位课程号）</option>
                        </select>
                      </label>
                      <button
                        type="button"
                        disabled={saving || !(courseMethodNameDrafts[account.id] ?? "").trim()}
                        onClick={() => void onSaveCourseSignMethod(account)}
                        className="action-btn action-btn--secondary mt-3 min-h-9 rounded-xl px-3.5 py-1.5 text-xs font-semibold"
                      >
                        保存单课方式
                      </button>
                      {methodOverrideCount > 0 ? (
                        <ul className="mt-3.5 space-y-2" aria-label="单课程签到方式覆盖">
                          {Object.entries(account.courseSignMethodOverrides ?? {}).sort(([left], [right]) => left.localeCompare(right, "zh-CN")).map(([courseName, method]) => (
                            <li key={courseName} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[color:var(--line)] bg-white px-3 py-2.5">
                              <div>
                                <p className="text-xs font-semibold text-[color:var(--ink)]">{courseName}</p>
                                <p className="mt-0.5 text-[11px] text-[color:var(--muted)]">{signMethodLabel(method)}</p>
                              </div>
                              <div className="flex gap-1.5">
                                <button
                                  type="button"
                                  disabled={saving}
                                  onClick={() => {
                                    setCourseMethodNameDrafts((current) => ({ ...current, [account.id]: courseName }));
                                    setCourseMethodDrafts((current) => ({ ...current, [account.id]: method }));
                                  }}
                                  className="action-btn action-btn--quiet min-h-8 rounded-lg px-2.5 py-1 text-[11px] font-semibold"
                                >
                                  编辑
                                </button>
                                <button
                                  type="button"
                                  disabled={saving}
                                  onClick={() => void onRestoreCourseSignMethod(account, courseName)}
                                  className="action-btn action-btn--quiet min-h-8 rounded-lg px-2.5 py-1 text-[11px] font-semibold"
                                >
                                  恢复默认
                                </button>
                              </div>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>

                    <div className="sub-card p-4">
                      <h4 className="text-sm font-semibold text-[color:var(--ink)]">不打卡课程名单</h4>
                      <p className="mt-1 text-xs leading-5 text-[color:var(--muted)]">
                        每行一个完整课程名；名单内课程将跳过自动签到，留空表示全部正常打卡。
                      </p>
                      <textarea
                        value={whitelistDrafts[account.id] ?? ""}
                        onChange={(event) => setWhitelistDrafts((current) => ({ ...current, [account.id]: event.target.value }))}
                        rows={3}
                        placeholder={"例如：信息检索导论\n高等数学"}
                        className="focus-ring input-surface mt-2.5 w-full rounded-xl border px-3 py-2 text-xs"
                      />
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => void onSaveWhitelist(account)}
                        className="action-btn action-btn--secondary mt-2.5 min-h-9 rounded-xl px-3.5 py-1.5 text-xs font-semibold"
                      >
                        保存不打卡名单
                      </button>
                    </div>

                    <div className="sub-card p-4">
                      <h4 className="text-sm font-semibold text-[color:var(--ink)]">更新密码</h4>
                      <div className="mt-2.5 flex flex-col gap-2 sm:flex-row">
                        <input
                          type="password"
                          aria-label="新密码"
                          placeholder="输入新密码"
                          value={newPasswords[account.id] ?? ""}
                          onChange={(event) => setNewPasswords((current) => ({ ...current, [account.id]: event.target.value }))}
                          autoComplete="new-password"
                          className="focus-ring input-surface w-full rounded-xl border px-3 py-2 text-xs"
                        />
                        <button
                          type="button"
                          disabled={saving || !newPasswords[account.id]}
                          onClick={() => void onUpdatePassword(account)}
                          className="action-btn action-btn--secondary min-h-9 shrink-0 rounded-xl px-3.5 py-1.5 text-xs font-semibold"
                        >
                          保存新密码
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          }) : null}
        </div>

        <div className="space-y-6">
          <div className="panel rounded-3xl p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-xl font-bold tracking-tight text-[color:var(--ink)]">今日签到计划</h2>
                <p className="mt-0.5 text-xs text-[color:var(--muted)]">
                  每 5 秒自动刷新进度，全部完成后自动降频轮询
                </p>
              </div>
              {access === "ready" ? (
                <span className={`pill-tag ${online ? "pill-tag--emerald" : ""}`}>
                  <span className={`live-dot ${online ? "live-dot--online" : "live-dot--offline"}`} />
                  {online ? "后台运行中" : "未运行或过期"}
                </span>
              ) : null}
            </div>

            {access !== "ready" ? <p className="mt-5 text-sm text-[color:var(--muted)]">解锁后查看各账号的课程和结果。</p> : null}
            {access === "ready" && worker?.lastError ? (
              <p className="status-banner status-banner--error mt-4 rounded-xl px-3.5 py-2.5 text-xs">{worker.lastError}</p>
            ) : null}
            {access === "ready" && accounts.length === 0 ? (
              <div className="sub-card mt-5 py-10 text-center text-sm text-[color:var(--muted)]">
                尚未添加账号，请先在左侧添加学号。
              </div>
            ) : null}

            {access === "ready" ? accounts.map((account) => {
              const status = worker?.accounts?.find((item) => item.id === account.id);
              return (
                <section key={account.id} className="mt-5 border-t border-[color:var(--line)] pt-5 first-of-type:mt-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                      <h3 className="numeric-tabular text-base font-bold text-[color:var(--ink)]">{account.username}</h3>
                      <span className={`pill-tag ${account.enabled ? "pill-tag--emerald" : ""}`}>
                        {account.enabled ? "已启用" : "已暂停"}
                      </span>
                    </div>
                    {account.enabled ? (
                      <p className="numeric-tabular text-[11px] text-[color:var(--muted)]">
                        上次：{formatTime(status?.lastScheduleAt)} · 下次：{formatTime(status?.nextScheduleAt)}
                      </p>
                    ) : null}
                  </div>

                  {status?.lastError ? (
                    <p className="status-banner status-banner--error mt-3 rounded-xl px-3.5 py-2 text-xs">{status.lastError}</p>
                  ) : null}
                  {account.enabled && status?.scheduleState === "no_courses" ? (
                    <p className="status-banner status-banner--success mt-3 rounded-xl px-3.5 py-2.5 text-xs">
                      今日无课，今天不再查询课表；下次将在明日 06:00 查询。
                    </p>
                  ) : null}
                  {account.enabled && status?.scheduleState === "no_matching_courses" ? (
                    <p className="status-banner status-banner--success mt-3 rounded-xl px-3.5 py-2.5 text-xs">
                      今日课程都在不打卡名单中，今天不执行签到；下次将在明日 06:00 查询。
                    </p>
                  ) : null}
                  {account.enabled && status?.scheduleState !== "no_courses" && status?.scheduleState !== "no_matching_courses" && !status?.plan?.length ? (
                    <p className="mt-3 text-xs text-[color:var(--muted)]">
                      尚无课程计划。未查询时会在 06:00 获取；查询失败时每 5 分钟重试。
                    </p>
                  ) : null}

                  {account.enabled && status?.plan?.length ? (
                    <div className="mt-3 space-y-3">
                      {status.plan.map((item) => (
                        <article key={item.key} className="clay-card rounded-2xl p-4">
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <h4 className="text-sm font-semibold text-[color:var(--ink)]">{item.courseName || "未命名课程"}</h4>
                            <span className={`pill-tag ${planStateTone(item.state)}`}>{item.state}</span>
                          </div>
                          <div className="mt-2.5 flex flex-wrap items-center gap-2 text-xs text-[color:var(--muted)] numeric-tabular">
                            {item.teacherName ? <span className="font-medium text-[color:var(--ink-soft)]">{item.teacherName}</span> : null}
                            <span>上课 {formatTime(item.start)}</span>
                            <span>·</span>
                            <span>计划 {formatTime(item.attemptAt)}</span>
                          </div>
                          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                            <span className="pill-tag pill-tag--blue">
                              {signMethodLabel(item.signMethod)}
                              {item.effectiveSignMethod && item.signMethod && item.effectiveSignMethod !== item.signMethod
                                ? ` → 回退${signMethodLabel(item.effectiveSignMethod)}`
                                : ""}
                            </span>
                            <span className="pill-tag numeric-tabular">入口 {item.courseIds?.join(" / ") || item.courseId}</span>
                            <span className="pill-tag numeric-tabular">尝试 {item.attempts} 次</span>
                          </div>
                          {item.targetCount > 1 ? (
                            <p className="mt-2 text-[11px] leading-5 text-[color:var(--muted)]">
                              同一时间段有 {item.targetCount} 个候选入口，后台将依次轮换尝试，任一成功即停止。
                            </p>
                          ) : null}
                          {item.message ? (
                            <p className="mt-2.5 rounded-xl bg-[color:var(--surface-subtle)] px-3 py-2 text-xs leading-5 text-[color:var(--ink-soft)]">
                              {item.message}
                            </p>
                          ) : null}
                        </article>
                      ))}
                    </div>
                  ) : null}
                </section>
              );
            }) : null}
          </div>

          <div className="panel rounded-3xl p-6">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-xl font-bold tracking-tight text-[color:var(--ink)]">运行日志</h2>
              {access === "ready" ? (
                <span className="text-xs text-[color:var(--muted)]">最近 {events.length} / 100 条</span>
              ) : null}
            </div>
            {access !== "ready" ? (
              <p className="mt-4 text-sm text-[color:var(--muted)]">解锁后查看记录。</p>
            ) : events.length === 0 ? (
              <p className="mt-4 text-sm text-[color:var(--muted)]">暂无记录；后台重启后会开始记录。</p>
            ) : (
              <ol className="subtle-scroll mt-4 max-h-96 divide-y divide-[color:var(--line)] overflow-y-auto pr-1" aria-label="最近运行日志">
                {[...events].reverse().map((event, index) => (
                  <li key={`${event.at}-${index}`} className="flex flex-col gap-0.5 py-2.5 text-xs leading-5 sm:flex-row sm:gap-3">
                    <time className="numeric-tabular shrink-0 font-mono text-[11px] text-[color:var(--muted)]" dateTime={event.at}>
                      {formatTime(new Date(event.at).getTime())}
                    </time>
                    <span className="text-[color:var(--ink-soft)] break-words">{event.message}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
