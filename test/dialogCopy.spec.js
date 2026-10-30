// 对话框文案机制与 FTL 完整性：中文／英文键集合一致，代码引用的键都存在，也没有无人引用的死键。
const { expect } = require("chai");
const { readdirSync, readFileSync } = require("node:fs");
const path = require("node:path");
const { DIALOG_LOCALES, readDialogMessages, loadDialogCopy } = require("./helpers/copy.cjs");

// 用例由 scripts/test-ui.mjs 以函数体方式加载，没有 __dirname；以仓库根为基准。
const ROOT = process.cwd();
const SOURCE_ROOT = path.join(ROOT, "src");

function sourceFiles(directory = SOURCE_ROOT) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

function referencedIds() {
  const found = new Set();
  for (const file of sourceFiles()) {
    for (const match of readFileSync(file, "utf8").matchAll(/"(dlg-[a-z0-9-]+)"/g)) found.add(match[1]);
  }
  return found;
}

describe("dialogCopy 与 dialogs.ftl", function () {
  let api;
  before(function () { api = globalThis.addon.api; });

  it("中文与英文的键集合完全一致", function () {
    const zh = Object.keys(readDialogMessages("zh-CN")).sort();
    const en = Object.keys(readDialogMessages("en-US")).sort();
    expect(en).to.deep.equal(zh);
    expect(zh.length).to.be.greaterThan(100);
  });

  it("代码引用的文案 id 都在 FTL 里", function () {
    const messages = readDialogMessages("zh-CN");
    const missing = [...referencedIds()].filter((id) => !(id in messages));
    expect(missing).to.deep.equal([]);
  });

  it("代码引用的每个 id 都登记在某个开窗文案表里", function () {
    const declared = new Set([
      ...api.BATCH_PREFLIGHT_COPY_IDS, ...api.BATCH_REVIEW_COPY_IDS, ...api.BATCH_STATUS_COPY_IDS,
      ...api.EXECUTION_COPY_IDS, ...api.UNDO_COPY_IDS, ...api.RESULT_COPY_IDS,
    ]);
    const missing = [...referencedIds()].filter((id) => !declared.has(id)).sort();
    expect(missing).to.deep.equal([]);
  });

  it("FTL 里没有无人引用的死键", function () {
    const used = referencedIds();
    const dead = Object.keys(readDialogMessages("zh-CN")).filter((id) => !used.has(id));
    expect(dead).to.deep.equal([]);
  });

  it("两条语言版本都只使用规范的 { $参数 } 占位", function () {
    for (const locale of DIALOG_LOCALES) {
      for (const [id, value] of Object.entries(readDialogMessages(locale))) {
        const stripped = value.replace(/\{ \$[A-Za-z0-9]+ \}/g, "");
        expect(stripped, `${locale}/${id} 存在不规范占位`).not.to.include("$");
      }
    }
  });

  it("带参数的文案按参数填入，缺键退回 id 而不是空字符串", function () {
    const { copy } = loadDialogCopy("zh-CN");
    const target = { textContent: "" };
    copy.apply(target, "dlg-exec-progress", { done: 2, total: 5 });
    expect(target.textContent).to.equal("已处理 2 / 5 个条目");
    copy.apply(target, "dlg-result-done");
    expect(target.textContent).to.equal("完成");
    expect(copy.text("dlg-does-not-exist")).to.equal("dlg-does-not-exist");
  });

  it("属性文案不写进 textContent，后到的写入覆盖先到的", function () {
    const { copy } = loadDialogCopy("zh-CN");
    const element = { textContent: "", attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
    copy.attribute(element, "aria-label", "dlg-review-accept-field", { field: "标题" });
    expect(element.attributes["aria-label"]).to.equal("采用新内容：标题");
    expect(element.textContent).to.equal("");
    copy.apply(element, "dlg-result-done");
    copy.apply(element, "dlg-common-cancel");
    expect(element.textContent).to.equal("取消");
  });

  it("英文环境解析英文文案", function () {
    const { copy } = loadDialogCopy("en-US");
    expect(copy.text("dlg-common-cancel")).to.equal("Cancel");
    const target = { textContent: "" };
    copy.apply(target, "dlg-exec-progress", { done: 1, total: 3 });
    expect(target.textContent).to.equal("1 / 3 items processed");
  });

  it("开窗时批量解析，缺 l10n 时退化为 id 且不抛错", async function () {
    const requested = [];
    const win = { document: { l10n: { formatValues: async (entries) => { requested.push(...entries.map((entry) => entry.id)); return entries.map((entry) => `T:${entry.id}`); } } } };
    const resolved = await api.createDialogCopy(win, ["dlg-result-done", "dlg-common-cancel", "dlg-result-done"]);
    expect(requested).to.deep.equal(["dlg-result-done", "dlg-common-cancel"]);
    expect(resolved.text("dlg-common-cancel")).to.equal("T:dlg-common-cancel");
    const bare = await api.createDialogCopy(undefined, ["dlg-result-done"]);
    expect(bare.text("dlg-result-done")).to.equal("dlg-result-done");
  });
});
