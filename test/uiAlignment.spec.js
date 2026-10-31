const { expect } = require("chai");
const { loadDialogCopy, renderCopy } = require("./helpers/copy.cjs");

describe("UI功能对齐（真实调用链的离线边界）", function () {
  let api;
  const find = (node, id) => node?.id === id ? node : (node?.children || []).map(child => find(child, id)).find(Boolean);
  const all = node => [node, ...(node?.children || []).flatMap(all)];
  const text = node => all(node).map(n => n.properties?.textContent || "").join("\n");
  const preview = () => ({ itemID: 1, itemKey: "A", libraryID: 1, title: "测试图书", status: "ready", sourceURL: "https://book.douban.com/subject/1/",
    fields: [{ field: "publisher", local: "", incoming: "新出版社", defaultChecked: true }], attachments: [], notes: [] });
  const { Dialog } = require("./uiDialog.cjs");
  let copy;
  const dialogLayout = (previews, options) => renderCopy(api.buildBatchDialogLayout(previews, copy, options), copy);
  const undoLayout = (batch) => renderCopy(api.buildUndoScope(batch, copy), copy);
  const statusLayout = (batches, options) => renderCopy(api.buildBatchStatusDialogLayout(batches, copy, options), copy);
  const resultLayout = (result, undo, retry) => renderCopy(api.buildWorkflowResultLayout(result, copy, undo, retry), copy);
  before(function () { api = Zotero.zmtaAddon.uiTestApi; if (!api) this.skip(); ({ copy } = loadDialogCopy()); });
  beforeEach(function () { Dialog.instances = []; });

  it("条目菜单只有条目操作，工具菜单提供记录、重试与撤销", function () {
    const context = api.buildBatchMenuEntries({})[0].menus;
    const tools = api.buildToolsMenuEntries({})[0].menus;
    expect(context.map(m => m.l10nID)).to.deep.equal(["zmta-review-update-menu-label", "zmta-use-doi-menu-label"]);
    expect(tools.map(m => m.l10nID)).to.deep.equal(["zmta-inspect-batches-menu-label", "zmta-retry-failed-menu-label", "zmta-undo-batch-menu-label"]);
  });
  it("恢复查找带出其他条目的真实未选状态，不因重开窗口重新预选", async function () {
    const ready = preview(); const failed = { ...preview(), itemID: 2, itemKey: "B", status: "failed", normalizedDOI: "10.1234/a", fields: [] };
    let request;
    const pending = api.showBatchConfirmDialog([ready, failed], { Dialog }, copy, { onRefresh: (...args) => { request = args; } });
    const dialog = Dialog.instances[0];
    dialog.nodes.get("zmta-batch-field-0-0").checked = false;
    const actions = all(dialog.layout).filter(n => n.properties?.textContent === "改用 DOI 查找");
    expect(actions).to.have.lengthOf(1);
    actions[0].listeners[0].listener();
    expect(await pending).to.equal(null);
    expect(request[0].itemKey).to.equal("B"); expect(request[1]).to.equal(true); expect(request[2][0].fields).to.deep.equal([]);
    const reopened = dialogLayout([ready], { initialSelections: request[2] });
    expect(find(reopened, "zmta-batch-field-0-0").properties.checked).to.equal(false);
    expect(api.summarizeBatchSelections(api.collectBatchSelections([ready], { getElementById: () => ({ checked: false }) })).items).to.equal(0);
  });
  it("恢复后的身份待确认条目不能因预设勾选而启用更新", function () {
    const p = preview(); p.identityReview = { required: true, matchedFields: ["title", "creator"] };
    const layout = dialogLayout([p], { initialSelections: [{ itemID: 1, itemKey: "A", fields: p.fields, attachments: [], notes: [], identityConfirmed: false }] });
    expect(api.collectBatchSelections([p], { getElementById: () => ({ checked: false }) })).to.deep.equal([]);
    expect(find(layout, "zmta-batch-identity-0").properties.checked).to.equal(false);
  });
  function failedPreview(outcome, routeId = "url.web", extra = {}) {
    return { ...preview(), status: "failed", fields: [], attempts: [{ routeId, attempt: 1,
      outcome, fetchedAt: "2026-10-31T00:00:00Z", inputIdentifiers: [], returnedIdentifiers: [],
      sourceId: "fixture", ...extra }] };
  }
  function recoveryButtons(p) {
    return all(api.buildBatchDialogLayout([p], copy, {}, { onRefresh() {} }).layout)
      .filter(n => n.tag === "button" && ["重新查找", "改用 DOI 查找"].includes(n.properties?.textContent));
  }
  it("来源不支持时不提供原样重查；DOI也不支持时不再提供换源", function () {
    const p = failedPreview("unsupported");
    expect(recoveryButtons(p)).to.have.lengthOf(0);
    p.normalizedDOI = "10.1234/a";
    expect(recoveryButtons(p).map(n => n.properties.textContent)).to.deep.equal(["改用 DOI 查找"]);
    p.attempts.push({ ...p.attempts[0], routeId: "doi.search" });
    expect(recoveryButtons(p)).to.have.lengthOf(0);
    expect(text(api.buildBatchDialogLayout([p], copy).layout)).to.include("不支持此来源");
  });
  it("每种路线结果都明确区分临时可重查与不可原样重放", function () {
    for (const outcome of api.ATTEMPT_OUTCOMES) {
      const p = failedPreview(outcome, "url.web", { retryable: true });
      const retryable = ["fetch-failed", "retry-exhausted"].includes(outcome);
      expect(api.canRefreshReview(p, false), outcome).to.equal(retryable);
      expect(recoveryButtons(p).some(n => n.properties.textContent === "重新查找"), outcome).to.equal(retryable);
    }
    for (const status of ["pending", "skipped", "ready", "applied", "partial", "rolled-back", "rollback-conflict", "blocked"]) {
      const p = { ...failedPreview("fetch-failed", "url.web", { retryable: true }), status, normalizedDOI: "10.1234/a" };
      expect(recoveryButtons(p), status).to.have.lengthOf(0);
    }
  });
  it("拒绝和限流不被新建预检按钮绕过；未知及确定性错误不当作临时网络故障", function () {
    for (const httpStatus of [401, 403, 429, 404, 500]) {
      const p = { ...failedPreview("fetch-failed", "url.web", { retryable: true,
        diagnostic: { stage: "document-fetch", httpStatus, retryAfterMs: 60000, message: "fixture" } }), normalizedDOI: "10.1234/a" };
      expect(recoveryButtons(p), String(httpStatus)).to.have.lengthOf(0);
    }
    expect(recoveryButtons(failedPreview("fetch-failed"))).to.have.lengthOf(0);
    for (const outcome of ["identifier-conflict", "identity-evidence-missing", "item-type-conflict", "version-ambiguous", "multiple-results", "invalid-response"]) {
      expect(recoveryButtons({ ...failedPreview(outcome), normalizedDOI: "10.1234/a" }), outcome).to.have.lengthOf(0);
    }
  });
  it("临时DOI失败只重试DOI，不重放已经不支持的网页路线", function () {
    const p = failedPreview("retry-exhausted", "doi.search", { retryable: true });
    p.normalizedDOI = "10.1234/a";
    p.attempts.unshift({ ...p.attempts[0], routeId: "url.web", outcome: "unsupported", retryable: false });
    const calls = [];
    const layout = api.buildBatchDialogLayout([p], copy, {}, { onRefresh: (...args) => calls.push(args) }).layout;
    const action = all(layout).find(n => n.properties?.textContent === "重新查找");
    expect(action).to.exist;
    action.listeners[0].listener();
    expect(calls).to.deep.equal([[0, true]]);
    p.attempts[p.attempts.length - 1].outcome = "unsupported";
    action.listeners[0].listener();
    expect(calls).to.have.lengthOf(1); // 旧事件不能绕过新状态
  });
  it("英文异常标题与恢复按钮使用相同的状态门控", function () {
    const { copy: english } = loadDialogCopy("en-US");
    const layout = api.buildBatchDialogLayout([failedPreview("unsupported")], english, {}, { onRefresh() {} }).layout;
    expect(text(layout)).to.include("Source not supported");
    expect(text(layout)).not.to.include("Search again");
  });
  it("英文环境在宿主字段标签缺失时仍显示英文后备名", function () {
    const originalLocale = Zotero.locale;
    const originalFields = Zotero.ItemFields;
    try {
      Zotero.locale = "en-US";
      Zotero.ItemFields = { getLocalizedString() { throw new Error("unavailable"); } };
      const { copy: english } = loadDialogCopy("en-US");
      const layout = api.buildBatchDialogLayout([preview()], english).layout;
      expect(all(layout).find(n => n.classList?.includes("zmta-field-name")).properties.textContent).to.equal("Publisher");
    } finally { Zotero.locale = originalLocale; Zotero.ItemFields = originalFields; }
  });
  it("重试只显示原失败且已选择的字段，变化值不预选", function () {
    const p = preview(); p.fields.push({ field: "title", local: "旧", incoming: "新", defaultChecked: false });
    const original = { itemID: 1, itemKey: "A", fields: [{ ...p.fields[0], incoming: "先前值" }], attachments: [], notes: [] };
    const prior = { status: "partial", operations: [{ kind: "field", identity: "publisher", status: "failed" }, { kind: "field", identity: "title", status: "applied" }] };
    const eligible = api.buildRetryReviewPreview(original, p, prior);
    expect(eligible.fields.map(f => f.field)).to.deep.equal(["publisher"]);
    expect(eligible.fields[0].defaultChecked).to.equal(false);
  });
  it("重试再次确认取消不产生开始写入事件", async function () {
    const item = { id: 1, key: "A", libraryID: 1, itemType: "book", isRegularItem: () => true, getField: f => ({ title: "测试图书", url: "https://book.douban.com/subject/1/", publisher: "" })[f] || "", getCreatorsJSON: () => [] };
    const selected = { itemID: 1, itemKey: "A", fields: preview().fields, attachments: [], notes: [] };
    const previous = { items: [{ itemID: 1, itemKey: "A", status: "failed", operations: [{ kind: "field", identity: "publisher", status: "failed" }] }] };
    let starts = 0, reviews = 0;
    const fields = Zotero.ItemFields, types = Zotero.ItemTypes;
    Zotero.ItemFields = { getID: field => field, isValidForType: () => true };
    Zotero.ItemTypes = { getID: () => 1 };
    let error;
    try { await api.retryFailedBatch([selected], previous, { getItem: async () => item,
      fetch: async url => ({ itemType: "book", title: "测试图书", url, publisher: "新出版社" }),
      review: async p => { reviews++; expect(p[0].status, p[0].message).to.equal("ready"); expect(p[0].fields).to.have.lengthOf(1); return null; }, onResolvedSelections: () => { starts++; } }); }
    catch (cause) { error = cause; }
    finally { Zotero.ItemFields = fields; Zotero.ItemTypes = types; }
    if (error && error.name !== "BatchPreflightCancelledError") throw error;
    expect(error?.name).to.equal("BatchPreflightCancelledError"); expect(reviews).to.equal(1); expect(starts).to.equal(0);
  });
  it("重试审核不能通过修改预览加入原范围以外的字段", async function () {
    const item = { id: 1, key: "A", libraryID: 1, itemType: "book", isRegularItem: () => true, getField: f => ({ title: "测试图书", url: "https://book.douban.com/subject/1/", publisher: "" })[f] || "", getCreatorsJSON: () => [] };
    const selected = { itemID: 1, itemKey: "A", fields: preview().fields, attachments: [], notes: [] };
    const previous = { items: [{ itemID: 1, itemKey: "A", status: "failed", operations: [] }] };
    let starts = 0, error;
    const fields = Zotero.ItemFields, types = Zotero.ItemTypes;
    Zotero.ItemFields = { getID: f => f, isValidForType: () => true }; Zotero.ItemTypes = { getID: () => 1 };
    try { await api.retryFailedBatch([selected], previous, { getItem: async () => item,
      fetch: async url => ({ itemType: "book", title: "测试图书", url, publisher: "新出版社" }),
      review: async p => { p[0].fields.push({ field: "title", local: "旧", incoming: "越界" }); return [{ ...p[0], identityConfirmed: true }]; },
      onResolvedSelections: () => { starts++; } }); } catch (cause) { error = cause; }
    finally { Zotero.ItemFields = fields; Zotero.ItemTypes = types; }
    expect(error?.message).to.include("范围"); expect(starts).to.equal(0);
  });
  it("撤销确认提示未知结果并隐藏已保存网址的敏感细节", function () {
    const scope = undoLayout({ createdAt: "今天", items: [{ title: "测试", fields: [
      { field: "url", status: "applied", before: "https://example.org/?token=private", after: "https://example.org/new" },
      { field: "title", status: "failed", recoveryRequired: true, afterUnknown: true },
    ], createdItems: [] }] });
    expect(text(scope)).to.include("结果待核对"); expect(text(scope)).to.include("更新前的网址"); expect(text(scope)).not.to.include("token=private");
  });
  it("原失败子内容变化后不展示为空白可执行审核", function () {
    const p = preview(); p.fields = []; p.notes = [{ batchOperationId: "note-new", note: "新内容" }];
    const old = { itemID: 1, itemKey: "A", fields: [], attachments: [], notes: [{ batchOperationId: "note-old", note: "旧内容" }] };
    const eligible = api.buildRetryReviewPreview(old, p, { status: "failed", operations: [] });
    expect(eligible.status).to.equal("skipped"); expect(eligible.message).to.include("原条目"); expect(eligible.notes).to.deep.equal([]);
  });
  it("运行时撤销取消不调用任何回退写入", async function () {
    let writes = 0;
    api.resetBatchRuntimeForTests({ journal: {
      getLatestUndoableBatch: async () => ({ batchId: "b", items: [] }),
      getInspectableBatches: async () => [], rollbackLatest: async () => { writes++; },
    }, confirmUndo: async () => false });
    try { expect(await api.rollbackLatestBatch({ alert() {} })).to.equal(null); expect(writes).to.equal(0); }
    finally { api.resetBatchRuntimeForTests(); }
  });
  it("撤销确认关闭/保留均为false，重复确认不能二次结算", async function () {
    const batch = { batchId: "b", createdAt: "今天", items: [] };
    const pending = api.showUndoConfirmation(batch, { Dialog }, copy); const dialog = Dialog.instances[0];
    dialog.buttons["zmta-undo-cancel"].callback(); dialog.buttons["zmta-undo-confirm"].callback();
    expect(await pending).to.equal(false);
    const next = api.showUndoConfirmation(batch, { Dialog }, copy); Dialog.instances[1].buttons["zmta-undo-confirm"].callback();
    expect(await next).to.equal(true);
  });
  it("撤销任务在确认后被替换时拒绝任何库操作", async function () {
    const storage = new api.MemoryBatchJournalStorage(); const journal = new api.BatchJournal(storage);
    await journal.startBatch("new", [{ itemID: 1, itemKey: "A", libraryID: 1, title: "测试" }]);
    await journal.planField("new", "A", { field: "title", before: "旧", after: "新" });
    await journal.resolveField("new", "A", "title", "applied"); await journal.finalizeBatch("new", "completed");
    let reads = 0, error;
    try { await journal.rollbackLatest({ getItem: () => { reads++; } }, { expectedBatchId: "old" }); } catch (cause) { error = cause; }
    expect(error.message).to.include("重新确认"); expect(reads).to.equal(0);
  });
  it("历史读取展示更早记录，但不改变最近撤销目标", async function () {
    const journal = new api.BatchJournal(new api.MemoryBatchJournalStorage());
    for (const id of ["first", "second"]) await journal.startBatch(id, []);
    await journal.finalizeBatch("second", "completed"); await journal.finalizeBatch("first", "completed");
    expect((await journal.getHistoryBatches()).map(b => b.batchId)).to.deep.equal(["first", "second"]);
    expect(await journal.getLatestUndoableBatch()).to.equal(null);
  });
  it("记录能定位指定任务，空/错误也保留读取和返回入口", async function () {
    const pending = api.showBatchStatusDialog([], { Dialog }, copy, { onReloadRequest() {} }, { error: "读取失败" });
    const dialog = Dialog.instances[0]; expect(text(dialog.layout)).to.include("读取失败");
    expect(Object.keys(dialog.buttons)).to.have.members(["zmta-batch-status-reload", "zmta-batch-status-close"]);
    dialog.buttons["zmta-batch-status-close"].callback(); await pending;
    const record = id => ({ batchId: id, createdAt: "今天", status: "completed", items: [], incomplete: false });
    const layout = statusLayout([record("new"), record("old")], { initialBatchId: "old" });
    expect(find(layout, "zmta-batch-status-detail-1").styles.display).to.equal("block");
  });
  it("结果查看记录时父窗口保留，完成后一次关闭", async function () {
    const result = { batchId: "b", applied: 1, partial: 0, skipped: 0, failed: 0, items: [] };
    let release; const records = new Promise(resolve => { release = resolve; }); let opens = 0;
    let settled = false;
    const pending = api.showWorkflowResult(result, { Dialog }, { copy, onRecords: async () => { opens++; await records; } });
    pending.then(() => { settled = true; });
    const dialog = Dialog.instances[0];
    dialog.click("zmta-result-records"); dialog.click("zmta-result-records");
    await Promise.resolve();
    expect(opens).to.equal(1); expect(dialog.closed).to.equal(false); expect(settled).to.equal(false);
    release(); await new Promise(resolve => setTimeout(resolve, 0)); expect(dialog.focused).to.equal(true);
    dialog.click("zmta-result-done"); expect(await pending).to.equal("done"); expect(dialog.closed).to.equal(true);
  });
  it("重试结果使用明确标题，普通更新与撤销保留各自标题", async function () {
    const result = { batchId: "retry", applied: 1, partial: 0, skipped: 0, failed: 0, items: [] };
    expect(text(resultLayout(result))).to.include("更新结果");
    expect(text(resultLayout(result, true))).to.include("撤销结果");
    expect(text(resultLayout(result, false, true))).to.include("重试结果");
    const pending = api.showWorkflowResult(result, { Dialog }, { copy, retry: true, onRecords: async () => {} });
    const dialog = Dialog.instances[0];
    expect(text(dialog.layout)).to.include("重试结果");
    dialog.click("zmta-result-done");
    expect(await pending).to.equal("done");
  });
  it("执行进度只观察已完成数量，没有取消写入入口", function () {
    const handle = api.openExecutionDialog({ Dialog }, 2, copy); const dialog = Dialog.instances[0];
    expect(Object.keys(dialog.buttons)).to.deep.equal([]);
    handle.update({ completed: 1, total: 2, title: "测试", stageId: "dlg-exec-stage-item-done" });
    expect(dialog.nodes.get("zmta-execution-count").textContent).to.include("1 / 2");
    handle.close(); expect(dialog.closed).to.equal(true);
  });
});
