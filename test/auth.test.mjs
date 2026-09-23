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

test("本地桌面模式只在明确回环监听时跳过访问密钥", async () => {
  const previous = {
    mode: process.env.LOCAL_DESKTOP_MODE,
    appHost: process.env.APP_HOST,
    hostname: process.env.HOSTNAME,
    accessKey: process.env.UCAS_ACCESS_KEY
  };
  process.env.LOCAL_DESKTOP_MODE = "1";
  process.env.APP_HOST = "127.0.0.1";
  process.env.HOSTNAME = "127.0.0.1";
  delete process.env.UCAS_ACCESS_KEY;
  try {
    const auth = await import(`../src/automation/auth.mjs?desktop-test=${Date.now()}`);
    assert.equal(auth.localDesktopMode(), true);
    assert.equal(auth.accessReady(), true);
    assert.equal(auth.authorized({}), true);

    process.env.HOSTNAME = "0.0.0.0";
    assert.equal(auth.localDesktopMode(), false);
    assert.equal(auth.accessReady(), false);
    assert.equal(auth.authorized({}), false);

    process.env.HOSTNAME = "127.0.0.1";
    process.env.APP_HOST = "0.0.0.0";
    assert.equal(auth.localDesktopMode(), false);
    assert.equal(auth.accessReady(), false);
    assert.equal(auth.authorized({}), false);
  } finally {
    for (const [name, value] of Object.entries({
      LOCAL_DESKTOP_MODE: previous.mode,
      APP_HOST: previous.appHost,
      HOSTNAME: previous.hostname,
      UCAS_ACCESS_KEY: previous.accessKey
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
