import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

test("多账号配置加密保存，管理状态不泄露密码并兼容旧账号", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ucas-store-"));
  process.env.AUTO_SIGN_DATA_DIR = directory;
  process.env.AUTO_SIGN_SECRET = randomBytes(32).toString("hex");
  try {
    const store = await import(`../src/automation/store.mjs?test=${Date.now()}`);
    await store.updateAutomationSettings({ action: "add", username: "20260001", password: "test-secret" });
    const firstId = (await store.readPublicSettings()).accounts[0].id;
    await store.updateAutomationSettings({ action: "refresh", accountId: firstId });
    const raw = await readFile(join(directory, "automation.json"), "utf8");
    assert.equal(raw.includes("test-secret"), false);
    assert.equal(raw.includes("20260001"), false);
    const settings = await store.readAutomationSettings();
    assert.equal(settings.accounts[0].credentials.username, "20260001");
    assert.equal(settings.accounts[0].credentials.password, "test-secret");
    assert.ok(settings.accounts[0].refreshRequestedAt);
    const publicSettings = await store.readPublicSettings();
    assert.equal(publicSettings.accounts.length, 1);
    assert.equal(publicSettings.accounts[0].username, "20260001");
    assert.equal(JSON.stringify(publicSettings).includes("test-secret"), false);
    await assert.rejects(store.updateAutomationSettings({ action: "add", username: "20260001", password: "different" }), /已添加/);
    await store.updateAutomationSettings({ action: "add", username: "20260002", password: "another-secret" });
    assert.equal((await store.readPublicSettings()).accounts.length, 2);
    await store.updateAutomationSettings({ action: "toggle", accountId: firstId, enabled: false });
    assert.equal((await store.readPublicSettings()).accounts.find((account) => account.id === firstId).enabled, false);
    await store.updateAutomationSettings({ action: "password", accountId: firstId, password: "new-secret" });
    assert.equal((await store.readAutomationSettings()).accounts.find((account) => account.id === firstId).credentials.password, "new-secret");
    const events = Array.from({ length: 105 }, (_, index) => ({ at: new Date(index * 1000).toISOString(), message: `记录 ${index}` }));
    await store.writeWorkerEvents(events);
    const recentEvents = await store.readWorkerEvents();
    assert.equal(recentEvents.length, 100);
    assert.equal(recentEvents[0].message, "记录 5");
    assert.equal(recentEvents.at(-1).message, "记录 104");
    await store.updateAutomationSettings({ action: "remove", accountId: firstId });
    const cleared = await store.readPublicSettings();
    assert.equal(cleared.accounts.length, 1);
    const second = JSON.parse(await readFile(join(directory, "automation.json"), "utf8")).accounts[0];
    await writeFile(join(directory, "automation.json"), JSON.stringify({
      version: 1, enabled: true, credentials: second.credentials,
      updatedAt: new Date().toISOString(), refreshRequestedAt: null
    }));
    const legacy = await store.readAutomationSettings();
    assert.equal(legacy.accounts[0].id, "legacy");
    assert.equal(legacy.accounts[0].credentials.username, "20260002");
    await store.updateAutomationSettings({ action: "add", username: "20260003", password: "third-secret" });
    assert.equal((await store.readPublicSettings()).accounts.length, 2);
  } finally {
    if (basename(directory).startsWith("ucas-store-") && resolve(directory).startsWith(resolve(tmpdir()))) {
      await rm(directory, { recursive: true, force: true });
    }
    delete process.env.AUTO_SIGN_DATA_DIR;
    delete process.env.AUTO_SIGN_SECRET;
  }
});
