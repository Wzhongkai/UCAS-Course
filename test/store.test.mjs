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
    assert.deepEqual(settings.accounts[0].timing, {
      mode: "fixed", fixedMinutes: 10, minMinutes: 10, maxMinutes: 20
    });
    assert.deepEqual(settings.accounts[0].courseTimingOverrides, {});
    assert.ok(settings.accounts[0].refreshRequestedAt);
    const publicSettings = await store.readPublicSettings();
    assert.equal(publicSettings.accounts.length, 1);
    assert.equal(publicSettings.accounts[0].username, "20260001");
    assert.deepEqual(publicSettings.accounts[0].courseWhitelist, []);
    assert.deepEqual(publicSettings.accounts[0].courseTimingOverrides, {});
    assert.equal(JSON.stringify(publicSettings).includes("test-secret"), false);
    await store.updateAutomationSettings({
      action: "timing",
      accountId: firstId,
      timing: { mode: "random", minMinutes: 12, maxMinutes: 24 }
    });
    assert.deepEqual((await store.readPublicSettings()).accounts[0].timing, {
      mode: "random", fixedMinutes: 10, minMinutes: 12, maxMinutes: 24
    });
    await store.updateAutomationSettings({
      action: "course-timing", accountId: firstId, courseName: "  高等  数学 ",
      timing: { mode: "fixed", fixedMinutes: 18 }
    });
    const courseTiming = { "高等 数学": { mode: "fixed", fixedMinutes: 18, minMinutes: 10, maxMinutes: 20 } };
    assert.deepEqual((await store.readAutomationSettings()).accounts[0].courseTimingOverrides, courseTiming);
    assert.deepEqual((await store.readPublicSettings()).accounts[0].courseTimingOverrides, courseTiming);
    await store.updateAutomationSettings({
      action: "course-timing", accountId: firstId, courseName: "高等 数学",
      timing: { mode: "random", minMinutes: 9, maxMinutes: 15 }
    });
    assert.deepEqual((await store.readPublicSettings()).accounts[0].courseTimingOverrides["高等 数学"], {
      mode: "random", fixedMinutes: 10, minMinutes: 9, maxMinutes: 15
    });
    await store.updateAutomationSettings({
      action: "timing", accountId: firstId,
      timing: { mode: "fixed", fixedMinutes: 22 }
    });
    assert.deepEqual((await store.readPublicSettings()).accounts[0].courseTimingOverrides["高等 数学"], {
      mode: "random", fixedMinutes: 10, minMinutes: 9, maxMinutes: 15
    }, "更新全局时间时应保留课程覆盖");
    await store.updateAutomationSettings({
      action: "timing", accountId: firstId, resetCourseTimingOverrides: true,
      timing: { mode: "fixed", fixedMinutes: 16 }
    });
    assert.deepEqual((await store.readPublicSettings()).accounts[0].timing, {
      mode: "fixed", fixedMinutes: 16, minMinutes: 10, maxMinutes: 20
    });
    assert.deepEqual((await store.readPublicSettings()).accounts[0].courseTimingOverrides, {}, "显式全局重置应清除单课覆盖");
    await store.updateAutomationSettings({
      action: "course-timing", accountId: firstId, courseName: "高等 数学",
      timing: { mode: "fixed", fixedMinutes: 18 }
    });
    await store.updateAutomationSettings({ action: "course-timing-clear", accountId: firstId, courseName: "高等 数学" });
    assert.deepEqual((await store.readPublicSettings()).accounts[0].courseTimingOverrides, {});
    assert.equal((await store.readPublicSettings()).accounts[0].signMethod, "timeTableId");
    assert.deepEqual((await store.readPublicSettings()).accounts[0].courseSignMethodOverrides, {});
    await store.updateAutomationSettings({ action: "sign-method", accountId: firstId, signMethod: "courseSchedId" });
    assert.equal((await store.readPublicSettings()).accounts[0].signMethod, "courseSchedId");
    await store.updateAutomationSettings({
      action: "course-sign-method", accountId: firstId, courseName: "  高等  数学 ", signMethod: "timeTableId"
    });
    assert.deepEqual((await store.readPublicSettings()).accounts[0].courseSignMethodOverrides, { "高等 数学": "timeTableId" });
    await store.updateAutomationSettings({
      action: "sign-method", accountId: firstId, signMethod: "timeTableId"
    });
    assert.deepEqual((await store.readPublicSettings()).accounts[0].courseSignMethodOverrides, { "高等 数学": "timeTableId" }, "更新默认方式时保留单课覆盖");
    await store.updateAutomationSettings({
      action: "sign-method", accountId: firstId, signMethod: "courseSchedId", resetCourseSignMethodOverrides: true
    });
    assert.equal((await store.readPublicSettings()).accounts[0].signMethod, "courseSchedId");
    assert.deepEqual((await store.readPublicSettings()).accounts[0].courseSignMethodOverrides, {}, "重置全部方式时清除单课覆盖");
    await store.updateAutomationSettings({
      action: "course-sign-method", accountId: firstId, courseName: "高等 数学", signMethod: "timeTableId"
    });
    await store.updateAutomationSettings({
      action: "course-sign-method-clear", accountId: firstId, courseName: "高等 数学"
    });
    assert.deepEqual((await store.readPublicSettings()).accounts[0].courseSignMethodOverrides, {});
    await assert.rejects(store.updateAutomationSettings({
      action: "sign-method", accountId: firstId, signMethod: "invalid"
    }), /签到方式无效/);
    await assert.rejects(store.updateAutomationSettings({
      action: "course-sign-method", accountId: firstId, courseName: "   ", signMethod: "courseSchedId"
    }), /课程名称无效/);
    await assert.rejects(store.updateAutomationSettings({
      action: "course-timing", accountId: firstId, courseName: "数学",
      timing: { mode: "random", minMinutes: 30, maxMinutes: 10 }
    }), /课程签到时间配置无效|签到时间配置无效/);
    await assert.rejects(store.updateAutomationSettings({
      action: "course-timing", accountId: firstId, courseName: "   ",
      timing: { mode: "fixed", fixedMinutes: 12 }
    }), /课程名称无效/);
    await store.updateAutomationSettings({
      action: "whitelist", accountId: firstId, courseWhitelist: ["  机器学习 ", "机器学习", "数据库  原理"]
    });
    assert.deepEqual((await store.readPublicSettings()).accounts[0].courseWhitelist, ["机器学习", "数据库 原理"]);
    await assert.rejects(store.updateAutomationSettings({ action: "whitelist", accountId: firstId, courseWhitelist: "机器学习" }), /白名单格式无效/);
    await assert.rejects(store.updateAutomationSettings({
      action: "timing",
      accountId: firstId,
      timing: { mode: "random", minMinutes: 30, maxMinutes: 10 }
    }), /签到时间配置无效/);
    await assert.rejects(store.updateAutomationSettings({
      action: "timing",
      accountId: firstId,
      timing: { mode: "fixed", fixedMinutes: 31 }
    }), /1 到 30 分钟/);
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
    await store.recordCompletedKeys(["acct-1:20260901:1234567:1", "acct-1:20260920:1234567:2"], "20260910");
    await store.recordCompletedKeys(["acct-1:20260920:1234567:2", "acct-1:20260921:1234568:3"], "20260910");
    assert.deepEqual(await store.readCompletedKeys(), ["acct-1:20260920:1234567:2", "acct-1:20260921:1234568:3"]);
    await store.updateAutomationSettings({ action: "remove", accountId: firstId });
    const cleared = await store.readPublicSettings();
    assert.equal(cleared.accounts.length, 1);
    const second = JSON.parse(await readFile(join(directory, "automation.json"), "utf8")).accounts[0];
    delete second.timing;
    second.courseTimingOverrides = {
      "  数据库  原理 ": { mode: "fixed", fixedMinutes: "18" },
      "   ": { mode: "fixed", fixedMinutes: 15 }
    };
    await writeFile(join(directory, "automation.json"), JSON.stringify({
      version: 2, accounts: [second], updatedAt: new Date().toISOString()
    }));
    const versionTwo = await store.readAutomationSettings();
    assert.equal(versionTwo.version, 3);
    assert.equal(versionTwo.accounts[0].timing.fixedMinutes, 10);
    assert.deepEqual(versionTwo.accounts[0].courseTimingOverrides, {
      "数据库 原理": { mode: "fixed", fixedMinutes: 18, minMinutes: 10, maxMinutes: 20 }
    });
    await writeFile(join(directory, "automation.json"), JSON.stringify({
      version: 1, enabled: true, credentials: second.credentials,
      updatedAt: new Date().toISOString(), refreshRequestedAt: null
    }));
    const legacy = await store.readAutomationSettings();
    assert.equal(legacy.accounts[0].id, "legacy");
    assert.equal(legacy.accounts[0].credentials.username, "20260002");
    assert.equal(legacy.accounts[0].timing.fixedMinutes, 10);
    assert.deepEqual(legacy.accounts[0].courseTimingOverrides, {});
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
