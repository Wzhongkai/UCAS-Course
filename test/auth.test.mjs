import test from "node:test";
import assert from "node:assert/strict";

test("整站访问要求密钥与同源请求", async () => {
  process.env.UCAS_ACCESS_KEY = "b".repeat(32);
  try {
    const auth = await import(`../src/automation/auth.mjs?test=${Date.now()}`);
    assert.equal(auth.validAccessKey("b".repeat(32)), true);
    assert.equal(auth.validAccessKey("wrong"), false);
    const same = { headers: { get: (name) => ({ origin: "http://127.0.0.1:3000", host: "127.0.0.1:3000" })[name] ?? null } };
    const cross = { headers: { get: (name) => ({ origin: "https://evil.example", host: "127.0.0.1:3000" })[name] ?? null } };
    assert.equal(auth.sameOrigin(same), true);
    assert.equal(auth.sameOrigin(cross), false);
  } finally {
    delete process.env.UCAS_ACCESS_KEY;
  }
});
