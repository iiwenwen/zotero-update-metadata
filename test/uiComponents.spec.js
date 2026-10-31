const { expect } = require("chai");
const { Dialog, all } = require("./uiDialog.cjs");
const { loadDialogCopy, renderCopy } = require("./helpers/copy.cjs");

// 由scripts/test-ui.mjs的离线fixture提供导航导出；宿主套件不冒充离线DOM验证。
describe("组件适配的离线交互与生命周期", function () {
  let api;
  let copy;
  /** 生产布局 + 挂载后填充，等价于真实窗口显示出来的样子。 */
  const layoutOf = (built) => renderCopy(built, copy);
  const dialogLayout = (previews, options) => layoutOf(api.buildBatchDialogLayout(previews, copy, options));
  const resultLayout = (result, undo, retry) => layoutOf(api.buildWorkflowResultLayout(result, copy, undo, retry));
  const preview = () => ({ itemID: 1, itemKey: "A", title: "测试", status: "ready",
    fields: [{ field: "publisher", local: "", incoming: "上游出版社" }], attachments: [], notes: [] });
  before(function () { api = Zotero.zmtaAddon.uiTestApi; if (!api) this.skip(); ({ copy } = loadDialogCopy()); });
  beforeEach(function () { Dialog.instances = []; });

  it("Helper确认按钮拒绝零选，不自动关闭，身份确认后只结算一次", async function () {
    const p = preview(); p.identityReview = { required: true, matchedFields: ["title"] };
    const pending = api.showBatchConfirmDialog([p], { Dialog }, copy);
    const dialog = Dialog.instances[0];
    expect(dialog.buttons["zmta-batch-confirm"].noClose).to.equal(true);
    expect(dialog.nodes.get("zmta-batch-confirm").disabled).to.equal(true);
    dialog.buttons["zmta-batch-confirm"].callback(); // 即使强制触发也不能授权。
    expect(dialog.closed).to.equal(false);
    const identity = dialog.nodes.get("zmta-batch-identity-0"); identity.checked = true;
    all(dialog.layout).find(n => n.id === "zmta-batch-identity-0").listeners[0].listener({ currentTarget: identity });
    expect(dialog.nodes.get("zmta-batch-confirm").disabled).to.equal(false);
    const field = dialog.nodes.get("zmta-batch-field-0-0");
    const change = all(dialog.layout).find(n => n.id === "zmta-batch-field-0-0").listeners[0].listener;
    field.checked = false; change({ currentTarget: field });
    expect(dialog.nodes.get("zmta-batch-confirm").disabled).to.equal(true);
    dialog.buttons["zmta-batch-confirm"].callback(); expect(dialog.closeCalls).to.equal(0);
    field.checked = true; change({ currentTarget: field });
    dialog.click("zmta-batch-confirm"); dialog.buttons["zmta-batch-cancel"].callback();
    const selections = await pending;
    expect(selections).to.have.length(1); expect(selections[0].identityConfirmed).to.equal(true);
    expect(selections[0].fields).to.have.length(1);
    expect(dialog.closeCalls).to.equal(1);
  });

  it("导航使用稳定key、原生change和响应式size，卸载后不再接收事件", function () {
    const dialog = new Dialog();
    const container = dialog.element("nav", {}, { "aria-label": "本次审核条目" });
    dialog.nodes.set("navigation", container);
    const selected = [];
    const dispose = api.mountMetadataNavigation(dialog.window, "navigation", [
      { key: "item-A", label: "标题 A · 已选 0 项" }, { key: "item-B", label: "标题 B · 获取失败" },
    ], "item-B", key => selected.push(key));
    const select = dialog.nodes.get("navigation-select");
    expect(select.tag).to.equal("select"); expect(select.value).to.equal("item-B"); expect(select.size).to.equal(2);
    select.value = "item-A"; select.emit("change"); expect(selected).to.deep.equal(["item-A"]);
    select.value = "unknown"; select.emit("change"); expect(selected).to.have.length(1);
    dialog.media.matches = true; dialog.mediaListeners.forEach(fn => fn()); expect(select.size).to.equal(1);
    dispose(); dispose(); expect(dialog.mediaListeners.size).to.equal(0);
    select.value = "item-B"; select.emit("change"); expect(selected).to.have.length(1);
  });

  it("审核筛选按动态身份状态更新，空筛选清空详情且不改变任何勾选", async function () {
    const ready = preview();
    const identity = { ...preview(), itemID: 2, itemKey: "B", identityReview: { required: true, matchedFields: ["title"] } };
    const failed = { ...preview(), itemID: 3, itemKey: "C", status: "failed", fields: [] };
    const pending = api.showBatchConfirmDialog([ready, identity, failed], { Dialog }, copy);
    const dialog = Dialog.instances.at(-1);
    const filter = key => dialog.nodes.get(`zmta-review-navigation-filter-${key}`);
    const row = index => dialog.nodes.get(`zmta-review-navigation-row-${index}`);
    filter("identity").emit("click");
    expect(row(0).hidden).to.equal(true); expect(row(1).hidden).to.equal(false);
    expect(dialog.nodes.get("zmta-batch-detail-1").style.display).to.equal("block");
    const check = dialog.nodes.get("zmta-batch-identity-1"); check.checked = true;
    const identityInput = all(dialog.layout).find(node => node.id === "zmta-batch-identity-1");
    identityInput.listeners[0].listener({ currentTarget: check });
    expect(row(1).hidden).to.equal(true);
    expect(dialog.nodes.get("zmta-batch-filter-empty").hidden).to.equal(false);
    expect(dialog.nodes.get("zmta-batch-detail-1").style.display).to.equal("none");
    expect(dialog.nodes.get("zmta-batch-selection-summary").textContent).to.equal("已勾选 2 个条目 · 2 项更新");
    filter("all").emit("click");
    expect(dialog.nodes.get("zmta-batch-filter-empty").hidden).to.equal(true);
    expect(check.checked).to.equal(true); expect(row(1).getAttribute("data-state")).to.equal("ready");
    expect(dialog.nodes.get("zmta-batch-identity-card-1").getAttribute("data-confirmed")).to.equal("true");
    dialog.click("zmta-batch-cancel"); expect(await pending).to.equal(null);
    row(1).emit("click"); filter("blocked").emit("click");
    expect(row(0).hidden).to.equal(false); // 已卸载的事件不会再过滤。
  });

  it("快速取消身份确认后，迟到的 Fluent 计数不能覆盖待确认状态", async function () {
    const { values } = loadDialogCopy();
    const delayed = [];
    const asyncCopy = await api.createDialogCopy({ document: { l10n: {
      formatValues: async entries => entries.map(entry => values[entry.id.replace(/^zmta-/, "")]),
      formatValue: (id, args) => new Promise(resolve => delayed.push(() => resolve((values[id.replace(/^zmta-/, "")] || id).replace(/\{\s*\$(\w+)\s*\}/g, (_match, key) => String(args[key]))))),
    } } }, api.BATCH_REVIEW_COPY_IDS);
    const p = { ...preview(), identityReview: { required: true, matchedFields: ["title"] } };
    const pending = api.showBatchConfirmDialog([p, { ...preview(), itemID: 2, itemKey: "B" }], { Dialog }, asyncCopy);
    const dialog = Dialog.instances.at(-1), check = dialog.nodes.get("zmta-batch-identity-0");
    const change = all(dialog.layout).find(node => node.id === "zmta-batch-identity-0").listeners[0].listener;
    check.checked = true; change({ currentTarget: check });
    // 让 formatFrom(target) 的空结果走到主窗口格式化，然后在结果返回前撤销确认。
    await new Promise(resolve => setImmediate(resolve));
    check.checked = false; change({ currentTarget: check });
    delayed.forEach(resolve => resolve());
    await new Promise(resolve => setImmediate(resolve));
    expect(dialog.nodes.get("zmta-batch-item-meta-0").textContent).to.equal("待核对身份");
    dialog.click("zmta-batch-cancel"); await pending;
  });

  it("整行选择和键盘change同步状态，长文展开/标签/文字选区不重复翻转", async function () {
    const p = preview(); p.fields.push({ field: "title", local: "人工标题", incoming: "上游标题" });
    const pending = api.showBatchConfirmDialog([p], { Dialog }, copy);
    const dialog = Dialog.instances.at(-1);
    const row = all(dialog.layout).find(node => node.id === "zmta-batch-field-0-1-row");
    const check = dialog.nodes.get("zmta-batch-field-0-1");
    expect(row.children[0].classList).to.include("zmta-choice-cell");
    expect(all(row).find(node => node.id === "zmta-batch-field-0-1").classList || []).not.to.include("zmta-sr-only");
    const change = all(row).find(node => node.id === "zmta-batch-field-0-1").listeners[0].listener;
    const click = target => row.listeners[0].listener({ currentTarget: dialog.nodes.get(row.id), target, button: 0 });
    expect(check.checked).to.equal(false);
    click({ closest: () => null }); expect(check.checked).to.equal(true);
    expect(dialog.nodes.get(row.id).getAttribute("data-selected")).to.equal("true");
    expect(dialog.nodes.get("zmta-batch-summary-detail").textContent).to.equal("补全 1 · 替换 1 · 附件 0 · 笔记 0");
    for (const tag of ["label", "summary", "details", "input"]) click({ closest: () => ({ tag }) });
    expect(check.checked).to.equal(true);
    dialog.document.defaultView = { getSelection: () => ({ toString: () => "选中文本" }) };
    click({ closest: () => null }); expect(check.checked).to.equal(true);
    check.checked = false; change({ currentTarget: check });
    expect(dialog.nodes.get(row.id).getAttribute("data-selected")).to.equal("false");
    expect(dialog.nodes.get("zmta-batch-selection-summary").textContent).to.equal("已勾选 1 个条目 · 1 项更新");
    dialog.click("zmta-batch-cancel"); await pending;
  });

  it("替换片段高亮使用文本节点，补缺显示破折号且可见选择框有字段标签", function () {
    const p = preview(); p.fields.push({ field: "title", local: "旧😀<标签>", incoming: "新😀<标签>" });
    const layout = dialogLayout([p]);
    const incoming = all(layout).find(node => node.id === "zmta-batch-field-0-1-incoming");
    expect(incoming.children.map(node => node.properties.textContent).join("")).to.equal("新😀<标签>");
    expect(incoming.children[1]).to.include({ tag: "mark" });
    expect(incoming.children[1].properties.textContent).to.equal("新");
    expect(all(layout).find(node => node.id === "zmta-batch-field-0-0-local").properties.textContent).to.equal("—");
    const input = all(layout).find(node => node.id === "zmta-batch-field-0-0");
    expect(input.attributes["aria-label"]).to.equal("采用来源内容：出版社");
    expect(input.classList || []).not.to.include("zmta-sr-only");
  });

  it("补全所有空白跨条目只选补缺，不确认身份或选中人工覆盖和子项", async function () {
    const p = preview(); p.fields.push({ field: "title", local: "人工标题", incoming: "新标题" });
    p.attachments = [{ title: "附件" }]; p.notes = [{ content: "笔记" }];
    const other = { ...preview(), itemID: 2, itemKey: "B", identityReview: { required: true, matchedFields: ["title"] } };
    const pending = api.showBatchConfirmDialog([p, other], { Dialog }, copy);
    const dialog = Dialog.instances.at(-1);
    dialog.nodes.get("zmta-batch-field-0-0").checked = false;
    const fill = all(dialog.layout).find(node => node.id === "zmta-batch-fill-all");
    fill.listeners[0].listener({ currentTarget: dialog.nodes.get(fill.id) });
    for (const id of ["zmta-batch-field-0-1", "zmta-batch-identity-1", "zmta-batch-attachment-0-0", "zmta-batch-note-0-0"]) expect(dialog.nodes.get(id).checked).to.equal(false);
    expect(dialog.nodes.get("zmta-batch-field-0-0").checked).to.equal(true);
    expect(dialog.nodes.get("zmta-batch-selection-summary").textContent).to.equal("已勾选 1 个条目 · 1 项更新");
    dialog.click("zmta-batch-cancel"); expect(await pending).to.equal(null);
  });

  it("子项分区全选/清空只作用本分区且不切换展开状态", async function () {
    const p = preview(); p.attachments = [{ title: "一" }, { title: "二" }]; p.notes = [{ content: "笔记" }];
    const pending = api.showBatchConfirmDialog([p], { Dialog }, copy);
    const dialog = Dialog.instances.at(-1);
    const action = all(dialog.layout).find(node => node.id === "zmta-batch-attachment-action-0");
    let prevented = 0, stopped = 0;
    const click = () => action.listeners[0].listener({ currentTarget: dialog.nodes.get(action.id), preventDefault() { prevented++; }, stopPropagation() { stopped++; } });
    click();
    expect(dialog.nodes.get("zmta-batch-attachment-count-0").textContent).to.equal("已选 2 / 2 项");
    expect(dialog.nodes.get(action.id).textContent).to.equal("取消本条附件勾选");
    expect(dialog.nodes.get("zmta-batch-note-0-0").checked).to.equal(false);
    click();
    expect(dialog.nodes.get("zmta-batch-attachment-count-0").textContent).to.equal("已选 0 / 2 项");
    expect(prevented).to.equal(2); expect(stopped).to.equal(2);
    dialog.click("zmta-batch-cancel"); await pending;
  });

  it("记录初选使用batchId，关闭重开不累积监听或改变任务范围", async function () {
    const batches = ["new", "old"].map(batchId => ({ batchId, createdAt: "今天", status: "completed", items: [] }));
    for (let i = 0; i < 2; i++) {
      const pending = api.showBatchStatusDialog(batches, { Dialog }, copy, {}, { initialBatchId: "old" });
      const dialog = Dialog.instances.at(-1);
      expect(dialog.nodes.get("zmta-history-navigation-select").value).to.equal("old");
      expect(dialog.nodes.get("zmta-batch-status-detail-1").style.display).to.equal("block");
      dialog.window.close(); await pending;
      expect(dialog.mediaListeners.size).to.equal(0);
    }
    expect(batches.map(b => b.batchId)).to.deep.equal(["new", "old"]);
  });

  it("原生进度只接真实事件，预检取消仍在停止中，执行Esc不取消写入", function () {
    const preflight = api.openBatchPreflightDialog({ Dialog }, 3, copy);
    let dialog = Dialog.instances.at(-1);
    preflight.update({ stage: "item-complete", completed: 1, total: 3, title: "条目A" });
    expect(dialog.nodes.get("zmta-preflight-meter")).to.include({ max: 3, value: 1 });
    dialog.click("zmta-preflight-cancel");
    expect(preflight.signal.aborted).to.equal(true); expect(dialog.closed).to.equal(false);
    expect(dialog.nodes.get("zmta-preflight-cancel")).to.include({ disabled: true, textContent: "正在停止…" });
    preflight.close();
    const execution = api.openExecutionDialog({ Dialog }, 3, copy);
    dialog = Dialog.instances.at(-1);
    execution.update({ completed: 2, total: 3, stageId: "dlg-exec-stage-field" });
    expect(dialog.nodes.get("zmta-execution-meter")).to.include({ max: 3, value: 2 });
    let prevented = 0;
    dialog.events.get("keydown")({ type: "keydown", key: "Escape", preventDefault() { prevented++; } });
    expect(prevented).to.equal(1); expect(dialog.closed).to.equal(false);
    expect(Object.keys(dialog.buttons)).to.deep.equal([]);
    execution.close(); expect(dialog.events.size).to.equal(0);
  });

  it("原生折叠不注册勾选事件，结果与撤销继续显示逐项范围", function () {
    const p = preview(); p.creators = { local: [], incoming: [{ name: "作者", creatorType: "author" }], defaultChecked: true };
    p.attachments = [{ title: "附件" }]; p.notes = [{ content: "笔记" }];
    const layout = dialogLayout([p]);
    const sections = all(layout).filter(n => n.classList?.includes("zmta-section") && n.tag === "details");
    expect(sections).to.have.length(2);
    for (const section of sections) { expect(section.children[0].tag).to.equal("summary"); expect(section.listeners).to.equal(undefined); }
    const result = resultLayout({ applied: 1, partial: 0, failed: 0, skipped: 0,
      items: [{ title: "图书", status: "partial", operations: [{ kind: "field", identity: "title", status: "failed", message: "人工内容保留" }] }] });
    expect(all(result).some(n => n.tag === "details")).to.equal(true);
    expect(JSON.stringify(result)).to.include("人工内容保留");
    expect(all(result).filter(n => n.tag === "button")).to.have.length(0);
  });

  it("含默认或恢复选择的分区初始展开，明确未选的分区保持收起", function () {
    const p = preview(); p.candidateDigest = "digest";
    p.creators = { local: [], incoming: [{ name: "作者", creatorType: "author" }], defaultChecked: true };
    p.attachments = [{ title: "附件" }]; p.notes = [{ content: "笔记" }];
    const sections = layout => all(layout).filter(n => n.classList?.includes("zmta-section") && n.tag === "details");
    const defaults = dialogLayout([p], { selectionDefaults: { attachments: true, notes: false } });
    expect(sections(defaults).map(n => n.properties.open)).to.deep.equal([true, false]);
    const restored = dialogLayout([p], { selectionDefaults: { attachments: true, notes: true }, initialSelections: [{
      itemID: p.itemID, itemKey: p.itemKey, candidateDigest: p.candidateDigest, fields: [], creators: undefined, attachments: [], notes: p.notes,
    }] });
    expect(sections(restored).map(n => n.properties.open)).to.deep.equal([false, true]);
    const unselected = dialogLayout([{ ...p, creators: { ...p.creators, defaultChecked: false } }]);
    expect(sections(unselected).map(n => n.properties.open)).to.deep.equal([false, false]);
  });
});
