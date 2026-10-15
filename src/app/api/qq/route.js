import { NextResponse } from "next/server";
import { authorized, sameOrigin } from "../../../automation/auth.mjs";
import { readPublicSettings } from "../../../automation/store.mjs";
import { createQqStore } from "../../../qq/store.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function safeCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function safeRuntimeError(value) {
  if (typeof value !== "string") return "";
  const secrets = [
    process.env.QQ_BOT_APP_SECRET,
    process.env.QQ_BOT_BOOTSTRAP_TOKEN,
    process.env.AUTO_SIGN_SECRET,
    process.env.UCAS_ACCESS_KEY,
    process.env.AUTO_SIGN_ADMIN_TOKEN
  ].filter((secret) => typeof secret === "string" && secret.length > 0);
  return secrets.reduce((message, secret) => message.replaceAll(secret, "[已隐藏]"), value).slice(0, 300);
}

function publicRuntime(value) {
  if (!value || typeof value !== "object") return null;
  return {
    connected: value.connected === true,
    lastError: safeRuntimeError(value.lastError),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null
  };
}

export async function GET(request) {
  if (!authorized(request)) return NextResponse.json({ message: "请先通过访问验证" }, { status: 401, headers: NO_STORE });
  try {
    const store = createQqStore();
    const [summary, runtimeStatus] = await Promise.all([store.getSummary(), store.getRuntimeStatus()]);
    const bindings = Array.isArray(summary?.bindings) ? summary.bindings.map((binding) => ({
      accountId: typeof binding.accountId === "string" ? binding.accountId : "",
      bound: binding.bound === true,
      mode: ["all", "failure", "off"].includes(binding.mode) ? binding.mode : "all",
      userHint: typeof binding.userHint === "string" ? binding.userHint.slice(0, 80) : null
    })) : [];
    return NextResponse.json({
      bindings,
      pending: safeCount(summary?.pending),
      failed: safeCount(summary?.failed),
      sent: safeCount(summary?.sent),
      runtime: publicRuntime(runtimeStatus),
      configured: Boolean(process.env.QQ_BOT_APP_ID && process.env.QQ_BOT_APP_SECRET)
    }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ message: "读取 QQ 通知状态失败" }, { status: 500, headers: NO_STORE });
  }
}

export async function POST(request) {
  if (!sameOrigin(request)) return NextResponse.json({ message: "非法来源请求" }, { status: 403, headers: NO_STORE });
  if (!authorized(request)) return NextResponse.json({ message: "请先通过访问验证" }, { status: 401, headers: NO_STORE });

  let body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ message: "请求格式错误" }, { status: 400, headers: NO_STORE }); }

  const { action, accountId, mode } = body ?? {};
  if (typeof accountId !== "string" || !accountId) {
    return NextResponse.json({ message: "账号无效" }, { status: 400, headers: NO_STORE });
  }

  try {
    const settings = await readPublicSettings();
    if (!settings.accounts.some((account) => account.id === accountId)) {
      return NextResponse.json({ message: "账号不存在" }, { status: 404, headers: NO_STORE });
    }

    const store = createQqStore();
    if (action === "code") {
      const bindingCode = await store.createBindingCode(accountId);
      return NextResponse.json({ code: bindingCode.code, expiresAt: bindingCode.expiresAt }, { headers: NO_STORE });
    }
    if (action === "unbind") {
      await store.unbind(accountId);
      return NextResponse.json({ success: true }, { headers: NO_STORE });
    }
    if (action === "preference") {
      if (!["all", "failure", "off"].includes(mode)) {
        return NextResponse.json({ message: "通知模式无效" }, { status: 400, headers: NO_STORE });
      }
      await store.setPreference(accountId, mode);
      return NextResponse.json({ success: true }, { headers: NO_STORE });
    }
    return NextResponse.json({ message: "未知操作" }, { status: 400, headers: NO_STORE });
  } catch {
    return NextResponse.json({ message: "QQ 操作失败，请重试" }, { status: 500, headers: NO_STORE });
  }
}
