import { NextResponse } from "next/server";
import { accessReady, clearAccessCookie, sameOrigin, setAccessCookie, validAccessKey } from "../../../automation/auth.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  if (!accessReady()) return NextResponse.json({ message: "服务器尚未配置访问密钥" }, { status: 503 });
  if (!sameOrigin(request)) return NextResponse.json({ message: "非法来源请求" }, { status: 403 });
  let body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ message: "请求格式错误" }, { status: 400 }); }
  if (!validAccessKey(body?.key)) return NextResponse.json({ message: "访问密钥错误" }, { status: 401 });
  const response = NextResponse.json({ success: true });
  setAccessCookie(response, request);
  return response;
}

export async function DELETE(request) {
  if (!sameOrigin(request)) return NextResponse.json({ message: "非法来源请求" }, { status: 403 });
  const response = NextResponse.json({ success: true });
  clearAccessCookie(response);
  return response;
}
