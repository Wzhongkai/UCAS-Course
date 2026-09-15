import { NextRequest, NextResponse } from "next/server";
import { accessReady, authorized } from "./automation/auth.mjs";

function logicalPath(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const basePath = request.nextUrl.basePath || "";
  return basePath && pathname.startsWith(basePath) ? pathname.slice(basePath.length) || "/" : pathname;
}

export function proxy(request: NextRequest) {
  const pathname = logicalPath(request);
  if (pathname === "/access" || pathname === "/api/access" || pathname.startsWith("/_next/") || pathname === "/ucas.svg") {
    return NextResponse.next();
  }
  if (accessReady() && authorized(request)) return NextResponse.next();
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ message: accessReady() ? "请先通过访问验证" : "服务器尚未配置访问密钥" }, { status: accessReady() ? 401 : 503 });
  }
  const url = request.nextUrl.clone();
  url.pathname = "/access";
  url.search = "";
  return NextResponse.redirect(url);
}
