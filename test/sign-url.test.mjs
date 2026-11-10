import test from "node:test";
import assert from "node:assert/strict";
import { buildSignInUrl, selectSignIdentifier } from "../src/sign-url.mjs";

test("二维码使用 UUID 优先的参数，且不包含登录信息", () => {
  const timestamp = 1789380000000;
  const uuid = "00112233445566778899AABBCCDDEEFF";
  const preferred = selectSignIdentifier(" 00112233-4455-6677-8899-aabbccddeeff ", "1234567");
  const url = new URL(buildSignInUrl(preferred, timestamp));
  assert.equal(url.pathname, "/app/course/stu_scan_sign.action");
  assert.deepEqual(Object.fromEntries(url.searchParams), { timeTableId: uuid, timestamp: String(timestamp) });
  const fallback = new URL(buildSignInUrl(selectSignIdentifier("", "0123456"), timestamp));
  assert.deepEqual(Object.fromEntries(fallback.searchParams), { courseSchedId: "0123456", timestamp: String(timestamp) });
  assert.equal(selectSignIdentifier("00112233445566778899AABBCCDDEEFG", "1234"), null);
});
