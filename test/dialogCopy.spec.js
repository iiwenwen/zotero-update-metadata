// 对话框文案机制与 FTL 完整性：中文／英文键集合一致，代码引用的键都存在，也没有无人引用的死键。
const { expect } = require("chai");
const { readdirSync, readFileSync } = require("node:fs");
const path = require("node:path");
const { DIALOG_LOCALES, readDialogMessages, readFtl, loadDialogCopy } = require("./helpers/copy.cjs");

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

  it("异步乱序：先发起的写入后完成，也不能覆盖后发起的值", async function () {
    const resolvers = [];
    const l10n = { formatValues: async () => [], formatValue: () => new Promise((resolve) => { resolvers.push(resolve); }) };
    const copy = await api.createDialogCopy({ document: { l10n } }, []);
    const target = { textContent: "" };
    copy.apply(target, "dlg-exec-progress", { done: 1, total: 2 });
    copy.apply(target, "dlg-exec-progress", { done: 2, total: 2 });
    await new Promise((resolve) => setTimeout(resolve, 0)); // 先落到主窗口 l10n 才发请求
    expect(resolvers).to.have.length(2);
    resolvers[1]("第二次");
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolvers[0]("第一次");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(target.textContent).to.equal("第二次");
  });

  it("Fluent 缺消息会原样返回 id：不得写进界面，回退主窗口再回退静态表", async function () {
    const echo = await api.createDialogCopy({ document: { l10n: { formatValues: async (entries) => entries.map((entry) => entry.id) } } }, ["dlg-review-title"]);
    expect(echo.text("dlg-review-title")).to.equal("dlg-review-title"); // 不能把 zmta-dlg-* 当成已解析
    const dialogL10n = { formatValues: async () => [], formatValue: async (id) => id };
    const mainL10n = { formatValues: async () => [], formatValue: async (id) => `主窗:${id}` };
    const copy = await api.createDialogCopy({ document: { l10n: mainL10n } }, []);
    const el = { textContent: "", ownerDocument: { defaultView: { document: { l10n: dialogL10n } } } };
    copy.apply(el, "dlg-exec-progress", { done: 1, total: 2 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(el.textContent).to.equal("主窗:zmta-dlg-exec-progress");
  });

  it("批量解析抛错仍能开窗：text 退回 id，apply 不抛", async function () {
    const l10n = { formatValues: async () => { throw new Error("boom"); }, formatValue: async (id) => `已解析:${id}` };
    const copy = await api.createDialogCopy({ document: { l10n } }, ["dlg-review-title"]);
    expect(copy.text("dlg-review-title")).to.equal("dlg-review-title");
    const el = { textContent: "" };
    copy.apply(el, "dlg-review-title");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(el.textContent).to.equal("dlg-review-title");
  });

  it("fillCopy 按登记把 attribute 条目写进属性，其余写正文", function () {
    const element = { textContent: "原文本", attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
    const doc = { getElementById: (id) => (id === "el-1" ? element : null) };
    api.fillCopy(doc, api.staticDialogCopy({ "dlg-a": "属性文案", "dlg-b": "正文文案" }), [
      { elementID: "el-1", id: "dlg-a", attribute: "aria-label" },
      { elementID: "el-1", id: "dlg-b" },
      { elementID: "missing", id: "dlg-b" },
    ]);
    expect(element.attributes["aria-label"]).to.equal("属性文案");
    expect(element.textContent).to.equal("正文文案");
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
    // 构建给 FTL 消息 id 加插件前缀（同文件名），代码里仍只写短 id。
    expect(requested).to.deep.equal(["zmta-dlg-result-done", "zmta-dlg-common-cancel"]);
    expect(resolved.text("dlg-common-cancel")).to.equal("T:zmta-dlg-common-cancel");
    const bare = await api.createDialogCopy(undefined, ["dlg-result-done"]);
    expect(bare.text("dlg-result-done")).to.equal("dlg-result-done");
  });

  it("前缀常量与构建 namespace 一致，mainWindow 的键已自带前缀", function () {
    // 构建按 namespace 给 FTL 消息 id 加前缀；两处写死同一个值，必须对上。
    const config = readFileSync(path.join(ROOT, "zotero-plugin.config.ts"), "utf8");
    const declared = /namespace:\s*["']([\w-]+)["']/.exec(config)?.[1];
    expect(declared).to.equal(api.MESSAGE_NAMESPACE);
    // 侧栏/菜单在运行时直接写 data-l10n-id，源文件里必须已经带前缀，构建才不会二次加工。
    for (const locale of DIALOG_LOCALES) {
      const bare = Object.keys(readFtl(locale, "mainWindow.ftl")).filter((id) => !id.startsWith(`${declared}-`));
      expect(bare, `${locale}/mainWindow.ftl 的 id 必须自带前缀`).to.deep.equal([]);
    }
  });

  it("运行时逐条解析同样带前缀，且前缀不会叠加", async function () {
    expect(api.ftlMessageId("dlg-review-title")).to.equal("zmta-dlg-review-title");
    expect(api.ftlMessageId("zmta-dlg-review-title")).to.equal("zmta-dlg-review-title");
    // 与构建的 needsPrefix（startsWith(namespace)，不带连字符）保持同一条规则。
    expect(api.ftlMessageId("zmtax-odd")).to.equal("zmtax-odd");
    const requested = [];
    const l10n = {
      formatValues: async (entries) => entries.map((entry) => (entry.id.startsWith("zmta-dlg-") ? "已解析" : null)),
      formatValue: async (id) => { requested.push(id); return id.startsWith("zmta-dlg-") ? `已解析:${id}` : null; },
    };
    const win = { document: { l10n } };
    const copy = await api.createDialogCopy(win, ["dlg-review-title"]);
    expect(copy.text("dlg-review-title")).to.equal("已解析");
    const target = { textContent: "" };
    copy.apply(target, "dlg-exec-progress", { done: 1, total: 2 });
    // 动态属性（aria-label）走同一条运行时解析路径，同样必须补齐前缀。
    const labelled = { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
    copy.attribute(labelled, "aria-label", "dlg-review-accept-field", { field: "标题" });
    await new Promise(resolve => setTimeout(resolve, 0)); // 真实宿主走异步 formatValue
    expect(requested).to.deep.equal(["zmta-dlg-exec-progress", "zmta-dlg-review-accept-field"]);
    expect(target.textContent).to.equal("已解析:zmta-dlg-exec-progress");
    expect(labelled.attributes["aria-label"]).to.equal("已解析:zmta-dlg-review-accept-field");
  });
});
