const { assert, expect } = require("chai");

describe("batchRuntime（核心与持久日志接线）", function () {
  let api;

  before(function () {
    api = Zotero.zmtaAddon.api;
    assert.isFunction(api.createJournalCallback);
    assert.isFunction(api.finalJournalStatus);
  });

  it("把字段与新增子条目的 planned/applied 事件写成可撤销日志", async function () {
    const storage = new api.MemoryBatchJournalStorage();
    const journal = new api.BatchJournal(storage, () => "2026-08-29T12:00:00.000Z");
    const item = { itemID: 1, itemKey: "BOOK0001", libraryID: 1, title: "测试书" };
    await journal.startBatch("batch-runtime", [item]);
    const sourceEvidence = {
      providerId: "zotero-search",
      sourceURL: "https://doi.org/10.1000/example",
      identifiers: [{ type: "doi", value: "10.1000/example" }],
      fetchedAt: "2026-08-29T12:00:00.000Z",
      routeId: "doi.search",
      sourceId: "Crossref",
    };
    const record = api.createJournalCallback(journal, new Map([[item.itemKey, sourceEvidence]]));

    await record({
      batchId: "batch-runtime", itemID: 1, itemKey: item.itemKey,
      kind: "field", identity: "publisher", status: "planned", before: "旧", after: "新",
    });
    await record({
      batchId: "batch-runtime", itemID: 1, itemKey: item.itemKey,
      kind: "field", identity: "publisher", status: "applied", before: "旧", after: "规范化后的新值",
    });
    await record({
      batchId: "batch-runtime", itemID: 1, itemKey: item.itemKey,
      kind: "note", identity: "note:0:deadbeef", status: "planned",
    });
    await record({
      batchId: "batch-runtime", itemID: 1, itemKey: item.itemKey,
      kind: "note", identity: "note:0:deadbeef", status: "applied", createdItemKey: "NOTE0001",
    });

    const completed = await journal.finalizeBatch("batch-runtime", "completed");
    expect(completed.items[0].fields[0]).to.include({
      field: "publisher", before: "旧", after: "规范化后的新值", status: "applied",
    });
    expect(completed.items[0].createdItems[0]).to.include({
      kind: "note", itemKey: "NOTE0001", status: "applied",
    });
    expect(completed.items[0].sourceEvidence).to.deep.equal(sourceEvidence);
    expect(await journal.getLatestUndoableBatch()).to.not.equal(null);
  });

  it("把 Creator 整组事件写成单一可回滚日志操作", async function () {
    const storage = new api.MemoryBatchJournalStorage();
    const journal = new api.BatchJournal(storage, () => "2026-09-02T12:00:00.000Z");
    const item = { itemID: 1, itemKey: "BOOK-CREATORS", libraryID: 1, title: "测试书" };
    await journal.startBatch("batch-creators", [item]);
    const record = api.createJournalCallback(journal);
    const before = [{ firstName: "旧", lastName: "作者", creatorType: "author" }];
    const after = [
      { name: "新机构", creatorType: "author" },
      { firstName: "新", lastName: "译者", creatorType: "translator" },
    ];

    await record({
      batchId: "batch-creators", itemID: 1, itemKey: item.itemKey,
      kind: "creators", identity: "creators", status: "planned", before, after,
    });
    await record({
      batchId: "batch-creators", itemID: 1, itemKey: item.itemKey,
      kind: "creators", identity: "creators", status: "applied", after,
    });

    const completed = await journal.finalizeBatch("batch-creators", "completed");
    expect(completed.items[0].creators).to.deep.equal({ before, after, status: "applied" });
  });

  it("将全失败、部分失败和全成功映射到正确日志终态", function () {
    const base = { batchId: "b", total: 2, applied: 0, partial: 0, skipped: 0, failed: 0, items: [] };
    expect(api.finalJournalStatus({ ...base, failed: 2 })).to.equal("failed");
    expect(api.finalJournalStatus({ ...base, applied: 1, failed: 1 })).to.equal("partial");
    expect(api.finalJournalStatus({ ...base, applied: 1, partial: 1 })).to.equal("partial");
    expect(api.finalJournalStatus({ ...base, applied: 2 })).to.equal("completed");
  });

  it("只读加载 journal 能力，并把未完成批次提示限制为一次", async function () {
    const storage = new api.MemoryBatchJournalStorage(JSON.stringify([{
      batchId: "running-1",
      createdAt: "2026-08-30T00:00:00.000Z",
      status: "running",
      items: [],
    }]));
    const alerts = [];
    const originalAlert = Zotero.alert;
    Zotero.alert = (_win, _title, message) => alerts.push(message);
    try {
      api.resetBatchRuntimeForTests({ storage });
      const first = await api.initializeBatchRuntimeState();
      const second = await api.initializeBatchRuntimeState();
      expect(first).to.include({
        loaded: true,
        incompleteCount: 1,
        hasUndoableBatch: false,
        hasInspectableBatches: true,
      });
      expect(second.incompleteCount).to.equal(1);
      expect(alerts).to.have.lengthOf(1);
      expect(alerts[0]).to.include("1 次未完成的更新");
      expect(alerts[0]).to.include("查看更新记录");
    } finally {
      Zotero.alert = originalAlert;
      api.resetBatchRuntimeForTests();
    }
  });

  it("英文环境空批次提示使用工具菜单语言，且不写日志", async function () {
    const originalLocale = Zotero.locale; const originalAlert = Zotero.alert;
    const alerts = [];
    Zotero.locale = "en-US"; Zotero.alert = (_win, title, message) => alerts.push({ title, message });
    const storage = new api.MemoryBatchJournalStorage();
    api.resetBatchRuntimeForTests({ storage });
    try {
      await api.inspectBatchStatus();
      expect(alerts[0].title).to.equal("Metadata Update");
      expect(alerts[0].message).to.include("no update history");
    } finally { Zotero.locale = originalLocale; Zotero.alert = originalAlert; api.resetBatchRuntimeForTests(); }
  });

  it("英文重试和撤销提示可读，读取失败不把内部异常直接展示给用户", async function () {
    const originalLocale = Zotero.locale;
    const originalAlert = Zotero.alert;
    const alerts = [];
    Zotero.locale = "en-US";
    Zotero.alert = (_win, title, message) => alerts.push({ title, message });
    try {
      const storage = new api.MemoryBatchJournalStorage();
      api.resetBatchRuntimeForTests({ storage });
      await api.retryLastFailedBatch();
      await api.rollbackLatestBatch();
      expect(alerts[0].message).to.include("Nothing has failed since Zotero started");
      expect(alerts[1].message).to.include("no recent update");
      expect(await storage.read()).to.equal(null);

      api.resetBatchRuntimeForTests({ storage: {
        read: async () => { throw new Error("PRIVATE_PATH/internal-error"); },
        write: async () => { throw new Error("不应写入"); },
      } });
      await api.rollbackLatestBatch();
      expect(alerts[2].message).to.include("The undo did not finish");
      expect(alerts[2].message).to.not.include("PRIVATE_PATH");
      await api.retryLastFailedBatch();
      expect(alerts[3].message).to.include("Retry is disabled");
      expect(alerts.every(({ title, message }) => title === "Metadata Update" && !/[\u4e00-\u9fff]/.test(message))).to.equal(true);
    } finally {
      Zotero.locale = originalLocale; Zotero.alert = originalAlert; api.resetBatchRuntimeForTests();
    }
  });

  it("journal 损坏时能力查询 fail closed，不伪装成空记录", async function () {
    const selection = { itemID: 1, itemKey: "A", fields: [], attachments: [], notes: [] };
    const result = {
      batchId: "retryable-but-broken",
      total: 1, applied: 0, partial: 0, skipped: 0, failed: 1,
      items: [{ itemID: 1, itemKey: "A", title: "A", status: "failed", operations: [] }],
    };
    api.resetBatchRuntimeForTests({
      storage: {
        read: async () => "{broken",
        write: async () => {},
      },
      retryState: { selections: [selection], result },
    });
    const capabilities = await api.refreshBatchRuntimeCapabilities();
    expect(capabilities.loaded).to.equal(true);
    expect(capabilities.hasUndoableBatch).to.equal(false);
    expect(capabilities.hasRetryableItems).to.equal(false);
    expect(capabilities.hasInspectableBatches).to.equal(false);
    expect(capabilities.journalError).to.be.a("string").and.not.equal("");
    api.resetBatchRuntimeForTests();
  });

  it("查看更新记录只读打开 journal 快照，不触发 storage write", async function () {
    class CountingStorage extends api.MemoryBatchJournalStorage {
      constructor(value) { super(value); this.writes = 0; }
      async write(value) { this.writes += 1; await super.write(value); }
    }
    const storage = new CountingStorage(JSON.stringify([{
      batchId: "inspect-runtime",
      createdAt: "2026-08-30T00:00:00.000Z",
      status: "running",
      items: [],
    }]));
    class AutoClosingDialog {
      constructor() { this.buttons = {}; this.window = { document: {} }; }
      addCell() { return this; }
      addButton(_label, id, options) { this.buttons[id] = options; return this; }
      setDialogData(data) { this.dialogData = data; return this; }
      open() { this.buttons["zmta-batch-status-close"].callback(); }
    }
    api.resetBatchRuntimeForTests({ storage });
    try {
      await api.refreshBatchRuntimeCapabilities();
      const batches = await api.inspectBatchStatus(undefined, { Dialog: AutoClosingDialog });
      expect(batches.map((entry) => entry.batchId)).to.deep.equal(["inspect-runtime"]);
      expect(storage.writes).to.equal(0);
    } finally {
      api.resetBatchRuntimeForTests();
    }
  });

  it("待恢复快照的能力刷新与查看窗口异常路径都不触发重刷", async function () {
    class FailAfterPlanningStorage extends api.MemoryBatchJournalStorage {
      constructor() { super(); this.writes = 0; }
      async write(value) {
        this.writes += 1;
        if (this.writes >= 3) throw new Error("磁盘持续失败");
        await super.write(value);
      }
    }
    class ThrowingDialog {
      constructor() { throw new Error("窗口构造失败"); }
    }
    const storage = new FailAfterPlanningStorage();
    const journal = new api.BatchJournal(storage, () => "2026-08-30T01:00:00.000Z");
    const item = { itemID: 1, itemKey: "BOOK0001", libraryID: 1, title: "测试图书" };
    await journal.startBatch("pending-runtime", [item]);
    await journal.planField("pending-runtime", item.itemKey, { field: "title", before: "旧", after: "新" });
    try { await journal.resolveField("pending-runtime", item.itemKey, "title", "applied"); } catch { /* 预期失败 */ }
    expect(storage.writes).to.equal(3);

    const originalAlert = Zotero.alert;
    Zotero.alert = () => {};
    api.resetBatchRuntimeForTests({ journal });
    try {
      const capabilities = await api.refreshBatchRuntimeCapabilities();
      expect(capabilities).to.include({ incompleteCount: 1, hasInspectableBatches: true });
      expect(storage.writes).to.equal(3);
      expect(await api.inspectBatchStatus(undefined, { Dialog: ThrowingDialog })).to.equal(null);
      expect(storage.writes).to.equal(3);
    } finally {
      Zotero.alert = originalAlert;
      api.resetBatchRuntimeForTests();
    }
  });

  it("重试关闭取消入口后才创建 journal，边界后的取消请求不会留下 running", async function () {
    let dialogInstance;
    class BoundaryDialog {
      constructor() {
        if (!dialogInstance) dialogInstance = this;
        this.buttons = {};
        this.window = {
          document: { getElementById: () => ({}) },
          close: () => this.dialogData?.beforeUnloadCallback?.(),
        };
      }
      addCell(_r, _c, layout) { this.layout = layout; return this; }
      addButton(_label, id, options) { this.buttons[id] = options; return this; }
      setDialogData(data) { this.dialogData = data; return this; }
      open() {
        if (this.layout?.id === "zmta-workflow-result") {
          const find = node => node.id === "zmta-result-done" ? node : (node.children || []).map(find).find(Boolean);
          find(this.layout).listeners[0].listener();
        }
      }
    }
    const storage = new api.MemoryBatchJournalStorage();
    const selection = { itemID: 1, itemKey: "A", fields: [], attachments: [], notes: [] };
    const previous = {
      batchId: "previous-boundary",
      total: 1, applied: 0, partial: 0, skipped: 0, failed: 1,
      items: [{ itemID: 1, itemKey: "A", title: "A", status: "failed", operations: [] }],
    };
    api.resetBatchRuntimeForTests({
      storage,
      retryState: { selections: [selection], result: previous },
      retryGetItem: async () => ({ id: 1, key: "A", libraryID: 1, getField: () => "A" }),
      retryRunner: async (_selections, _result, dependencies) => {
        await dependencies.onResolvedSelections([selection]);
        dialogInstance.buttons["zmta-preflight-cancel"].callback();
        expect(dependencies.signal.aborted).to.equal(false);
        return {
          batchId: dependencies.batchId,
          total: 1, applied: 0, partial: 0, skipped: 1, failed: 0,
          items: [{ itemID: 1, itemKey: "A", title: "A", status: "skipped", operations: [] }],
        };
      },
    });
    const originalAlert = Zotero.alert;
    Zotero.alert = () => {};
    try {
      const result = await api.retryLastFailedBatch(undefined, { Dialog: BoundaryDialog });
      expect(result.batchId).to.be.a("string");
      const persisted = JSON.parse(await storage.read());
      expect(persisted[0].status).to.equal("completed");
    } finally {
      Zotero.alert = originalAlert;
      api.resetBatchRuntimeForTests();
    }
  });

  it("当前会话只有 failed/partial 项时才开放重试能力", async function () {
    const selection = { itemID: 1, itemKey: "A", fields: [], attachments: [], notes: [] };
    const result = {
      batchId: "retryable",
      total: 1,
      applied: 0,
      partial: 0,
      skipped: 0,
      failed: 1,
      items: [{ itemID: 1, itemKey: "A", title: "A", status: "failed", operations: [] }],
    };
    api.resetBatchRuntimeForTests({
      storage: new api.MemoryBatchJournalStorage(),
      retryState: { selections: [selection], result },
    });
    const capabilities = await api.refreshBatchRuntimeCapabilities();
    expect(capabilities.hasRetryableItems).to.equal(true);
    api.resetBatchRuntimeForTests();
  });

  it("普通预检在进度窗请求取消后正常返回且不报警、不写 journal", async function () {
    const alerts = [];
    const originalAlert = Zotero.alert;
    Zotero.alert = (_win, _title, message) => alerts.push(message);
    class CancellingDialog {
      constructor() {
        this.buttons = {};
        this.window = {
          document: { getElementById: () => ({}) },
          close: () => this.dialogData.beforeUnloadCallback(),
        };
      }
      addCell() { return this; }
      addButton(_label, id, options) { this.buttons[id] = options; return this; }
      setDialogData(data) { this.dialogData = data; return this; }
      open() { this.buttons["zmta-preflight-cancel"].callback(); }
    }
    const storage = new api.MemoryBatchJournalStorage();
    api.resetBatchRuntimeForTests({ storage });
    const item = {
      id: 99,
      key: "CANCEL99",
      libraryID: 1,
      itemType: "book",
      isRegularItem: () => true,
      getField: (field) => field === "title" ? "待取消" : "",
    };
    try {
      expect(await api.runBatchWorkflow([item], { Dialog: CancellingDialog })).to.equal(null);
      expect(alerts).to.deep.equal([]);
      expect(await storage.read()).to.equal(null);
    } finally {
      Zotero.alert = originalAlert;
      api.resetBatchRuntimeForTests();
    }
  });

  it("失败重试取消不创建空 journal，也不显示失败警报", async function () {
    const alerts = [];
    const originalAlert = Zotero.alert;
    Zotero.alert = (_win, _title, message) => alerts.push(message);
    class CancellingDialog {
      constructor() {
        this.buttons = {};
        this.window = {
          document: { getElementById: () => ({}) },
          close: () => this.dialogData.beforeUnloadCallback(),
        };
      }
      addCell() { return this; }
      addButton(_label, id, options) { this.buttons[id] = options; return this; }
      setDialogData(data) { this.dialogData = data; return this; }
      open() { this.buttons["zmta-preflight-cancel"].callback(); }
    }
    const storage = new api.MemoryBatchJournalStorage();
    const selection = { itemID: 1, itemKey: "A", fields: [], attachments: [], notes: [] };
    const previous = {
      batchId: "previous",
      total: 1,
      applied: 0,
      partial: 0,
      skipped: 0,
      failed: 1,
      items: [{ itemID: 1, itemKey: "A", title: "A", status: "failed", operations: [] }],
    };
    api.resetBatchRuntimeForTests({
      storage,
      retryState: { selections: [selection], result: previous },
      retryGetItem: async () => ({ id: 1, key: "A", libraryID: 1, getField: () => "" }),
      retryRunner: async (_selections, _result, dependencies) => {
        expect(dependencies.signal.aborted).to.equal(true);
        throw new api.BatchPreflightCancelledError(0, 1);
      },
    });
    try {
      expect(await api.retryLastFailedBatch(undefined, { Dialog: CancellingDialog })).to.equal(null);
      expect(alerts).to.deep.equal([]);
      expect(await storage.read()).to.equal(null);
    } finally {
      Zotero.alert = originalAlert;
      api.resetBatchRuntimeForTests();
    }
  });

  it("候选在实际 applied 前失败时不把 SourceEvidence 写进 journal", async function () {
    const storage = new api.MemoryBatchJournalStorage();
    const journal = new api.BatchJournal(storage, () => "2026-08-30T00:00:00.000Z");
    const item = { itemID: 8, itemKey: "ITEM8", libraryID: 1, title: "失败条目" };
    await journal.startBatch("failed-before-write", [item]);
    const sourceEvidence = {
      providerId: "zotero-search",
      sourceURL: "https://doi.org/10.1000/example",
      identifiers: [{ type: "doi", value: "10.1000/example" }],
      fetchedAt: "2026-08-30T00:00:00.000Z",
      routeId: "doi.search",
      sourceId: "Crossref",
    };
    const record = api.createJournalCallback(journal, new Map([[item.itemKey, sourceEvidence]]));
    await record({
      batchId: "failed-before-write", itemID: item.itemID, itemKey: item.itemKey,
      kind: "field", identity: "title", status: "planned", before: "旧", after: "新",
    });
    await record({
      batchId: "failed-before-write", itemID: item.itemID, itemKey: item.itemKey,
      kind: "field", identity: "title", status: "failed", before: "旧", after: "新",
    });
    const completed = await journal.finalizeBatch("failed-before-write", "failed");
    expect(completed.items[0]).not.to.have.property("sourceEvidence");
  });

  it("日志文件明确不存在时返回空，其他读取错误 fail closed", async function () {
    const alerts = [];
    const originalAlert = Zotero.alert;
    Zotero.alert = (_win, _title, message) => alerts.push(message);
    try {
      api.resetBatchRuntimeForTests({
        fileHost: {
          dataDirectory: "/virtual",
          join: (...parts) => parts.join("/"),
          exists: async () => false,
          read: async () => { throw new Error("不应读取不存在文件"); },
          ensureDirectory: async () => {},
          write: async () => {},
        },
      });
      expect(await api.rollbackLatestBatch()).to.equal(null);
      expect(alerts.pop()).to.include("没有可以撤销");

      api.resetBatchRuntimeForTests({
        fileHost: {
          dataDirectory: "/virtual",
          join: (...parts) => parts.join("/"),
          exists: async () => true,
          read: async () => { throw new Error("磁盘读取失败"); },
          ensureDirectory: async () => {},
          write: async () => {},
        },
      });
      expect(await api.rollbackLatestBatch()).to.equal(null);
      const readAlert = alerts.pop();
      expect(readAlert).to.include("撤销没完成");
      expect(readAlert).to.not.include("磁盘读取失败");

      api.resetBatchRuntimeForTests({
        fileHost: {
          dataDirectory: "/virtual",
          join: (...parts) => parts.join("/"),
          exists: async () => true,
          read: async () => new Uint8Array([0xff]),
          ensureDirectory: async () => {},
          write: async () => {},
        },
      });
      expect(await api.rollbackLatestBatch()).to.equal(null);
      const decodeAlert = alerts.pop();
      expect(decodeAlert).to.include("撤销没完成");
      expect(decodeAlert).to.not.include("没有可撤销");
    } finally {
      Zotero.alert = originalAlert;
      api.resetBatchRuntimeForTests();
    }
  });

  it("失败重试不在 runtime 重复预检，且用当前条目生成正确日志 metadata", async function () {
    const storage = new api.MemoryBatchJournalStorage();
    const selection = {
      itemID: 7,
      itemKey: "BOOK0007",
      fields: [{ field: "title", local: "旧", incoming: "新", isConflict: true, defaultChecked: false }],
      attachments: [],
      notes: [],
    };
    const previous = {
      batchId: "previous",
      total: 1,
      applied: 0,
      partial: 0,
      skipped: 0,
      failed: 1,
      items: [{ itemID: 7, itemKey: "BOOK0007", title: "旧", status: "failed", operations: [] }],
    };
    let translatorRequests = 0;
    api.resetBatchRuntimeForTests({
      storage,
      retryState: { selections: [selection], result: previous },
      retryGetItem: async () => ({
        id: 7,
        key: "BOOK0007",
        libraryID: 9,
        getField: (field) => field === "title" ? "当前标题" : "https://book.douban.com/subject/1/",
      }),
      retryRunner: async (_selections, _result, dependencies) => {
        translatorRequests += 1;
        return {
          batchId: dependencies.batchId,
          total: 1,
          applied: 0,
          partial: 0,
          skipped: 0,
          failed: 1,
          items: [{ itemID: 7, itemKey: "BOOK0007", title: "当前标题", status: "failed", operations: [] }],
        };
      },
    });

    const originalAlert = Zotero.alert;
    Zotero.alert = () => {};
    try {
      await api.retryLastFailedBatch();
    } finally {
      Zotero.alert = originalAlert;
    }

    expect(translatorRequests).to.equal(1);
    const records = JSON.parse(await storage.read());
    expect(records[0].items[0]).to.include({ itemKey: "BOOK0007", libraryID: 9, title: "当前标题" });
    api.resetBatchRuntimeForTests();
  });
});
