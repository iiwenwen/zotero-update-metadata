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
    expect(sections).to.have.length(3);
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
    expect(sections(defaults).map(n => n.properties.open)).to.deep.equal([true, true, false]);
    const restored = dialogLayout([p], { selectionDefaults: { attachments: true, notes: true }, initialSelections: [{
      itemID: p.itemID, itemKey: p.itemKey, candidateDigest: p.candidateDigest, fields: [], creators: undefined, attachments: [], notes: p.notes,
    }] });
    expect(sections(restored).map(n => n.properties.open)).to.deep.equal([false, false, true]);
    const unselected = dialogLayout([{ ...p, creators: { ...p.creators, defaultChecked: false } }]);
    expect(sections(unselected).map(n => n.properties.open)).to.deep.equal([false, false, false]);
  });
});
