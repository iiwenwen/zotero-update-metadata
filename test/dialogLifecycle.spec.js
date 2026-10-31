const { expect } = require("chai");
const { Dialog } = require("./uiDialog.cjs");
const { loadDialogCopy } = require("./helpers/copy.cjs");

describe("本插件Dialog卸载生命周期（离线机制）", function () {
  let api;
  const preview = () => ({ itemID: 1, itemKey: "A", title: "审核样本", status: "ready",
    fields: [{ field: "title", local: "", incoming: "候选" }], attachments: [], notes: [] });
  const batch = () => ({ batchId: "b", createdAt: "今天", items: [] });
  const result = () => ({ batchId: "b", applied: 0, partial: 0, skipped: 0, failed: 0, items: [] });
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));
  let copy;
  before(function () { api = Zotero.zmtaAddon.uiTestApi; if (!api) this.skip(); ({ copy } = loadDialogCopy()); });
  beforeEach(function () { api.shutdownPluginDialogs(); api.beginPluginDialogScope(); Dialog.instances = []; });
  afterEach(async function () { api.shutdownPluginDialogs(); await flush(); api.beginPluginDialogScope(); api.resetBatchRuntimeForTests(); });

  it("shutdown结算审核null/撤销false/结果done/记录返回，预检abort各一次", async function () {
    const review = api.showBatchConfirmDialog([preview()], { Dialog }, copy);
    const undo = api.showUndoConfirmation(batch(), { Dialog }, copy);
    const output = api.showWorkflowResult(result(), { Dialog }, { copy, onRecords: async () => {} });
    const history = api.showBatchStatusDialog([], { Dialog }, copy);
    const preflight = api.openBatchPreflightDialog({ Dialog }, 1, copy);
    let aborts = 0; preflight.signal.addEventListener("abort", () => aborts++);
    api.shutdownPluginDialogs(); api.shutdownPluginDialogs();
    expect(await review).to.equal(null); expect(await undo).to.equal(false);
    expect(await output).to.equal("done"); await history;
    expect(preflight.signal.aborted).to.equal(true); expect(aborts).to.equal(1);
    for (const dialog of Dialog.instances) { expect(dialog.closed).to.equal(true); expect(dialog.closeCalls).to.equal(1); expect(dialog.mediaListeners.size).to.equal(0); }
    // 旧按钮引用/关闭回调不能重新授权或重复close。
    Dialog.instances[0].buttons["zmta-batch-confirm"].callback();
    Dialog.instances[1].buttons["zmta-undo-confirm"].callback();
    expect(Dialog.instances[0].closeCalls).to.equal(1);
  });

  it("onShutdown先结算UI，再调用Toolkit.unregisterAll", async function () {
    const pending = api.showBatchConfirmDialog([preview()], { Dialog }, copy); const dialog = Dialog.instances[0];
    const original = addon.data.ztoolkit;
    let calls = 0;
    addon.data.ztoolkit = { unregisterAll() { calls++; expect(dialog.closed).to.equal(true); } };
    try { api.hooks.onShutdown(); expect(await pending).to.equal(null); expect(calls).to.equal(1); }
    finally { addon.data.ztoolkit = original; }
  });

  it("open内shutdown、迟到load和未派发beforeunload都不留下有效确认", async function () {
    class Delayed extends Dialog {
      open() { const win = this.window; this.window = undefined; api.shutdownPluginDialogs(); this.window = win; return this; }
    }
    const pending = api.showBatchConfirmDialog([preview(), { ...preview(), itemID: 2, itemKey: "B" }], { Dialog: Delayed }, copy);
    const dialog = Dialog.instances[0]; expect(await pending).to.equal(null);
    dialog.data.loadCallback();
    expect(dialog.closed).to.equal(true); expect(dialog.closeCalls).to.equal(1); expect(dialog.mediaListeners.size).to.equal(0);
    expect(dialog.nodes.has("zmta-review-navigation-select")).to.equal(false);
  });

  it("已关窗但漏beforeunload仍结算；新scope不会复活旧scope", async function () {
    const old = api.getPluginDialogScope();
    const pending = api.showBatchConfirmDialog([preview()], { Dialog }, copy);
    Dialog.instances[0].window.closed = true; // 模拟宿主已销毁、未回调。
    api.shutdownPluginDialogs(); api.beginPluginDialogScope();
    expect(await pending).to.equal(null); expect(api.isPluginDialogScopeActive(old)).to.equal(false);
    expect(api.isPluginDialogScopeActive()).to.equal(true);
    expect(Dialog.instances[0].closeCalls).to.equal(0);
  });

  it("窗口被宿主直接销毁只派发unload时也结算，工作流占用随之释放", async function () {
    // 用可手动推进的队列代替真实主线程：窗口销毁后其 setTimeout 未必再触发，必须走主线程队列。
    const originalServices = globalThis.Services;
    const rechecks = [];
    globalThis.Services = { tm: { dispatchToMainThread(run) { rechecks.push(run); } } };
    try {
      const storage = new api.MemoryBatchJournalStorage(); api.resetBatchRuntimeForTests({ storage });
      const item = { id: 1, key: "A", libraryID: 1, itemType: "book", isRegularItem: () => true, getField: () => "" };
      const pending = api.runBatchWorkflow([item], { Dialog }, undefined);
      let settled = false; pending.then(() => { settled = true; });
      for (let i = 0; i < 20 && !Dialog.instances.some(d => d.layout?.id === "zmta-batch-review"); i++) await flush();
      const dialog = Dialog.instances.find(d => d.layout?.id === "zmta-batch-review");
      expect(api.getWorkflowActivity()).to.equal("reviewing");
      // Gecko 销毁顺序：先派发 unload，关闭标记之后才生效，且没有第二次事件。
      dialog.events.get("unload")?.({});
      expect(rechecks).to.have.length(1); // 只排一次复查
      dialog.events.get("unload")?.({}); // 重复派发不再排队
      expect(rechecks).to.have.length(1);
      await flush();
      expect(settled).to.equal(false); // 复查未推进前不得结算
      expect(api.getWorkflowActivity()).to.equal("reviewing");
      dialog.closed = true; dialog.window.closed = true;
      rechecks.shift()(); // 推进下一轮主线程复查
      await flush();
      expect(settled).to.equal(true);
      expect(await pending).to.equal(null);
      expect(api.getWorkflowActivity()).to.equal("idle");
      expect(dialog.closeCalls).to.equal(0); // 已消失的窗口不再重复 close
      expect(await storage.read()).to.equal(null);
      expect(rechecks).to.have.length(0); // 结算后不再排复查
    } finally {
      if (originalServices === undefined) delete globalThis.Services; else globalThis.Services = originalServices;
    }
  });

  it("复查链有界：窗口一直活着就停止排队，之后真正销毁的unload仍能重新开链并结算", async function () {
    const originalServices = globalThis.Services;
    const rechecks = [];
    globalThis.Services = { tm: { dispatchToMainThread(run) { rechecks.push(run); } } };
    try {
      const pending = api.showBatchConfirmDialog([preview()], { Dialog }, copy);
      let settled = false; pending.then(() => { settled = true; });
      const dialog = Dialog.instances[0];
      dialog.events.get("unload")?.({}); // 误判的一次 unload：窗口还活着
      let rounds = 0;
      while (rechecks.length && rounds++ < 20) { rechecks.shift()(); await flush(); }
      expect(rounds).to.be.lessThan(20); // 有界：不会无限排队
      expect(settled).to.equal(false); // 窗口活着就绝不结算
      expect(rechecks).to.have.length(0);
      dialog.closed = true; dialog.window.closed = true;
      dialog.events.get("unload")?.({}); // 真正的销毁事件：链条已归零，必须能重新响应
      while (rechecks.length && rounds++ < 40) { rechecks.shift()(); await flush(); }
      await flush();
      expect(settled).to.equal(true);
      expect(await pending).to.equal(null);
    } finally {
      if (originalServices === undefined) delete globalThis.Services; else globalThis.Services = originalServices;
    }
  });

  it("窗口包装器读取抛错按已消失处理，仍然结算而不是挂住", async function () {
    const pending = api.showBatchConfirmDialog([preview()], { Dialog }, copy);
    const dialog = Dialog.instances[0];
    const realWindow = dialog.window;
    Object.defineProperty(dialog, "window", { configurable: true, get() { throw new Error("dead wrapper"); } });
    dialog.events.get("unload")?.({});
    expect(await pending).to.equal(null);
    expect(dialog.closeCalls).to.equal(0);
    expect(realWindow.closed).to.equal(false); // 真实窗口没被关闭，只是读不到了
  });

  it("打开瞬间的unload不算窗口消失，审核仍能继续并正常确认", async function () {
    const pending = api.showBatchConfirmDialog([preview()], { Dialog }, copy);
    const dialog = Dialog.instances[0];
    dialog.events.get("unload")?.({}); // 初始化期 unload：窗口还活着
    await flush(); await flush();
    expect(dialog.closed).to.equal(false);
    expect(dialog.closeCalls).to.equal(0);
    dialog.click("zmta-batch-confirm");
    expect((await pending)?.length).to.equal(1);
    expect(dialog.closed).to.equal(true);
  });

  it("open抛错时结算，不留下占位条目挡住之后的聚焦恢复", async function () {
    class Boom extends Dialog { open() { throw new Error("open failed"); } }
    expect(await api.showBatchConfirmDialog([preview()], { Dialog: Boom }, copy)).to.equal(null);
    expect(() => api.openBatchPreflightDialog({ Dialog: Boom }, 1, copy)).to.throw("open failed");
    const target = { closed: false, focus() { this.focused = true; } };
    expect(api.restorePluginWindowFocus(target)).to.equal(true);
    expect(target.focused).to.equal(true);
  });

  it("open后拿不到窗口也结算，不留悬空确认", async function () {
    class NoWindow extends Dialog { open() { this.window = undefined; return this; } }
    const pending = api.showBatchConfirmDialog([preview()], { Dialog: NoWindow }, copy);
    expect(await pending).to.equal(null);
    const dialog = Dialog.instances[0];
    expect(dialog.closeCalls).to.equal(0);
    expect(api.getWorkflowActivity()).to.equal("idle");
  });

  it("停止后的旧scope不能新开确认/结果/记录或重新查找", async function () {
    api.shutdownPluginDialogs();
    expect(await api.showBatchConfirmDialog([preview()], { Dialog }, copy)).to.equal(null);
    expect(await api.showUndoConfirmation(batch(), { Dialog }, copy)).to.equal(false);
    expect(await api.showWorkflowResult(result(), { Dialog }, { copy, onRecords: async () => {} })).to.equal("done");
    await api.showBatchStatusDialog([], { Dialog }, copy);
    const handle = api.openBatchPreflightDialog({ Dialog }, 1, copy); expect(handle.signal.aborted).to.equal(true);
    expect(Dialog.instances.every(d => d.closed)).to.equal(true);
  });

  it("执行中shutdown不关闭/abort写入；进度可继续，正常完成才释放窗口", function () {
    const handle = api.openExecutionDialog({ Dialog }, 2, copy); const dialog = Dialog.instances[0];
    api.shutdownPluginDialogs();
    expect(dialog.closed).to.equal(false); expect(dialog.closeCalls).to.equal(0);
    handle.update({ completed: 1, total: 2 }); expect(dialog.nodes.get("zmta-execution-meter").value).to.equal(1);
    handle.close(); handle.close(); expect(dialog.closeCalls).to.equal(1);
  });

  it("首次升级仅清本插件唯一根+控件，保留宿主/其他插件/标题相同窗口及执行窗", async function () {
    const pending = api.showBatchConfirmDialog([preview()], { Dialog }, copy); const ours = Dialog.instances[0];
    delete ours.data.__zmtaDialogOwner; // 旧版无所有权标记，仍有本插件唯一根与控件。
    const unrelated = new Dialog(); unrelated.window.document.title = "确认元数据更新";
    const partial = new Dialog(); partial.nodes.set("zmta-batch-review", {});
    const foreign = new Dialog(); foreign.data = { __zmtaDialogOwner: { pluginID: "other-addon", rootID: "zmta-batch-review" } };
    foreign.window.arguments = [foreign.data];
    for (const id of ["zmta-batch-review", "zmta-batch-confirm", "zmta-batch-cancel"]) foreign.nodes.set(id, {});
    const execution = api.openExecutionDialog({ Dialog }, 1, copy); const executing = Dialog.instances.at(-1);
    expect(api.closeLegacyPluginDialogs([ours.window, unrelated.window, partial.window, foreign.window, executing.window])).to.equal(1);
    expect(await pending).to.equal(null);
    expect(unrelated.closed || partial.closed || foreign.closed || executing.closed).to.equal(false);
    execution.close();
  });

  it("新版本标记允许清理根尚未加载的自有窗口，取消单次且阻止迟到load", async function () {
    class PendingLoad extends Dialog { open() { return this; } }
    const pending = api.showBatchConfirmDialog([preview()], { Dialog: PendingLoad }, copy); const dialog = Dialog.instances[0];
    dialog.nodes.clear();
    expect(api.closeLegacyPluginDialogs([dialog.window])).to.equal(1);
    expect(await pending).to.equal(null);
    dialog.data.loadCallback(); expect(dialog.closeCalls).to.equal(1);
  });

  it("一个close失败不阻塞其余取消，旧确认仍先结算null", async function () {
    const first = api.showBatchConfirmDialog([preview()], { Dialog }, copy); const bad = Dialog.instances[0];
    bad.window.close = () => { throw new Error("失效窗口"); };
    const second = api.showUndoConfirmation(batch(), { Dialog }, copy);
    api.shutdownPluginDialogs(); expect(await first).to.equal(null); expect(await second).to.equal(false);
    expect(Dialog.instances[1].closeCalls).to.equal(1);
  });

  it("失效窗口的导航清理抛错，仍结算并关闭审核/记录", async function () {
    const review = api.showBatchConfirmDialog([preview(), { ...preview(), itemID: 2, itemKey: "B" }], { Dialog }, copy);
    const history = api.showBatchStatusDialog(["a", "b"].map(batchId => ({ batchId, createdAt: "今天", status: "completed", items: [] })), { Dialog }, copy);
    for (const dialog of Dialog.instances) dialog.media.removeEventListener = () => { throw new Error("dead window"); };
    api.shutdownPluginDialogs(); expect(await review).to.equal(null); await history;
    expect(Dialog.instances.every(d => d.closeCalls === 1)).to.equal(true);
  });

  it("审核占用在shutdown取消后按原finally释放，取消不写journal", async function () {
    const storage = new api.MemoryBatchJournalStorage(); api.resetBatchRuntimeForTests({ storage });
    const item = { id: 1, key: "A", libraryID: 1, itemType: "book", isRegularItem: () => true, getField: () => "" };
    const pending = api.runBatchWorkflow([item], { Dialog });
    for (let i = 0; i < 20 && !Dialog.instances.some(d => d.layout?.id === "zmta-batch-review"); i++) await flush();
    expect(api.getWorkflowActivity()).to.equal("reviewing");
    api.shutdownPluginDialogs(); expect(await pending).to.equal(null);
    expect(api.getWorkflowActivity()).to.equal("idle"); expect(await storage.read()).to.equal(null);
  });

  it("撤销确认已resolve但await未续跑时shutdown，不能执行旧授权", async function () {
    let writes = 0;
    api.resetBatchRuntimeForTests({ journal: { getLatestUndoableBatch: async () => batch(), getInspectableBatches: async () => [], rollbackLatest: async () => { writes++; } } });
    const pending = api.rollbackLatestBatch(undefined, { Dialog });
    for (let i = 0; i < 20 && !Dialog.instances.some(d => d.layout?.id === "zmta-undo-scope"); i++) await flush();
    Dialog.instances.find(d => d.layout?.id === "zmta-undo-scope").click("zmta-undo-confirm");
    api.shutdownPluginDialogs(); api.beginPluginDialogScope();
    expect(await pending).to.equal(null); expect(writes).to.equal(0); expect(api.getWorkflowActivity()).to.equal("idle");
  });

  it("重试确认已resolve但旧scope被撤销时，不开始journal或执行", async function () {
    const p = preview(); const storage = new api.MemoryBatchJournalStorage(); let starts = 0;
    const previous = { ...result(), failed: 1, items: [{ itemID: 1, itemKey: "A", status: "failed", operations: [{ kind: "field", identity: "title", status: "failed" }] }] };
    api.resetBatchRuntimeForTests({ storage, retryState: { selections: [{ ...p, fields: p.fields }], result: previous },
      retryGetItem: async () => ({ id: 1, key: "A", libraryID: 1, getField: () => "样本" }),
      retryRunner: async (_selections, _result, dependencies) => {
        const picked = await dependencies.review([p]);
        if (!picked) throw new api.BatchPreflightCancelledError(0, 1);
        starts++; await dependencies.onResolvedSelections(picked); return previous;
      },
    });
    const pending = api.retryLastFailedBatch(undefined, { Dialog });
    for (let i = 0; i < 20 && !Dialog.instances.some(d => d.layout?.id === "zmta-batch-review"); i++) await flush();
    Dialog.instances.find(d => d.layout?.id === "zmta-batch-review").click("zmta-batch-confirm");
    api.shutdownPluginDialogs(); api.beginPluginDialogScope();
    expect(await pending).to.equal(null); expect(starts).to.equal(0);
    expect(await storage.read()).to.equal(null); expect(api.getWorkflowActivity()).to.equal("idle");
  });

  it("startup等待宿主就绪期间被shutdown，迟到续跑不能重新注册UI", async function () {
    let ready; const gate = new Promise(resolve => { ready = resolve; });
    const saved = [Zotero.initializationPromise, Zotero.unlockPromise, Zotero.uiReadyPromise, Zotero.PreferencePanes];
    let registered = 0;
    Zotero.initializationPromise = gate; Zotero.unlockPromise = Promise.resolve(); Zotero.uiReadyPromise = Promise.resolve();
    Zotero.PreferencePanes = { register: async () => { registered++; } };
    try {
      const starting = api.hooks.onStartup(); api.hooks.onShutdown(); api.beginPluginDialogScope();
      ready(); await starting; expect(registered).to.equal(0);
    } finally { [Zotero.initializationPromise, Zotero.unlockPromise, Zotero.uiReadyPromise, Zotero.PreferencePanes] = saved; }
  });

  it("正常审核取消后只恢复原发起窗，不在审核仍开时抢焦点", async function () {
    const storage = new api.MemoryBatchJournalStorage(); api.resetBatchRuntimeForTests({ storage });
    let focus = 0; const win = { closed: false, focus() { focus++; } };
    const item = { id: 1, key: "A", libraryID: 1, itemType: "book", isRegularItem: () => true, getField: () => "" };
    const pending = api.runBatchWorkflow([item], { Dialog }, win);
    for (let i = 0; i < 20 && !Dialog.instances.some(d => d.layout?.id === "zmta-batch-review"); i++) await flush();
    expect(focus).to.equal(0);
    const dialog = Dialog.instances.find(d => d.layout?.id === "zmta-batch-review");
    dialog.click("zmta-batch-cancel"); dialog.buttons["zmta-batch-cancel"].callback();
    expect(await pending).to.equal(null); expect(focus).to.equal(1); expect(await storage.read()).to.equal(null);
  });

  it("原窗已关闭/失效或headless无原窗时不聚焦未知窗口", async function () {
    const original = Zotero.getMainWindow;
    let focus = 0, lookups = 0;
    Zotero.getMainWindow = () => { lookups++; throw new Error("不可猜测发起窗"); };
    const item = { id: 1, key: "A", libraryID: 1, itemType: "book", isRegularItem: () => true, getField: () => "" };
    try {
      for (const win of [undefined, { closed: true, focus() { focus++; } }, { get closed() { throw new Error("dead window"); }, focus() { focus++; } }]) {
        api.resetBatchRuntimeForTests({ storage: new api.MemoryBatchJournalStorage() });
        class Cancel extends Dialog { open() { super.open(); if (this.layout.id === "zmta-batch-review") this.click("zmta-batch-cancel"); return this; } }
        expect(await api.runBatchWorkflow([item], { Dialog: Cancel }, win)).to.equal(null);
      }
      expect(focus).to.equal(0); expect(lookups).to.equal(0);
    } finally { Zotero.getMainWindow = original; }
  });

  it("重试执行与结果未关时不focus，最终完成后恢复原窗", async function () {
    const storage = new api.MemoryBatchJournalStorage(); let finish;
    const gate = new Promise(resolve => { finish = resolve; });
    let focus = 0; const win = { closed: false, focus() { focus++; } };
    const previous = { ...result(), failed: 1, items: [{ itemID: 1, itemKey: "A", status: "failed", operations: [] }] };
    api.resetBatchRuntimeForTests({ storage, retryState: { selections: [{ itemID: 1, itemKey: "A", fields: [], attachments: [], notes: [] }], result: previous },
      retryGetItem: async () => ({ id: 1, key: "A", libraryID: 1, getField: () => "样本" }),
      retryRunner: async (selections, _result, dependencies) => {
        await dependencies.onResolvedSelections(selections); await gate; return { ...previous, batchId: dependencies.batchId };
      },
    });
    const pending = api.retryLastFailedBatch(win, { Dialog });
    for (let i = 0; i < 20 && !Dialog.instances.some(d => d.layout?.id === "zmta-execution"); i++) await flush();
    expect(focus).to.equal(0); finish();
    for (let i = 0; i < 20 && !Dialog.instances.some(d => d.layout?.id === "zmta-workflow-result"); i++) await flush();
    expect(focus).to.equal(0); Dialog.instances.find(d => d.layout?.id === "zmta-workflow-result").click("zmta-result-done");
    await pending; expect(focus).to.equal(1);
  });

  it("撤销取消/结果完成后恢复原窗，执行与结果期间不抢焦点", async function () {
    let focus = 0, writes = 0;
    const win = { closed: false, focus() { focus++; } };
    api.resetBatchRuntimeForTests({ journal: { getLatestUndoableBatch: async () => batch(), getInspectableBatches: async () => [], rollbackLatest: async () => { writes++; } } });
    let pending = api.rollbackLatestBatch(win, { Dialog });
    for (let i = 0; i < 20 && !Dialog.instances.some(d => d.layout?.id === "zmta-undo-scope"); i++) await flush();
    expect(focus).to.equal(0); Dialog.instances.find(d => d.layout?.id === "zmta-undo-scope").click("zmta-undo-cancel");
    await pending; expect(focus).to.equal(1); expect(writes).to.equal(0);
    focus = 0; Dialog.instances = [];
    let finish; const gate = new Promise(resolve => { finish = resolve; });
    api.resetBatchRuntimeForTests({ confirmUndo: async () => true, journal: { getLatestUndoableBatch: async () => batch(), getInspectableBatches: async () => [],
      rollbackLatest: async () => { writes++; await gate; return { batchId: "b", rolledBack: 0, conflicts: 0, failed: 0, items: [] }; } } });
    pending = api.rollbackLatestBatch(win, { Dialog });
    for (let i = 0; i < 20 && !Dialog.instances.some(d => d.layout?.id === "zmta-execution"); i++) await flush();
    expect(focus).to.equal(0); finish();
    for (let i = 0; i < 20 && !Dialog.instances.some(d => d.layout?.id === "zmta-workflow-result"); i++) await flush();
    expect(focus).to.equal(0); const output = Dialog.instances.find(d => d.layout?.id === "zmta-workflow-result");
    output.click("zmta-result-done"); output.buttons["zmta-result-done"].callback();
    await pending; expect(focus).to.equal(1); expect(writes).to.equal(1);
  });

  it("结果内查看记录返回父结果并保留它，不回主窗抢焦点", async function () {
    api.resetBatchRuntimeForTests({ storage: new api.MemoryBatchJournalStorage() });
    let focus = 0; const main = { closed: false, focus() { focus++; } };
    const pending = api.showWorkflowResult(result(), { Dialog }, {
      copy, onRecords: returnWindow => api.inspectBatchStatus(main, { Dialog }, { returnWindow }),
    });
    const parent = Dialog.instances[0]; parent.click("zmta-result-records");
    for (let i = 0; i < 20 && !Dialog.instances.some(d => d.layout?.id === "zmta-batch-status"); i++) await flush();
    expect(focus).to.equal(0);
    Dialog.instances.find(d => d.layout?.id === "zmta-batch-status").click("zmta-batch-status-close");
    await flush(); expect(parent.focused).to.equal(true); expect(parent.closed).to.equal(false); expect(focus).to.equal(0);
    parent.click("zmta-result-done"); await pending;
  });

  it("父结果先关闭时等待子记录退出，再回已知主窗，不聚焦失效父窗", async function () {
    let focus = 0; const main = { closed: false, focus() { focus++; } };
    api.resetBatchRuntimeForTests({ confirmUndo: async () => true, journal: { getLatestUndoableBatch: async () => batch(), getInspectableBatches: async () => [],
      rollbackLatest: async () => ({ batchId: "b", rolledBack: 0, conflicts: 0, failed: 0, items: [] }) } });
    const pending = api.rollbackLatestBatch(main, { Dialog });
    for (let i = 0; i < 20 && !Dialog.instances.some(d => d.layout?.id === "zmta-workflow-result"); i++) await flush();
    const parent = Dialog.instances.find(d => d.layout?.id === "zmta-workflow-result"); parent.click("zmta-result-records");
    for (let i = 0; i < 20 && !Dialog.instances.some(d => d.layout?.id === "zmta-batch-status"); i++) await flush();
    parent.click("zmta-result-done"); await pending; expect(focus).to.equal(0);
    Dialog.instances.find(d => d.layout?.id === "zmta-batch-status").click("zmta-batch-status-close");
    await flush(); expect(focus).to.equal(1); expect(parent.focused).not.to.equal(true);
  });

  it("startup清理legacy为0不focus，确实关闭旧窗才恢复main", async function () {
    const originalServices = globalThis.Services;
    const saved = [Zotero.getMainWindow, Zotero.getMainWindows, Zotero.PreferencePanes, addon.data.rootURI, addon.data.initialized];
    let focus = 0; const main = { closed: false, focus() { focus++; } };
    Zotero.getMainWindow = () => main; Zotero.getMainWindows = () => [];
    Zotero.PreferencePanes = { register: async () => {} }; addon.data.rootURI = "test://zmta/";
    let windows = [];
    globalThis.Services = { wm: { getEnumerator() { let index = 0; return { hasMoreElements: () => index < windows.length, getNext: () => windows[index++] }; } } };
    try {
      api.resetBatchRuntimeForTests({ storage: new api.MemoryBatchJournalStorage() });
      await api.hooks.onStartup(); expect(focus).to.equal(0);
      const pending = api.showBatchConfirmDialog([preview()], { Dialog }, copy); const legacy = Dialog.instances.at(-1);
      delete legacy.data.__zmtaDialogOwner; windows = [legacy.window];
      await api.hooks.onStartup(); expect(await pending).to.equal(null); expect(focus).to.equal(1);
    } finally {
      [Zotero.getMainWindow, Zotero.getMainWindows, Zotero.PreferencePanes, addon.data.rootURI, addon.data.initialized] = saved;
      if (originalServices === undefined) delete globalThis.Services; else globalThis.Services = originalServices;
    }
  });
});
