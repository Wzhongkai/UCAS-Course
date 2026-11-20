"use client";

import Image from "next/image";
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
      <section className="panel w-full max-w-md rounded-3xl p-7 sm:p-9">
        <div className="flex items-center gap-3.5">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-[color:var(--line)] bg-white shadow-xs">
            <Image src={appUrl("/ucas.svg")} alt="UCAS" width={28} height={28} unoptimized />
          </div>
          <div>
            <p className="text-[11px] font-semibold tracking-[0.18em] text-[color:var(--accent)] uppercase">UCAS Course</p>
            <h1 className="text-2xl font-bold tracking-tight text-[color:var(--ink)]">访问验证</h1>
          </div>
        </div>
        <p className="mt-4 text-sm leading-6 text-[color:var(--muted)]">
          输入网站访问密钥以解锁课程查询、动态签到码与多账号自动签到管理。
        </p>
        <form onSubmit={onSubmit} className="mt-6 space-y-4">
          <label className="block text-sm font-semibold text-[color:var(--ink-soft)]">访问密钥
            <input
              type="password"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder="请输入访问密钥"
              required
              autoFocus
              autoComplete="current-password"
              className="focus-ring input-surface mt-2 w-full rounded-xl border px-4 py-3 text-sm"
            />
          </label>
          <button
            disabled={loading}
            className="action-btn action-btn--primary min-h-11 w-full rounded-xl px-4 py-2.5 text-sm font-semibold"
          >
            {loading ? "验证中…" : "进入 UCAS Course"}
          </button>
        </form>
        {message ? (
          <p role="alert" className="status-banner status-banner--error mt-4 rounded-xl px-3.5 py-2.5 text-sm">
            {message}
          </p>
        ) : null}
      </section>
    </main>
  );
}
