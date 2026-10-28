// 无宿主、无网络的核心回归入口；Zotero 显示／写库验证仍使用独立宿主套件。
import { build } from "esbuild";
import Mocha from "mocha";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, ".scaffold/core-tests/core-fixture.mjs");
const modules = [
  "update/contracts", "update/resolution", "update/doiFallbackResolver",
  "providers/translatorFailure", "providers/webTranslator", "providers/searchTranslator",
  "providers/mockMetadataResolver", "providers/doubanProvider", "providers/urlWebRoute",
  "providers/doiSearchRoute", "batchSyncUpdate",
  "update/changeExecutor", "update/zoteroMutationPort", "batchJournal", "update/planner", "batchRuntime",
];
await mkdir(path.dirname(out), { recursive: true });
await build({
  stdin: {
    contents: modules.map((name, i) => `import * as m${i} from ${JSON.stringify(`./src/modules/${name}.ts`)};`).join("\n")
      + `\nexport default Object.assign({}, ${modules.map((_, i) => `m${i}`).join(",")});`,
    resolveDir: root, sourcefile: "core-fixture.ts", loader: "ts",
  },
  outfile: out, bundle: true, format: "esm", platform: "node", target: "node24",
  define: { __testBuild__: "true", __mockAcquisition__: "false" },
});
const api = (await import(pathToFileURL(out).href)).default;
// 不仿造 Zotero Schema 或数据库；这些测试只注入自己的 fake host／route。
globalThis.Zotero = {
  zmtaAddon: { api, testApi: api }, debug() {},
  Utilities: { Internal: { md5: (text) => createHash("md5").update(text).digest("hex") } },
};
const mocha = new Mocha({ timeout: 5000 });
if (process.argv[2]) mocha.grep(new RegExp(process.argv[2]));
for (const file of [
  "updateContracts", "resolutionContracts", "doiNormalizer", "doiFallbackResolver",
  "webTranslator", "searchTranslator", "mockMetadataResolver", "httpRequestProtection",
  "changeExecutor", "batchJournal", "batchInspection", "zoteroMutationPort", "deliverySafety",
  "asyncMutationBoundaries", "deliveryClosure", "review006Fixes", "review006Followup",
]) {
  const filename = path.join(root, `test/${file}.spec.js`);
  // 宿主套件使用 CommonJS；不改原文件，也不让 Node 的 type:module 改变其语义。
  mocha.suite.emit("pre-require", globalThis, filename, mocha);
  new Function("require", await readFile(filename, "utf8"))(createRequire(filename));
}
process.exitCode = await new Promise((resolve) => mocha.run((failures) => resolve(failures ? 1 : 0)));
