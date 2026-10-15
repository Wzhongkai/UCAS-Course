import { NextResponse } from "next/server";
import { accessReady, authorized, sameOrigin } from "../../../../automation/auth.mjs";
import { encryptionReady } from "../../../../automation/store.mjs";
import { BackendScheduleError, createBackendScheduleService } from "../../../../qq/backend-schedule-service.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESPONSE_HEADERS = { "Cache-Control": "no-store" };
const querySchedule = createBackendScheduleService();

function json(body, status = 200) {
  return NextResponse.json(body, { status, headers: RESPONSE_HEADERS });
}

export async function POST(request) {
  if (!accessReady()) return json({ message: "后台访问验证尚未配置" }, 503);
  if (!sameOrigin(request)) return json({ message: "非法来源请求" }, 403);
  if (!authorized(request)) return json({ message: "请先通过访问验证" }, 401);
  if (!encryptionReady()) return json({ message: "后台加密配置尚未就绪" }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ message: "请求格式错误" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ message: "请求格式错误" }, 400);

  try {
    return json(await querySchedule({ accountId: body.accountId, date: body.date }));
  } catch (error) {
    if (error instanceof BackendScheduleError) return json({ message: error.message }, error.status);
    return json({ message: "课程查询失败，请稍后重试" }, 502);
  }
}
