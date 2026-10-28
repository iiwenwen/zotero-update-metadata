// 批次状态窗口的纯布局与 fake Dialog/DOM 测试；由主 Agent 接入 addon.api 后运行。
const { expect } = require("chai");

describe("batchStatusDialog", function () {
  let api;

  const batches = () => [
    {
      batchId: "batch-running",
      createdAt: "2026-08-30T08:00:00.000Z",
      status: "running",
      incomplete: true,
      items: [{
        itemID: 1,
        itemKey: "ITEM1",
        title: "一段很长的条目标题".repeat(20),
        source: {
          providerId: "douban-web",
          routeId: "url.web",
          sourceId: "https://secret.example.test/?token=must-not-render",
          identifiers: [{ type: "ISBN", value: "9780000000001" }],
        },
        operations: [
          { operationId: "field:title", kind: "field", label: "title", before: "旧标题", after: "新标题", status: "applied" },
          { operationId: "creators:set", kind: "creators", label: "Creator 列表", before: [{ creatorType: "author", firstName: "旧", lastName: "作者" }], after: [{ creatorType: "translator", name: "翻译组" }], status: "applied" },
          { operationId: "attachment:a", kind: "attachment", label: "目录", status: "failed", message: "下载失败 ".repeat(80) },
          { operationId: "note:n", kind: "note", label: "Note", status: "planned" },
        ],
      }],
    },
    {
      batchId: "batch-rollback",
      createdAt: "2026-08-29T08:00:00.000Z",
      completedAt: "2026-08-29T08:01:00.000Z",
      status: "rollback-partial",
      incomplete: false,
      items: [{
        itemID: 2,
        itemKey: "ITEM2",
        title: "发生回滚冲突的条目",
        source: { providerId: "zotero", routeId: "doi.search", identifiers: [{ type: "DOI", value: "10.1/example" }] },
        operations: [
          { operationId: "field:date", kind: "field", label: "date", before: "2025", after: "2026", status: "rollback-conflict", message: "当前值已被人工修改" },
          { operationId: "note:old", kind: "note", label: "Note", status: "rolled-back" },
        ],
      }],
    },
  ];

  function textOf(node) {
    if (!node || typeof node !== "object") return "";
    return [node.properties?.textContent, ...(node.children || []).map(textOf)].filter(Boolean).join("\n");
  }

  function inputsOf(node, output = []) {
    if (!node || typeof node !== "object") return output;
    if (node.tag === "input") output.push(node);
    for (const child of node.children || []) inputsOf(child, output);
    return output;
  }

  function nodesByClass(node, className, output = []) {
    if (!node || typeof node !== "object") return output;
    if (node.classList?.includes(className)) output.push(node);
    for (const child of node.children || []) nodesByClass(child, className, output);
    return output;
  }

  before(function () {
    api = Zotero.zmtaAddon.api;
  });

  it("稳定映射批次与操作状态标签", function () {
    expect(api.getBatchStatusLabel("running")).to.equal("进行中");
    expect(api.getBatchStatusLabel("rollback-partial")).to.equal("部分回滚");
    expect(api.getBatchOperationStatusLabel("failed")).to.equal("失败");
    expect(api.getBatchOperationStatusLabel("rollback-conflict")).to.equal("回滚冲突");
  });

  it("汇总多个批次、条目、四类操作及异常状态", function () {
    expect(api.summarizeBatchStatus(batches())).to.deep.equal({
      batches: 2,
      incomplete: 1,
      items: 2,
      fields: 2,
      creators: 1,
      attachments: 1,
      notes: 2,
      failed: 1,
      rollbackConflicts: 1,
    });
  });

  it("来源摘要默认只展示来源名称，技术入口不展示 sourceId 或 sourceURL", function () {
    const data = batches();
    expect(api.formatBatchInspectionSource(data[0].items[0].source)).to.equal("来源：豆瓣读书");
    expect(api.formatBatchInspectionSource(undefined)).to.equal("来源：未知");
    const serialized = JSON.stringify(api.buildBatchStatusDialogLayout(data));
    expect(serialized).not.to.include("secret.example.test");
    expect(serialized).not.to.include("sourceURL");
    expect(nodesByClass(api.buildBatchStatusDialogLayout(data), "zmta-technical-details")).to.deep.equal([]);
    expect(serialized).not.to.include("10.1/example");
  });

  it("设置开启后展示折叠技术详情，并保留来源、状态、before/after 与错误", function () {
    const layout = api.buildBatchStatusDialogLayout(batches(), { showTechnicalDetails: true });
    expect(layout.id).to.equal("zmta-batch-status");
    expect(layout.children[0].children[0].properties.textContent).to.equal("2 个批次 · 1 个未完成");
    const workspace = layout.children[1];
    expect(workspace.children[0].children).to.have.length(2);
    expect(workspace.children[1].children).to.have.length(2);
    const allText = textOf(layout);
    expect(allText).to.include("最近一次更新");
    expect(allText).to.include("发生回滚冲突的条目");
    expect(allText).to.include("来源：Zotero");
    expect(allText).to.include("获取方式：DOI 检索");
    expect(allText).to.include("旧标题 → 新标题");
    expect(allText).to.include("1. 旧 作者 · 作者 → 1. 翻译组 · 译者");
    expect(allText).to.include("下载失败");
    expect(allText).to.include("回滚冲突");
    expect(inputsOf(layout)).to.deep.equal([]);
    expect(workspace.children[1].styles.overflow).to.equal("auto");
    expect(layout.children[2].properties.textContent).to.include("overflow-wrap: anywhere");
    expect(layout.children[2].properties.textContent).to.include("max-width: 700px");
  });

  it("空状态仍返回完整只读布局", function () {
    const layout = api.buildBatchStatusDialogLayout([]);
    expect(textOf(layout)).to.include("没有可查看的批次");
    expect(textOf(layout)).to.include("没有更新记录");
    expect(textOf(layout)).to.include("无批次");
    expect(textOf(layout)).to.include("没有批次详情");
    expect(inputsOf(layout)).to.deep.equal([]);
  });

  it("点击批次只切换 aria-selected 与详情显示", function () {
    const layout = api.buildBatchStatusDialogLayout(batches());
    const tabs = layout.children[1].children[0].children;
    const records = new Map();
    for (let index = 0; index < 2; index += 1) {
      records.set(`zmta-batch-status-tab-${index}`, {
        selected: String(index === 0),
        setAttribute(_name, value) { this.selected = value; },
      });
      records.set(`zmta-batch-status-detail-${index}`, { style: { display: index === 0 ? "block" : "none" } });
    }
    const doc = { getElementById: (id) => records.get(id) };
    tabs[1].listeners[0].listener({ currentTarget: { ownerDocument: doc } });
    expect(records.get("zmta-batch-status-tab-0").selected).to.equal("false");
    expect(records.get("zmta-batch-status-tab-1").selected).to.equal("true");
    expect(records.get("zmta-batch-status-detail-0").style.display).to.equal("none");
    expect(records.get("zmta-batch-status-detail-1").style.display).to.equal("block");
  });

  it("Dialog 只有关闭按钮，内容 cell 启用 flex，关闭与 beforeUnload 幂等", async function () {
    let instance;
    let resolveCalls = 0;
    class FakeDialog {
      constructor() { instance = this; this.buttons = {}; this.window = { document: {} }; }
      addCell(_row, _column, layout, flex) { this.layout = layout; this.flex = flex; return this; }
      addButton(label, id, options) { this.buttons[id] = { label, ...options }; return this; }
      setDialogData(data) { this.dialogData = data; return this; }
      open(title, options) { this.title = title; this.options = options; }
    }
    const pending = api.showBatchStatusDialog(batches(), { Dialog: FakeDialog }).then(() => { resolveCalls += 1; });
    expect(Object.keys(instance.buttons)).to.deep.equal(["zmta-batch-status-close"]);
    expect(instance.buttons["zmta-batch-status-close"].label).to.equal("关闭");
    expect(instance.flex).to.equal(true);
    expect(instance.title).to.equal("批次状态");
    expect(instance.options).to.deep.equal(api.getBatchStatusDialogOptions());
    instance.buttons["zmta-batch-status-close"].callback();
    instance.dialogData.beforeUnloadCallback();
    instance.buttons["zmta-batch-status-close"].callback();
    await pending;
    expect(resolveCalls).to.equal(1);
  });

  it("在隔离 Zotero 宿主实际打开、检查并自动关闭真实对话框", async function () {
    this.timeout(10000);
    require("./hostProfile.cjs").assertDedicatedTestProfile(Zotero, Services, Ci);

    let helper;
    let pending;
    try {
      pending = api.showBatchStatusDialog(
        batches(),
        Zotero.zmtaAddon.data.ztoolkit,
        { onOpen: (dialog) => { helper = dialog; } },
      );
      expect(helper).to.be.an("object");
      await helper.dialogData.loadLock.promise;

      const doc = helper.window.document;
      const root = doc.getElementById("zmta-batch-status");
      const sidebar = root?.querySelector(".zmta-status-sidebar");
      const detail = root?.querySelector(".zmta-status-detail-pane");
      expect(root).not.to.equal(null);
      expect(sidebar).not.to.equal(null);
      expect(detail).not.to.equal(null);
      expect(root.textContent).to.include("最近一次更新");
      expect(root.textContent).to.include("发生回滚冲突的条目");
      expect(root.textContent).not.to.include("secret.example.test");
      expect(root.querySelector(".zmta-technical-details")).to.equal(null);
      expect(helper.window.getComputedStyle(sidebar).overflowY).to.match(/auto|scroll/);
      expect(helper.window.getComputedStyle(detail).overflowY).to.match(/auto|scroll/);
      const tabs = [...root.querySelectorAll(".zmta-status-tab")];
      for (let index = 0; index < tabs.length; index += 1) {
        const bounds = tabs[index].getBoundingClientRect();
        expect(tabs[index].lastElementChild.getBoundingClientRect().bottom).to.be.at.most(bounds.bottom);
        if (tabs[index + 1]) expect(bounds.bottom).to.be.at.most(tabs[index + 1].getBoundingClientRect().top);
      }

      doc.getElementById("zmta-batch-status-close").click();
      await pending;
      expect(helper.window.closed).to.equal(true);
    } finally {
      if (helper?.window && !helper.window.closed) helper.window.close();
      if (pending) {
        await Promise.race([
          pending.catch(() => undefined),
          Zotero.Promise.delay(2000),
        ]);
      }
    }
  });
});
