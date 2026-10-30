const { expect } = require("chai");

describe("workflowActivity（公共入口占用）", function () {
  let api, originalAlert;
  let alerts;
  const previous = {
    batchId: "old", total: 1, applied: 0, partial: 0, skipped: 0, failed: 1,
    items: [{ itemID: 1, itemKey: "A", status: "failed", operations: [] }],
  };
  const selection = { itemID: 1, itemKey: "A", fields: [], attachments: [], notes: [] };
  const item = { id: 1, key: "A", libraryID: 1, itemType: "book", isRegularItem: () => true, getField: () => "" };

  function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
  }

  class Dialog {
    constructor() {
      this.buttons = {};
      this.window = { document: { getElementById: () => null }, close: () => this.dialogData.beforeUnloadCallback() };
    }
    addCell(_r, _c, layout) { this.layout = layout; return this; }
    addButton(_label, id, options) { this.buttons[id] = options; return this; }
    setDialogData(data) { this.dialogData = data; return this; }
    open() {}
  }

  before(function () {
    api = Zotero.zmtaAddon?.uiTestApi;
    if (!api) this.skip();
  });
  beforeEach(function () {
    expect(api.getWorkflowActivity()).to.equal("idle");
    alerts = [];
    originalAlert = Zotero.alert;
    Zotero.alert = (_win, _title, message) => alerts.push(message);
    api.resetBatchRuntimeForTests({ storage: new api.MemoryBatchJournalStorage() });
  });
  afterEach(function () {
    Zotero.alert = originalAlert;
    api.resetBatchRuntimeForTests();
    expect(api.getWorkflowActivity()).to.equal("idle");
  });

  it("同步取得、同步通知、坏监听隔离、退订和重复释放均不破坏占用", function () {
    const seen = [];
    const stopBad = api.subscribeWorkflowActivity(() => { throw new Error("坏监听"); });
    const stop = api.subscribeWorkflowActivity((state) => seen.push(state));
    let release;
    try {
      release = api.tryAcquireWorkflowActivity("reviewing");
      expect(api.getWorkflowActivity()).to.equal("reviewing");
      expect(seen).to.deep.equal(["reviewing"]);
      expect(api.tryAcquireWorkflowActivity("rolling-back")).to.equal(null);
      release();
      expect(seen).to.deep.equal(["reviewing", "idle"]);
      stop();
      const releaseNext = api.tryAcquireWorkflowActivity("retrying");
      release();
      expect(api.getWorkflowActivity()).to.equal("retrying");
      releaseNext();
      expect(seen).to.deep.equal(["reviewing", "idle"]);
    } finally { release?.(); stop(); stopBad(); }
  });

  async function expectAllBusy() {
    class ForbiddenDialog { constructor() { throw new Error("重复入口不得创建窗口"); } }
    expect(await api.runBatchWorkflow([], { Dialog: ForbiddenDialog })).to.equal(null);
    expect(await api.runDOIBatchWorkflow([], { Dialog: ForbiddenDialog })).to.equal(null);
    expect(await api.retryLastFailedBatch()).to.equal(null);
    expect(await api.rollbackLatestBatch()).to.equal(null);
    expect(alerts.slice(-4).every((message) => message.includes("还没结束"))).to.equal(true);
  }

  it("英文环境四个占用入口拒绝并说明原因，不创建窗口或写日志", async function () {
    const originalLocale = Zotero.locale;
    Zotero.locale = "en-US";
    const release = api.tryAcquireWorkflowActivity("reviewing");
    class ForbiddenDialog { constructor() { throw new Error("不得创建窗口"); } }
    try {
      expect(await api.runBatchWorkflow([], { Dialog: ForbiddenDialog })).to.equal(null);
      expect(await api.runDOIBatchWorkflow([], { Dialog: ForbiddenDialog })).to.equal(null);
      expect(await api.retryLastFailedBatch()).to.equal(null);
      expect(await api.rollbackLatestBatch()).to.equal(null);
      expect(alerts).to.have.lengthOf(4);
      expect(alerts.every((message) => message.includes("still running") && !/[\u4e00-\u9fff]/.test(message))).to.equal(true);
    } finally { release(); Zotero.locale = originalLocale; }
  });

  for (const route of ["runBatchWorkflow", "runDOIBatchWorkflow"]) {
    it(`${route} 在首次 await 前取得占用，阻止菜单／侧栏／DOI／重试／撤销交错`, async function () {
      const storage = new api.MemoryBatchJournalStorage();
      api.resetBatchRuntimeForTests({ storage });
      const pending = api[route]([], { Dialog });
      expect(api.getWorkflowActivity()).to.equal("reviewing");
      // 不 await busy 调用：持有方为空输入，会在下一 microtask 完成。
      const attempts = [
        api.runBatchWorkflow([], { Dialog }), api.runDOIBatchWorkflow([], { Dialog }),
        api.retryLastFailedBatch(), api.rollbackLatestBatch(),
      ];
      expect(alerts.filter((message) => message.includes("还没结束"))).to.have.length(4);
      expect(await Promise.all(attempts)).to.deep.equal([null, null, null, null]);
      expect(await pending).to.equal(null);
      expect(await storage.read()).to.equal(null);
    });
  }

  it("占用覆盖候选审核直到取消，查看批次仍只读可用，取消零 journal 写入", async function () {
    const opened = deferred();
    class HoldingDialog extends Dialog {
      open() { if (this.layout.id === "zmta-batch-review") opened.resolve(this); }
    }
    const storage = new api.MemoryBatchJournalStorage();
    api.resetBatchRuntimeForTests({ storage });
    const pending = api.runBatchWorkflow([item], { Dialog: HoldingDialog });
    const dialog = await opened.promise;
    try {
      expect(api.getWorkflowActivity()).to.equal("reviewing");
      await expectAllBusy();
      expect(await api.inspectBatchStatus()).to.equal(null);
      expect(alerts.at(-1)).to.include("还没有更新记录");
      expect(api.getWorkflowActivity()).to.equal("reviewing");
    } finally { dialog.dialogData.beforeUnloadCallback(); await pending; }
    expect(await storage.read()).to.equal(null);
  });

  it("重试在读条目前占用，持有到 runner 和日志结束，偏好不会扩大旧选择", async function () {
    const gate = deferred();
    const running = deferred();
    const storage = new api.MemoryBatchJournalStorage();
    let requests = 0;
    api.resetBatchRuntimeForTests({
      storage, retryState: { selections: [selection], result: previous },
      retryGetItem: async () => item,
      retryRunner: async (selections, result, dependencies) => {
        requests += 1;
        expect(selections).to.deep.equal([selection]);
        expect(result).to.equal(previous);
        await dependencies.onResolvedSelections(selections);
        running.resolve();
        await gate.promise;
        return { ...previous, batchId: dependencies.batchId };
      },
    });
    const originalPref = Zotero.Prefs.get;
    Zotero.Prefs.get = () => true;
    const pending = api.retryLastFailedBatch();
    try {
      expect(api.getWorkflowActivity()).to.equal("retrying");
      await running.promise;
      await expectAllBusy();
      expect(requests).to.equal(1);
      expect(selection.attachments).to.deep.equal([]);
      expect(selection.notes).to.deep.equal([]);
    } finally { gate.resolve(); await pending; Zotero.Prefs.get = originalPref; }
    expect(JSON.parse(await storage.read())[0].status).to.equal("failed");
  });

  it("撤销占用跨异步 journal 与能力刷新，失败后释放且不自动重放", async function () {
    const gate = deferred();
    const refreshGate = deferred();
    const refreshing = deferred();
    let calls = 0;
    api.resetBatchRuntimeForTests({ confirmUndo: async () => true, journal: {
      getLatestUndoableBatch: async () => ({ batchId: "old", items: [] }),
      rollbackLatest: async () => { calls += 1; await gate.promise; throw new Error("回退失败"); },
      getInspectableBatches: async () => { refreshing.resolve(); await refreshGate.promise; return []; },
    } });
    const pending = api.rollbackLatestBatch();
    try {
      expect(api.getWorkflowActivity()).to.equal("rolling-back");
      await expectAllBusy();
      gate.resolve();
      await refreshing.promise;
      expect(api.getWorkflowActivity()).to.equal("rolling-back");
      await expectAllBusy();
      expect(calls).to.equal(1);
    } finally { gate.resolve(); refreshGate.resolve(); await pending; }
  });

  it("空输入、进度窗异常、普通／DOI取消和审核窗失败均释放且不写日志", async function () {
    class ThrowingDialog { constructor() { throw new Error("窗口失败"); } }
    class CancellingDialog extends Dialog { open() { this.buttons["zmta-preflight-cancel"].callback(); } }
    class BrokenReviewDialog extends Dialog {
      addCell(r, c, layout) {
        if (layout.id === "zmta-batch-review") throw new Error("审核布局失败");
        return super.addCell(r, c, layout);
      }
    }
    const storage = new api.MemoryBatchJournalStorage();
    api.resetBatchRuntimeForTests({ storage });
    for (const route of ["runBatchWorkflow", "runDOIBatchWorkflow"]) {
      for (const ToolkitDialog of [ThrowingDialog, CancellingDialog, BrokenReviewDialog]) {
        expect(await api[route]([item], { Dialog: ToolkitDialog })).to.equal(null);
        expect(api.getWorkflowActivity()).to.equal("idle");
        expect(await storage.read()).to.equal(null);
      }
    }
  });

  it("来源不返回时反复取消仍释放入口，旧响应不能解锁新任务或打开审核", async function () {
    const originalHTTP = Zotero.HTTP;
    const gates = [deferred(), deferred(), deferred()];
    const started = [deferred(), deferred(), deferred()];
    const dialogs = [];
    const storage = new api.MemoryBatchJournalStorage();
    api.resetBatchRuntimeForTests({ storage });
    class RememberDialog extends Dialog { constructor() { super(); dialogs.push(this); } }
    let calls = 0;
    Zotero.HTTP = { ...originalHTTP, processDocuments: () => {
      const index = calls++; started[index].resolve(); return gates[index].promise;
    } };
    const sourceItem = { ...item, getField: field => field === "url" ? "https://book.douban.com/subject/1/" : "" };
    const waitForCancel = pending => Promise.race([pending,
      new Promise((_, reject) => setTimeout(() => reject(new Error("取消后入口仍被占用")), 100))]);
    let pending;
    try {
      for (let index = 0; index < 3; index++) {
        pending = api.runBatchWorkflow([sourceItem], { Dialog: RememberDialog });
        await started[index].promise;
        expect(api.getWorkflowActivity()).to.equal("reviewing");
        if (index) {
          gates[index - 1].resolve([]);
          await new Promise(resolve => setTimeout(resolve, 0));
          expect(api.getWorkflowActivity()).to.equal("reviewing");
        }
        const dialog = dialogs.at(-1);
        if (index === 2) dialog.window.close();
        else dialog.buttons["zmta-preflight-cancel"].callback();
        expect(await waitForCancel(pending)).to.equal(null);
        expect(api.getWorkflowActivity()).to.equal("idle");
        expect(await storage.read()).to.equal(null);
      }
      gates[2].resolve([]); await new Promise(resolve => setTimeout(resolve, 0));
      expect(dialogs).to.have.lengthOf(3);
      expect(dialogs.every(dialog => dialog.layout.id === "zmta-batch-preflight")).to.equal(true);
      expect(api.getWorkflowActivity()).to.equal("idle");
    } finally {
      for (const gate of gates) gate.resolve([]);
      await pending;
      Zotero.HTTP = originalHTTP;
    }
  });

  it("无重试状态、坏日志及重试失败／取消的所有出口释放，取消不写日志", async function () {
    expect(await api.retryLastFailedBatch()).to.equal(null);
    expect(api.getWorkflowActivity()).to.equal("idle");
    api.resetBatchRuntimeForTests({ storage: { read: async () => "{坏日志", write: async () => { throw new Error("不能写"); } } });
    await api.refreshBatchRuntimeCapabilities();
    expect(await api.retryLastFailedBatch()).to.equal(null);
    expect(api.getWorkflowActivity()).to.equal("idle");
    for (const error of [new Error("预检失败"), new api.BatchPreflightCancelledError(0, 1)]) {
      const storage = new api.MemoryBatchJournalStorage();
      api.resetBatchRuntimeForTests({
        storage, retryState: { selections: [selection], result: previous },
        retryGetItem: async () => item, retryRunner: async () => { throw error; },
      });
      expect(await api.retryLastFailedBatch()).to.equal(null);
      expect(api.getWorkflowActivity()).to.equal("idle");
      expect(await storage.read()).to.equal(null);
    }
  });
});
