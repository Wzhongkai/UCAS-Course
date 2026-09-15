import { NextResponse } from "next/server";
import { accessReady, authorized, sameOrigin } from "../../../automation/auth.mjs";
import { encryptionReady, readPublicSettings, readWorkerStatus, readWorkerEvents, updateAutomationSettings } from "../../../automation/store.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unavailable() {
  if (!accessReady()) return "请先在服务器设置 UCAS_ACCESS_KEY（至少 16 个字符）";
  if (!encryptionReady()) return "请先在服务器设置 AUTO_SIGN_SECRET（64 位十六进制）";
  return null;
}

export async function GET(request) {
  const problem = unavailable();
  if (problem) return NextResponse.json({ message: problem }, { status: 503 });
  if (!authorized(request)) return NextResponse.json({ message: "请先通过访问验证" }, { status: 401 });
  try {
    const [settings, worker, events] = await Promise.all([readPublicSettings(), readWorkerStatus(), readWorkerEvents()]);
    return NextResponse.json({ settings, worker, events }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ message: "读取自动签到设置失败，请检查加密密钥是否与保存时一致" }, { status: 500 });
  }
}

export async function POST(request) {
  const problem = unavailable();
  if (problem) return NextResponse.json({ message: problem }, { status: 503 });
  if (!sameOrigin(request)) return NextResponse.json({ message: "非法来源请求" }, { status: 403 });
  if (!authorized(request)) return NextResponse.json({ message: "请先通过访问验证" }, { status: 401 });
  let body;
  try { body = await request.json(); } catch { return NextResponse.json({ message: "请求格式错误" }, { status: 400 }); }
  try {
    await updateAutomationSettings({
      action: body?.action,
      accountId: body?.accountId,
      enabled: body?.enabled,
      username: body?.username,
      password: body?.password,
      timing: body?.timing
    });
    return NextResponse.json({ success: true, settings: await readPublicSettings() });
  } catch (error) {
    return NextResponse.json({ message: error instanceof Error ? error.message : "保存失败" }, { status: 400 });
  }
}
