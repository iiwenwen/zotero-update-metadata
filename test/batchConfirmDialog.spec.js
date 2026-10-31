// 批量审核 UI 的纯逻辑测试；由主 Agent 在 addon.api 接入导出后运行。
const { assert, expect } = require("chai");
const { loadDialogCopy, renderCopy } = require("./helpers/copy.cjs");

describe("batchConfirmDialog", function () {
  let api;

  const previews = () => [
    {
      itemID: 1,
      itemKey: "BOOK1",
      libraryID: 1,
      title: "第一本书",
      sourceURL: "https://book.douban.com/subject/1/",
      status: "ready",
      fields: [
        { field: "publisher", local: "", incoming: "新出版社", isConflict: false, defaultChecked: true },
        { field: "title", local: "旧标题", incoming: "新标题", isConflict: true, defaultChecked: false },
      ],
      attachments: [{ title: "目录.pdf", mimeType: "application/pdf", url: "https://example.test/a.pdf" }],
      notes: [{ content: "上游 note", defaultChecked: true }],
    },
    {
      itemID: 2,
      itemKey: "BOOK2",
      libraryID: 1,
      title: "第二本书",
      sourceURL: null,
      status: "skipped",
      message: "无豆瓣 URL",
      fields: [],
      attachments: [],
      notes: [],
    },
    {
      itemID: 3,
      itemKey: "BOOK3",
      libraryID: 1,
      title: "第三本书",
      sourceURL: "https://book.douban.com/subject/3/",
      status: "failed",
      message: "预检失败",
      fields: [],
      attachments: [],
      notes: [],
    },
  ];

  function findNode(node, predicate) {
    if (!node || typeof node !== "object") return undefined;
    if (predicate(node)) return node;
    for (const child of node.children || []) {
      const found = findNode(child, predicate);
      if (found) return found;
    }
    return undefined;
  }

  function findByClass(node, className) {
    return findNode(node, (entry) => entry.classList?.includes(className));
  }

  function sectionByTitle(detail, title) {
    if (title === "字段") return (detail.children || []).find(child => child.classList?.includes("zmta-fields"));
    return (detail.children || []).find((child) => child.classList?.includes("zmta-section")
      && child.children?.[0]?.children?.[0]?.properties?.textContent === title);
  }

  let copy;
  /** 生产布局 + 挂载后填充，等价于真实窗口显示出来的样子。 */
  const dialogLayout = (previews, options, actions) => renderCopy(api.buildBatchDialogLayout(previews, copy, options, actions), copy);

  before(function () {
    const addon = Zotero.zmtaAddon;
    assert.isNotEmpty(addon, "addon 应存在");
    api = addon.api;
    ({ copy } = loadDialogCopy());
  });

  it("汇总顶部的总数、可更新、跳过、失败及三类候选", function () {
    expect(api.summarizeBatchPreviews(previews())).to.deep.equal({
      total: 3,
      ready: 1,
      blocked: 0,
      skipped: 1,
      failed: 1,
      fields: 2,
      creators: 0,
      attachments: 1,
      notes: 1,
    });
  });

  it("缺失字段默认勾选，覆盖已有值默认不勾选", function () {
    const [missing, overwrite] = previews()[0].fields;
    expect(api.getBatchFieldDefaultChecked(missing)).to.equal(true);
    expect(api.getBatchFieldDefaultChecked(overwrite)).to.equal(false);
  });

  it("切换长条目详情归顶且保留既有勾选节点", async function () {
    const { Dialog } = require("./uiDialog.cjs");
    const pending = api.showBatchConfirmDialog(previews(), { Dialog }, copy);
    const dialog = Dialog.instances.at(-1);
    const input = dialog.nodes.get("zmta-batch-field-0-0");
    input.checked = false;
    const pane = dialog.nodes.get("zmta-batch-detail-pane"); pane.scrollTop = 812;
    dialog.nodes.get("zmta-review-navigation-row-1").emit("click");
    expect(pane.scrollTop).to.equal(0);
    expect(dialog.nodes.get("zmta-batch-detail-1").style.display).to.equal("block");
    expect(dialog.nodes.get("zmta-batch-field-0-0")).to.equal(input);
    expect(input.checked).to.equal(false);
    dialog.click("zmta-batch-cancel"); expect(await pending).to.equal(null);
    expect(dialog.mediaListeners.size).to.equal(0);
  });

  it("布局只显示有内容的审核分区，默认不提供技术详情", function () {
    const layout = dialogLayout(previews());
    expect(layout.id).to.equal("zmta-batch-review");
    const [header, body, footer] = layout.children;
    expect(header.children[0].children[0].properties.textContent).to.equal("3 个条目 · 1 个可更新");
    const selectionSummary = findNode(footer, (node) => node.id === "zmta-batch-selection-summary");
    expect(selectionSummary.properties.textContent).to.equal("已勾选 1 个条目 · 1 项更新");
    expect(header.children[1].properties.textContent).to.equal("勾选所有条目的空白字段");
    const [left, right] = body.children;
    expect(left.tag).to.equal("nav");
    expect(left.id).to.equal("zmta-review-navigation");
    expect(left.children).to.equal(undefined);
    expect(right.tag).to.equal("main");
    const readyDetail = right.children[0];
    const source = findByClass(readyDetail, "zmta-detail-source");
    expect(source.classList).to.include("zmta-detail-source");
    expect(source.children[0].properties.textContent).to.equal("来源：豆瓣读书");
    expect(source.children).to.have.length(3);
    expect(JSON.stringify(readyDetail)).not.to.include("https://book.douban.com/subject/1/");
    expect(sectionByTitle(readyDetail, "字段").children[0].tag).to.equal("table");
    expect(sectionByTitle(readyDetail, "新增附件")).not.to.equal(undefined);
    expect(sectionByTitle(readyDetail, "新增笔记")).not.to.equal(undefined);
    expect(sectionByTitle(readyDetail, "作者与贡献者")).to.equal(undefined);
    expect(findByClass(right.children[1], "zmta-detail-source")).to.equal(undefined);
    expect(findByClass(right.children[1], "zmta-item-message").properties.textContent).to.equal("无豆瓣 URL");
    const headers = findNode(readyDetail, (node) => node.tag === "thead");
    expect(headers.children[0].children.map((node) => node.properties.textContent)).to.deep.equal(["采用", "项目", "现有内容", "来源内容"]);
  });

  it("字段使用宿主名称和可读后备名，来源内部ID不进入普通视图", function () {
    const data = [previews()[0]];
    data[0].fields = ["accessDate", "conferenceName", "libraryCatalog", "place", "futureInternalKey"].map((field) => ({ field, local: "", incoming: "新内容", defaultChecked: true }));
    data[0].candidate = { providerId: "zotero-search" };
    const fields = Zotero.ItemFields;
    try {
      Zotero.ItemFields = { getLocalizedString: (key) => key === "conferenceName" ? "宿主会议名称" : key };
      const layout = dialogLayout(data);
      const text = JSON.stringify(layout);
      for (const label of ["访问时间", "宿主会议名称", "文库编目", "地点", "其他信息", "Zotero（按 DOI 查找）"]) expect(text).to.include(label);
      for (const key of ["accessDate", "conferenceName", "libraryCatalog", "futureInternalKey", "zotero-search"]) expect(text).not.to.include(key);
      const technical = JSON.stringify(dialogLayout(data, { showTechnicalDetails: true }));
      expect(technical).to.include("zotero-search");
    } finally { Zotero.ItemFields = fields; }
  });

  it("设置开启后才提供默认折叠的技术详情", function () {
    const layout = dialogLayout(previews(), { showTechnicalDetails: true });
    const detail = layout.children[1].children[1].children[0];
    const source = findByClass(detail, "zmta-detail-source");
    expect(source.children.at(-1).tag).to.equal("details");
    expect(source.children.at(-1).attributes?.open).to.equal(undefined);
    expect(source.children.at(-1).children[1].properties.textContent).to.include("https://book.douban.com/subject/1/");
  });

  it("布局复用系统主题并保留响应式内容排版", function () {
    const layout = dialogLayout(previews());
    const style = layout.children.find((node) => node.tag === "style");
    expect(style.tag).to.equal("style");
    expect(style.properties.textContent).to.include("#zmta-batch-review");
    expect(style.properties.textContent).to.include("--zmta-window: Canvas");
    expect(style.properties.textContent).to.include("--zmta-muted: var(--fill-secondary, var(--zmta-text, CanvasText))");
    expect(style.properties.textContent).not.to.include("--zmta-muted: GrayText");
    expect(style.properties.textContent).to.include("max-width: 760px");
    expect(style.properties.textContent).to.include("max-height: 600px");
    expect(style.properties.textContent).to.include(".zmta-diff-row");
    expect(style.properties.textContent).not.to.match(/button\s*[:{]/);
    expect(style.properties.textContent).not.to.include("line-through");
  });

  it("根布局及主从内容区占满 DialogHelper 可用宽度", function () {
    const layout = dialogLayout(previews());
    const body = layout.children[1];
    expect(layout.styles).to.include({
      width: "100%",
      minWidth: "0",
      boxSizing: "border-box",
    });
    expect(body.styles).to.include({
      width: "100%",
      minWidth: "0",
      boxSizing: "border-box",
    });
    expect(findByClass(layout, "zmta-footer")).not.to.equal(undefined);
  });

  it("精确统计实际有勾选操作的条目与三类操作数", function () {
    const selections = [
      { itemID: 1, itemKey: "A", fields: [{ field: "title" }], attachments: [{ title: "a" }], notes: [] },
      { itemID: 2, itemKey: "B", fields: [], attachments: [], notes: [] },
      { itemID: 3, itemKey: "C", fields: [], attachments: [], notes: [{ content: "n" }, { content: "n2" }] },
    ];
    const summary = api.summarizeBatchSelections(selections);
    expect(summary).to.deep.equal({ items: 2, fields: 1, creators: 0, attachments: 1, notes: 2 });
    expect(api.batchSelectionSummaryArgs(summary)).to.deep.equal({ items: 2, ops: 4 });
  });

  it("复选框变化后动态刷新实际选中摘要", function () {
    const layout = dialogLayout(previews());
    const footer = layout.children[2];
    const readyDetail = layout.children[1].children[1].children[0];
    const firstFieldInput = findNode(readyDetail, (node) => node.id === "zmta-batch-field-0-0");
    const summaryElement = { textContent: "旧摘要" };
    const checked = new Set(["zmta-batch-field-0-1", "zmta-batch-note-0-0"]);
    const doc = {
      getElementById: (id) => id === "zmta-batch-selection-summary"
        ? summaryElement
        : { checked: checked.has(id) },
    };
    firstFieldInput.listeners[0].listener({ currentTarget: { ownerDocument: doc } });
    expect(summaryElement.textContent).to.equal("已勾选 1 个条目 · 2 项更新");
    expect(findNode(footer, (node) => node.id === "zmta-batch-selection-summary").properties.textContent).to.equal("已勾选 1 个条目 · 1 项更新");
  });

  it("底部更新按钮排除未确认身份，零有效选择时禁用", function () {
    const data = previews();
    data[0].identityReview = { required: true, matchedFields: ["title"], summary: "请核对作品" };
    const layout = dialogLayout(data);
    expect(findNode(layout, (node) => node.id === "zmta-batch-confirm")).to.equal(undefined);
    const checked = new Set(["zmta-batch-field-0-0", "zmta-batch-note-0-0"]);
    const confirm = { disabled: false };
    const summary = {};
    const doc = { getElementById: (id) => id === "zmta-batch-confirm" ? confirm
      : id === "zmta-batch-selection-summary" ? summary : { checked: checked.has(id) } };
    const identity = findNode(layout, (node) => node.id === "zmta-batch-identity-0");
    const change = () => identity.listeners[0].listener({ currentTarget: { ownerDocument: doc } });
    change();
    expect(confirm.disabled).to.equal(true);
    expect(summary.textContent).to.equal("已勾选 0 个条目 · 0 项更新");
    checked.add("zmta-batch-identity-0");
    change();
    expect(confirm.disabled).to.equal(false);
    expect(summary.textContent).to.equal("已勾选 1 个条目 · 2 项更新");
    checked.clear();
    change();
    expect(confirm.disabled).to.equal(true);
  });

  it("展开两侧长文本不会勾选字段，也不将上游文本作为 HTML", function () {
    const data = previews();
    data[0].fields[1] = { field: "abstractNote", local: "本地简介", incoming: '<img src="x" onerror="alert(1)">' + "长文本".repeat(100), defaultChecked: false };
    const layout = dialogLayout(data);
    const row = findNode(layout, (node) => node.id === "zmta-batch-field-0-1-row");
    const input = findNode(row, (node) => node.id === "zmta-batch-field-0-1");
    const incoming = findNode(row, (node) => node.id === "zmta-batch-field-0-1-incoming");
    expect(incoming.properties.textContent).to.equal(data[0].fields[1].incoming);
    expect(incoming.properties.innerHTML).to.equal(undefined);
    const oldCell = findByClass(row, "zmta-old-value");
    const newCell = findByClass(row, "zmta-new-value");
    for (const cell of [oldCell, newCell]) {
      expect(cell.children[1].tag).to.equal("details");
      expect(cell.children[1].children[0].tag).to.equal("summary");
      expect(cell.children[1].listeners).to.equal(undefined);
    }
    expect(input.properties.checked).to.equal(false);
  });

  it("单条确认省略导航，不生成需要维护的单项按钮列表", function () {
    const layout = dialogLayout([previews()[0]]);
    const nav = findNode(layout, n => n.id === "zmta-review-navigation");
    expect(nav.styles.display).to.equal("none");
    expect(layout.children[1].attributes["data-single"]).to.equal("true");
  });

  it("失败或阻断条目即使带候选也不提供可勾选更新", function () {
    const data = previews();
    data[0].status = "blocked";
    const layout = dialogLayout(data);
    const detail = findNode(layout, (node) => node.id === "zmta-batch-detail-0");
    expect(findNode(detail, (node) => node.tag === "input")).to.equal(undefined);
    expect(findNode(layout, (node) => node.id === "zmta-batch-confirm")).to.equal(undefined);
  });

  it("Note 预览移除 HTML 标签并保留可读换行", function () {
    const data = previews();
    data[0].notes[0].content = "<h1>目录</h1><p>第一章<br>第二章</p>";
    const layout = dialogLayout(data);
    const notePreview = findByClass(layout.children[1].children[1].children[0], "zmta-note-preview");
    expect(notePreview.properties.textContent).to.equal("目录\n第一章\n第二章");
  });

  it("字段、附件与 notes 只收集勾选项，并排除跳过/失败条目", function () {
    const checked = new Set([
      "zmta-batch-field-0-0",
      "zmta-batch-attachment-0-0",
      "zmta-batch-note-0-0",
    ]);
    const doc = { getElementById: (id) => ({ checked: checked.has(id) }) };
    const selections = api.collectBatchSelections(previews(), doc);
    expect(selections).to.have.length(1);
    expect(selections[0].itemKey).to.equal("BOOK1");
    expect(selections[0].fields.map((field) => field.field)).to.deep.equal(["publisher"]);
    expect(selections[0].attachments).to.have.length(1);
    expect(selections[0].notes).to.have.length(1);
  });

  it("Creator 以一个复选项展示并整组透传，保留顺序、重复项与双角色", function () {
    const data = previews();
    data[0].creators = {
      local: [{ creatorType: "author", firstName: "旧", lastName: "作者" }],
      incoming: [
        { creatorType: "author", firstName: "张", lastName: "三" },
        { creatorType: "translator", firstName: "张", lastName: "三" },
        { creatorType: "author", firstName: "张", lastName: "三" },
        { creatorType: "editor", name: "编辑委员会" },
      ],
      isConflict: true,
      defaultChecked: false,
    };
    const layout = dialogLayout(data);
    const detail = layout.children[1].children[1].children[0];
    const section = sectionByTitle(detail, "字段");
    const row = findByClass(section, "zmta-creators-row");
    expect(findByClass(row, "zmta-field-hint").properties.textContent).to.equal("整组选择");
    expect(sectionByTitle(detail, "作者与贡献者")).to.equal(undefined);
    const input = findNode(row, (node) => node.id === "zmta-batch-creators-0");
    expect(input.properties.checked).to.equal(false);
    expect(findByClass(row, "zmta-creators-incoming").children.map((entry) => entry.properties.textContent)).to.deep.equal([
      "张 三 · 作者",
      "张 三 · 译者",
      "张 三 · 作者",
      "编辑委员会 · 编辑",
    ]);

    const unchecked = { getElementById: () => ({ checked: false }) };
    expect(api.collectBatchSelections(data, unchecked)[0].creators).to.equal(undefined);
    const checked = { getElementById: (id) => ({ checked: id === "zmta-batch-creators-0" }) };
    const selection = api.collectBatchSelections(data, checked)[0];
    expect(selection.creators).to.deep.equal(data[0].creators);
    expect(api.summarizeBatchSelections([selection])).to.include({ items: 1, creators: 1 });
  });

  it("组合证据候选必须先明确确认身份，才能进入字段选择结果", function () {
    const data = previews();
    data[0].identityReview = {
      required: true,
      matchedFields: ["title", "creator"],
      summary: "系统已匹配：title、creator；请确认",
    };
    const layout = dialogLayout(data);
    const identity = layout.children[1].children[1].children[0].children[1];
    expect(identity.classList).to.include("zmta-identity-review");
    expect(findNode(identity, node => node.id === "zmta-batch-identity-0").properties.checked).to.equal(false);

    const documentFor = (confirmed) => ({
      getElementById: (id) => ({
        checked: id === "zmta-batch-identity-0"
          ? confirmed
          : id === "zmta-batch-field-0-0",
      }),
    });
    expect(api.collectBatchSelections(data, documentFor(false))).to.deep.equal([]);
    const accepted = api.collectBatchSelections(data, documentFor(true));
    expect(accepted).to.have.length(1);
    expect(accepted[0].identityConfirmed).to.equal(true);
  });

  it("失败尝试显示具体阶段、HTTP 状态和原始原因", function () {
    const data = previews();
    data[0].attempts = [{
      routeId: "url.web",
      attempt: 1,
      inputIdentifiers: [],
      returnedIdentifiers: [],
      sourceId: "unknown",
      fetchedAt: "2026-09-02T00:00:00.000Z",
      outcome: "fetch-failed",
      diagnostic: {
        stage: "document-fetch",
        message: "页面获取失败：Unexpected status code 403",
        httpStatus: 403,
      },
    }];
    const detail = dialogLayout(data, { showTechnicalDetails: true }).children[1].children[1].children[0];
    const source = findByClass(detail, "zmta-detail-source");
    expect(source.children.at(-1).children[1].properties.textContent)
      .to.include("document-fetch：页面获取失败：Unexpected status code 403，HTTP 403");
  });

  it("非法字段只读展示且不会生成复选项", function () {
    const data = previews();
    data[0].excludedFields = [{
      field: "proceedingsTitle",
      reason: "invalid-for-item-type",
      message: "字段“proceedingsTitle”不适用于条目类型 book，已排除",
    }];
    const detail = dialogLayout(data).children[1].children[1].children[0];
    const warning = findByClass(detail, "zmta-excluded-fields");
    expect(warning.classList).to.include("zmta-excluded-fields");
    expect(warning.children[0].properties.textContent).to.equal("有 1 个字段不适用于此条目，已排除。");
    expect(warning.children).to.have.length(1);
    const technicalWarning = findByClass(
      dialogLayout(data, { showTechnicalDetails: true }),
      "zmta-excluded-fields",
    );
    expect(technicalWarning.children[1].tag).to.equal("details");
    expect(technicalWarning.children[1].children[1].properties.textContent).to.include("proceedingsTitle");
    expect(JSON.stringify(warning)).not.to.include('type":"checkbox');
  });

  it("取消或窗口关闭所需的空文档收集返回空结果", function () {
    expect(api.collectBatchSelections(previews(), null)).to.deep.equal([]);
  });

  it("确认按钮收集勾选结果，弹窗本身不触发下载", async function () {
    let importCalls = 0;
    class FakeDialog {
      constructor() {
        this.buttons = {};
        this.window = {
          document: {
            getElementById: (id) => ({ checked: id === "zmta-batch-field-0-0" }),
          },
        };
      }
      addButton(label, id, options) { (this.buttons ||= {})[id] = { label, ...options }; return this; }
      addCell(_row, _col, layout) { this.layout = layout; return this; }
      setDialogData(data) { this.dialogData = data; return this; }
      open() { this.buttons["zmta-batch-confirm"].callback(); }
    }
    const originalImport = Zotero.Attachments.importFromURL;
    Zotero.Attachments.importFromURL = () => { importCalls += 1; };
    try {
      const result = await api.showBatchConfirmDialog(previews(), { Dialog: FakeDialog }, copy);
      expect(result).to.have.length(1);
      expect(result[0].fields.map((field) => field.field)).to.deep.equal(["publisher"]);
      expect(result[0].attachments).to.deep.equal([]);
      expect(result[0].notes).to.deep.equal([]);
      expect(importCalls).to.equal(0);
    } finally {
      Zotero.Attachments.importFromURL = originalImport;
    }
  });

  it("DialogHelper 内容单元启用 flex，避免按固有宽度收缩", async function () {
    let cellFlex;
    class FakeDialog {
      constructor() { this.buttons = {}; this.window = { document: {} }; }
      addButton(label, id, options) { (this.buttons ||= {})[id] = { label, ...options }; return this; }
      addCell(_row, _column, layout, flex) { cellFlex = flex; this.layout = layout; return this; }
      setDialogData(data) { this.dialogData = data; return this; }
      open() { this.buttons["zmta-batch-cancel"].callback(); }
    }
    await api.showBatchConfirmDialog(previews(), { Dialog: FakeDialog }, copy);
    expect(cellFlex).to.equal(true);
  });

  it("Dialog 加载后设置窗口作用域并按实际 DOM 初始化底栏", async function () {
    const classes = new Set();
    const confirm = { disabled: false };
    const summary = {};
    let loaded = false;
    class FakeDialog {
      constructor() {
        this.window = { document: {
          documentElement: { classList: { add: (name) => classes.add(name) } },
          getElementById: (id) => id === "zmta-batch-confirm" ? confirm : id === "zmta-batch-selection-summary" ? summary : null,
        } };
      }
      addButton(label, id, options) { (this.buttons ||= {})[id] = { label, ...options }; return this; }
      addCell(_row, _column, layout) { this.layout = layout; }
      setDialogData(data) { this.dialogData = data; }
      open() {
        this.dialogData.loadCallback();
        loaded = true;
        this.buttons["zmta-batch-cancel"].callback();
      }
    }
    expect(await api.showBatchConfirmDialog(previews(), { Dialog: FakeDialog }, copy)).to.equal(null);
    expect(loaded).to.equal(true);
    expect(classes.has("zmta-review-window")).to.equal(true);
    expect(confirm.disabled).to.equal(true);
    expect(summary.textContent).to.equal("已勾选 0 个条目 · 0 项更新");
  });

  it("取消按钮返回 null", async function () {
    class FakeDialog {
      constructor() { this.buttons = {}; this.window = { document: {} }; }
      addButton(label, id, options) { (this.buttons ||= {})[id] = { label, ...options }; return this; }
      addCell(_row, _column, layout) { this.layout = layout; return this; }
      setDialogData(data) { this.dialogData = data; return this; }
      open() { this.buttons["zmta-batch-cancel"].callback(); }
    }
    expect(await api.showBatchConfirmDialog(previews(), { Dialog: FakeDialog }, copy)).to.equal(null);
  });

  it("零选择不会确认，窗口关闭只结算一次取消", async function () {
    let closeCalls = 0;
    let confirmAttempted = false;
    class FakeDialog {
      constructor() { this.window = { document: { getElementById: () => ({ checked: false }) }, close() { closeCalls += 1; } }; }
      addButton(label, id, options) { (this.buttons ||= {})[id] = { label, ...options }; return this; }
      addCell(_row, _column, layout) { this.layout = layout; }
      setDialogData(data) { this.dialogData = data; }
      open() {
        this.buttons["zmta-batch-confirm"].callback();
        confirmAttempted = true;
        this.dialogData.beforeUnloadCallback();
        this.buttons["zmta-batch-cancel"].callback();
      }
    }
    expect(await api.showBatchConfirmDialog(previews(), { Dialog: FakeDialog }, copy)).to.equal(null);
    expect(confirmAttempted).to.equal(true);
    expect(closeCalls).to.equal(0);
  });

  it("在隔离 Zotero 宿主实际显示身份确认并可安全取消", async function () {
    this.timeout(10000);
    require("./hostProfile.cjs").assertDedicatedTestProfile(Zotero, Services, Ci);

    const data = previews();
    data[0].identityReview = {
      required: true,
      matchedFields: ["title", "creator"],
      summary: "系统已匹配：标题、作者；缺少强标识",
    };
    data[0].fields.push({ field: "abstractNote", local: "本地长摘要。".repeat(40), incoming: "上游长摘要。".repeat(40), defaultChecked: false });
    let helper;
    let pending;
    try {
      pending = api.showBatchConfirmDialog(
        data,
        Zotero.zmtaAddon.data.ztoolkit,
        copy,
        { onOpen: (dialog) => { helper = dialog; } },
      );
      expect(helper).to.be.an("object");
      await helper.dialogData.loadLock.promise;
      await Zotero.Promise.delay(0);

      const doc = helper.window.document;
      const root = doc.getElementById("zmta-batch-review");
      const checkbox = doc.getElementById("zmta-batch-identity-0");
      const confirm = doc.getElementById("zmta-batch-confirm");
      const footer = root.querySelector(".zmta-footer");
      expect(root).not.to.equal(null);
      expect(root.textContent).to.include("确认找到的是同一篇文献或同一本书");
      expect(root.textContent).to.include("已核对标题、作者");
      expect(root.querySelector(".zmta-technical-details")).to.equal(null);
      expect(root.querySelectorAll(".zmta-section")).to.have.length(3);
      expect(root.textContent).not.to.include("Creator");
      expect(root.textContent).not.to.include("Notes");
      expect(doc.documentElement.classList.contains("zmta-review-window")).to.equal(true);
      expect(root.querySelectorAll("thead th")).to.have.length(4);
      expect(footer.contains(confirm)).to.equal(false);
      expect(doc.body.contains(confirm)).to.equal(true);
      expect(root.getBoundingClientRect().height).to.be.greaterThan(200);
      expect(root.querySelector(".zmta-detail-pane").getBoundingClientRect().height).to.be.greaterThan(100);
      expect(footer.getBoundingClientRect().bottom).to.be.at.most(helper.window.innerHeight + 1);
      expect(confirm.disabled).to.equal(true);
      const longInput = doc.getElementById("zmta-batch-field-0-2");
      const longRow = doc.getElementById("zmta-batch-field-0-2-row");
      const longDetails = longRow.querySelector("details");
      longDetails.querySelector("summary").click();
      expect(longDetails.open).to.equal(true);
      expect(longInput.checked).to.equal(false);
      expect(helper.window.getComputedStyle(longRow.querySelector(".zmta-old-value")).textDecorationLine).not.to.include("line-through");
      expect(checkbox.checked).to.equal(false);
      checkbox.click();
      expect(checkbox.checked).to.equal(true);
      expect(confirm.disabled).to.equal(false);
      expect(doc.getElementById("zmta-batch-selection-summary").textContent).to.equal("已勾选 1 个条目 · 1 项更新");

      doc.getElementById("zmta-batch-cancel").click();
      expect(await pending).to.equal(null);
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
