// 无宿主、无网络的UI／工作流回归入口：node scripts/test-ui.mjs。
// 只生成.scaffold/ui-tests夹具；真实Zotero显示／写库仍由隔离宿主套件验证。
import { build } from "esbuild";
import Mocha from "mocha";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.join(root, ".scaffold/ui-tests");
const output = path.join(directory, "ui-fixture.mjs");
const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
await mkdir(directory, { recursive: true });
await build({
  stdin: {
    contents: [
      'import Addon from "./src/addon.ts";',
      'import * as pane from "./src/modules/itemPane.ts";',
      'import * as prefs from "./src/modules/itemPanePreferences.ts";',
      'import hooks, * as menu from "./src/hooks.ts";',
      'import * as dialogLifecycle from "./src/modules/dialogLifecycle.ts";',
      'import * as navigation from "./src/modules/metadataNavigation.ts";',
      'import * as workflowDialogs from "./src/modules/workflowDialogs.ts";',
      'import * as syncUpdate from "./src/modules/batchSyncUpdate.ts";',
      "const addon = new Addon();",
      "export default { addon, uiTestApi: { ...addon.api, ...addon.testApi, ...pane, ...prefs, ...menu, ...workflowDialogs, ...dialogLifecycle, ...navigation, ...syncUpdate, hooks } };",
    ].join("\n"),
    resolveDir: root, sourcefile: "ui-fixture.ts", loader: "ts",
  },
  outfile: output, bundle: true, format: "esm", platform: "node", target: "node24",
  define: {
    __testBuild__: "true", __mockAcquisition__: "false",
    __buildVersion__: JSON.stringify(version), __buildTime__: '"offline"',
  },
});
const fixture = (await import(pathToFileURL(output).href)).default;
// 直接检查宿主测试使用的访问口，避免uiTestApi合并导出掩盖Addon漏接线。
assert.equal(typeof fixture.addon.api.buildToolsMenuEntries, "function");
for (const name of [
  "getReviewSelectionDefaults", "getWorkflowActivity", "subscribeWorkflowActivity",
  "tryAcquireWorkflowActivity", "runDOIBatchWorkflow",
]) {
  assert.equal(typeof fixture.addon.testApi?.[name], "function", `缺少testApi接线：${name}`);
}
assert.equal("tryAcquireWorkflowActivity" in fixture.addon.api, false, "内部门禁不加入生产公开api");
const forbidden = () => { throw new Error("离线UI验证禁止宿主写入／联网"); };
// 所有窗口／DOM均由各用例提供fake；不提供真实宿主连接。
// 个别用例会临时注入假 Services（如 tm.dispatchToMainThread）验证主线程复查，用完即还原。
globalThis.fetch = forbidden;
globalThis.addon = fixture.addon;
globalThis.Zotero = {
  zmtaAddon: Object.assign(fixture.addon, { uiTestApi: fixture.uiTestApi }),
  debug() {}, alert() {}, getMainWindow: () => null,
  Prefs: { get: () => undefined }, Attachments: { importFromURL: forbidden },
  Items: { getAsync: forbidden }, HTTP: { request: forbidden },
  Utilities: { Internal: { md5: (text) => createHash("md5").update(text).digest("hex") } },
};
assert.equal(fixture.addon.api.buildToolsMenuEntries({})[0].menus[0].l10nID, "zmta-inspect-batches-menu-label");

const mocha = new Mocha({ timeout: 5000 });
for (const file of [
  "batchConfirmDialog", "batchStatusDialog", "batchPreflightDialog", "batchRuntime",
  "safeDefaults", "workflowActivity", "batchReadCancellation", "itemPane", "preferences", "hostProfile", "uiAlignment", "uiComponents", "dialogLifecycle", "dialogCopy",
]) {
  const filename = path.join(root, `test/${file}.spec.js`);
  mocha.suite.emit("pre-require", globalThis, filename, mocha);
  const module = { exports: {} };
  new Function("require", "module", "exports", await readFile(filename, "utf8"))(
    createRequire(filename), module, module.exports,
  );
  mocha.suite.emit("require", module.exports, filename, mocha);
  mocha.suite.emit("post-require", globalThis, filename, mocha);
}

// 精确排除现有两个真实宿主用例；不把未执行宿主项计作通过或隐式pending。
const hostTests = new Set([
  "batchConfirmDialog 在隔离 Zotero 宿主实际显示身份确认并可安全取消",
  "batchStatusDialog 在隔离 Zotero 宿主实际打开、检查并自动关闭真实对话框",
]);
const excludedHostTests = [];
function excludeHostTests(suite) {
  suite.tests = suite.tests.filter((test) => {
    const title = test.fullTitle();
    if (!hostTests.has(title)) return true;
    excludedHostTests.push(title);
    return false;
  });
  suite.suites.forEach(excludeHostTests);
}
excludeHostTests(mocha.suite);
assert.equal(excludedHostTests.length, hostTests.size, "宿主用例名称已变，请重新核对离线范围");
for (const title of excludedHostTests) console.log(`未执行真实宿主用例：${title}`);

const result = await new Promise((resolve) => {
  const runner = mocha.run((failures) => resolve({ failures, stats: runner.stats }));
});
const report = { ...result, excludedHostTests, mode: "offline-ui-production-fixture" };
await writeFile(path.join(directory, "results.json"), JSON.stringify(report, null, 2) + "\n");
assert.equal(result.failures, 0, "离线UI／工作流测试失败");
assert.equal(result.stats.pending, 0, "离线fixture缺接线，不应出现被skip的离线用例");

// 原生偏好资产也进入稳定入口；断言单独报告，不混入Mocha用例数。
const declaredPrefs = {};
runInNewContext(await readFile(path.join(root, "addon/prefs.js"), "utf8"), {
  pref: (key, value) => { declaredPrefs[key] = value; },
});
assert.deepEqual(declaredPrefs, {
  showItemPane: true, defaultSelectAttachments: false,
  defaultSelectNotes: false, showTechnicalDetails: false,
});
const markup = await readFile(path.join(root, "addon/content/preferences.xhtml"), "utf8");
assert.deepEqual([...markup.matchAll(/preference="([^"]+)"/g)].map((match) => match[1]), [
  "extensions.zmta.showItemPane", "extensions.zmta.defaultSelectAttachments", "extensions.zmta.defaultSelectNotes",
]);
assert.equal((markup.match(/<checkbox\b/g) || []).length, 3);
assert.equal((markup.match(/<groupbox\b/g) || []).length, 2);
assert.equal(/pref-title|showTechnicalDetails|<html:h1/.test(markup), false);
for (const name of ["preferences", "mainWindow"]) {
  const en = await readFile(path.join(root, `addon/locale/en-US/${name}.ftl`), "utf8");
  const zh = await readFile(path.join(root, `addon/locale/zh-CN/${name}.ftl`), "utf8");
  const keys = (text) => [...text.matchAll(/^([\w-]+)\s*=/gm)].map((match) => match[1]).sort();
  assert.deepEqual(keys(en), keys(zh));
  if (name === "preferences") {
    for (const match of markup.matchAll(/data-l10n-id="([^"]+)"/g)) assert(keys(en).includes(match[1]), match[1]);
  }
}
report.assetsPassed = true;
await writeFile(path.join(directory, "results.json"), JSON.stringify(report, null, 2) + "\n");
console.log("原生偏好资产通过：默认值、三项完整绑定、两组、复用宿主标题及中英文键一致。");

// 品牌图形必须复用原图，不允许用另一个图案替代。SVG仅适配宿主绘制尺寸。
const brandIcon = await readFile(path.join(root, "addon/content/icons/favicon.png"));
for (const size of [16, 20]) {
  const svg = await readFile(path.join(root, `addon/content/icons/favicon-${size}.svg`), "utf8");
  assert.ok(svg.includes(`width="${size}" height="${size}"`));
  const embedded = /href="data:image\/png;base64,([^"]+)"/.exec(svg)?.[1];
  assert.ok(embedded, "缺少原App图标");
  assert.deepEqual(Buffer.from(embedded, "base64"), brandIcon, "侧栏和菜单必须使用原App图标");
}
console.log("品牌图标通过：原图内容一致，16/20尺寸适配。");
