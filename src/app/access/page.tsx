"use client";

import { FormEvent, useState } from "react";
import { appUrl } from "../../app-path";

export default function AccessPage() {
  const [key, setKey] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setMessage("");
    try {
      const response = await fetch(appUrl("/api/access"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "验证失败");
      window.location.assign(appUrl("/"));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "验证失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="grain flex min-h-screen items-center justify-center px-4 py-10">
      <section className="panel w-full max-w-md rounded-2xl p-6 sm:p-8">
        <p className="text-xs font-semibold tracking-[0.18em] text-[color:var(--green)] uppercase">UCAS Course</p>
        <h1 className="mt-3 font-[var(--font-serif)] text-3xl font-semibold">访问验证</h1>
        <p className="mt-3 text-sm leading-6 text-[color:var(--muted)]">输入访问密钥后即可使用课程查询、签到码和自动签到管理。</p>
        <form onSubmit={onSubmit} className="mt-6 space-y-4">
          <label className="block text-sm font-semibold">访问密钥
            <input type="password" value={key} onChange={(event) => setKey(event.target.value)} required autoFocus autoComplete="current-password"
              className="focus-ring input-surface mt-2 w-full rounded-xl border border-[color:var(--line)] px-4 py-3" />
          </label>
          <button disabled={loading} className="action-btn action-btn--primary min-h-11 w-full rounded-xl px-4 py-2.5 text-sm font-semibold disabled:opacity-60">
            {loading ? "验证中…" : "进入 UCAS Course"}
          </button>
        </form>
        {message ? <p role="alert" className="status-banner status-banner--error mt-4 rounded-xl px-3 py-2 text-sm">{message}</p> : null}
      </section>
    </main>
  );
}
