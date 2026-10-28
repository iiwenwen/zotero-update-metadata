const { assert, expect } = require("chai");

describe("batchJournal（只读批次状态）", function () {
  let BatchJournal;
  let MemoryBatchJournalStorage;

  before(function () {
    const api = Zotero.zmtaAddon?.api;
    assert.isObject(api, "addon.api 应存在");
    BatchJournal = api.BatchJournal;
    MemoryBatchJournalStorage = api.MemoryBatchJournalStorage;
  });

  function record(overrides = {}) {
    return {
      batchId: "batch-default",
      createdAt: "2026-08-30T01:00:00.000Z",
      completedAt: "2026-08-30T01:01:00.000Z",
      status: "completed",
      items: [],
      ...overrides,
    };
  }

  function journal(records, Storage = MemoryBatchJournalStorage) {
    return new BatchJournal(new Storage(JSON.stringify(records)));
  }

  it("空 journal 返回冻结的空列表", async function () {
    const result = await new BatchJournal(new MemoryBatchJournalStorage()).getInspectableBatches();
    expect(result).to.deep.equal([]);
    assert.isTrue(Object.isFrozen(result));
  });

  it("返回全部 incomplete，并按 createdAt 新到旧稳定排序", async function () {
    const result = await journal([
      record({ batchId: "old-running", createdAt: "2026-08-30T01:00:00.000Z", completedAt: undefined, status: "running" }),
      record({ batchId: "new-broken", createdAt: "2026-08-30T03:00:00.000Z", completedAt: undefined, status: "partial" }),
      record({ batchId: "same-first", createdAt: "2026-08-30T02:00:00.000Z", completedAt: undefined, status: "running" }),
      record({ batchId: "same-second", createdAt: "2026-08-30T02:00:00.000Z", completedAt: undefined, status: "running" }),
    ]).getInspectableBatches();

    expect(result.map((entry) => entry.batchId)).to.deep.equal([
      "new-broken", "same-first", "same-second", "old-running",
    ]);
    expect(result.every((entry) => entry.incomplete)).to.equal(true);
  });

  it("只有终态时仅返回最近完成的批次", async function () {
    const result = await journal([
      record({ batchId: "newer-created", createdAt: "2026-08-30T03:00:00.000Z", completedAt: "2026-08-30T03:01:00.000Z" }),
      record({ batchId: "latest-terminal", createdAt: "2026-08-30T02:00:00.000Z", completedAt: "2026-08-30T04:00:00.000Z", status: "failed" }),
      record({ batchId: "old", createdAt: "2026-08-30T01:00:00.000Z", completedAt: "2026-08-30T01:01:00.000Z" }),
    ]).getInspectableBatches();

    expect(result.map((entry) => entry.batchId)).to.deep.equal(["latest-terminal"]);
    expect(result[0].incomplete).to.equal(false);
  });

  it("并存时返回全部 incomplete 加最近终态，并按 batchId 去重", async function () {
    const result = await journal([
      record({ batchId: "duplicate", createdAt: "2026-08-30T01:00:00.000Z", completedAt: undefined, status: "running" }),
      record({ batchId: "terminal-old", createdAt: "2026-08-30T02:00:00.000Z", completedAt: "2026-08-30T02:30:00.000Z" }),
      record({ batchId: "incomplete-new", createdAt: "2026-08-30T04:00:00.000Z", completedAt: undefined, status: "running" }),
      record({ batchId: "duplicate", createdAt: "2026-08-30T03:00:00.000Z", completedAt: undefined, status: "running" }),
      record({ batchId: "terminal-latest", createdAt: "2026-08-30T02:30:00.000Z", completedAt: "2026-08-30T05:00:00.000Z", status: "partial" }),
    ]).getInspectableBatches();

    expect(result.map((entry) => entry.batchId)).to.deep.equal([
      "incomplete-new", "duplicate", "terminal-latest",
    ]);
  });

  it("映射来源与四类操作，兼容旧可选字段且不暴露 sourceURL", async function () {
    const result = await journal([record({
      batchId: "details",
      items: [{
        itemID: 1,
        itemKey: "BOOK0001",
        libraryID: 1,
        title: "测试图书",
        sourceEvidence: {
          providerId: "zotero-search",
          routeId: "doi.search",
          sourceId: "Crossref",
          sourceURL: "https://example.test/private?token=secret",
          identifiers: [{ type: "doi", value: "10.1000/example" }],
          fetchedAt: "2026-08-30T00:00:00.000Z",
          translator: { label: "不应展示" },
        },
        fields: [
          { field: "title", before: "旧", after: "新", status: "failed", message: "字段失败" },
          {
            field: "url",
            before: "https://old.example.test/?token=old-secret",
            after: "https://new.example.test/?token=new-secret",
            status: "applied",
          },
        ],
        creators: {
          before: [{ creatorType: "author", firstName: "旧", lastName: "作者" }],
          after: [{ creatorType: "translator", name: "翻译组" }],
          status: "applied",
        },
        createdItems: [
          { kind: "attachment", itemKey: "ATT00001", operationId: "attachment:one", status: "applied" },
          { kind: "note", itemKey: "legacy-note-op", status: "rollback-conflict", message: "Note 冲突" },
        ],
      }, {
        itemID: 2,
        itemKey: "OLD00002",
        libraryID: 1,
        title: "旧记录",
        fields: [],
        createdItems: [],
      }],
    })]).getInspectableBatches();

    const [current, legacy] = result[0].items;
    expect(current.source).to.deep.equal({
      providerId: "zotero-search",
      routeId: "doi.search",
      sourceId: "Crossref",
      identifiers: [{ type: "doi", value: "10.1000/example" }],
    });
    expect(JSON.stringify(current.source)).not.to.include("sourceURL");
    expect(JSON.stringify(current.source)).not.to.include("secret");
    expect(current.operations).to.deep.equal([
      { operationId: "field:title", kind: "field", label: "title", before: "旧", after: "新", status: "failed", message: "字段失败" },
      { operationId: "field:url", kind: "field", label: "url", before: "（URL 值已隐藏）", after: "（URL 值已隐藏）", status: "applied" },
      { operationId: "creators:set", kind: "creators", label: "Creator 列表", before: [{ creatorType: "author", firstName: "旧", lastName: "作者" }], after: [{ creatorType: "translator", name: "翻译组" }], status: "applied" },
      { operationId: "attachment:one", kind: "attachment", label: "附件", status: "applied", createdItemKey: "ATT00001" },
      { operationId: "legacy-note-op", kind: "note", label: "Note", status: "rollback-conflict", message: "Note 冲突" },
    ]);
    expect(legacy).not.to.have.property("source");
    expect(JSON.stringify(result)).not.to.include("old-secret");
    expect(JSON.stringify(result)).not.to.include("new-secret");
  });

  it("隐藏 URL 型 sourceId 与 identifier 值", async function () {
    const result = await journal([record({
      items: [{
        itemID: 1,
        itemKey: "URL00001",
        libraryID: 1,
        title: "URL 来源",
        fields: [],
        createdItems: [],
        sourceEvidence: {
          providerId: "web-translator",
          sourceURL: "https://private.example.test/?token=source-secret",
          sourceId: "https://private.example.test/?token=id-secret",
          identifiers: [{ type: "url", value: "https://private.example.test/?token=identifier-secret" }],
          fetchedAt: "2026-08-30T00:00:00.000Z",
        },
      }],
    })]).getInspectableBatches();

    expect(result[0].items[0].source).to.deep.equal({
      providerId: "web-translator",
      sourceId: "（URL 值已隐藏）",
      identifiers: [{ type: "url", value: "（URL 值已隐藏）" }],
    });
    expect(JSON.stringify(result)).not.to.include("secret");
  });

  it("查询不写 storage，返回快照及嵌套展示值均不可篡改", async function () {
    class CountingStorage extends MemoryBatchJournalStorage {
      constructor(value) {
        super(value);
        this.writes = 0;
      }
      async write(value) {
        this.writes += 1;
        await super.write(value);
      }
    }
    const storage = new CountingStorage(JSON.stringify([record({
      items: [{
        itemID: 1,
        itemKey: "BOOK0001",
        libraryID: 1,
        title: "测试图书",
        fields: [{ field: "extra", before: { nested: ["旧"] }, after: { nested: ["新"] }, status: "planned" }],
        createdItems: [],
        sourceEvidence: {
          providerId: "test",
          sourceURL: "https://example.test",
          identifiers: [{ type: "url", value: "https://example.test" }],
          fetchedAt: "2026-08-30T00:00:00.000Z",
        },
      }],
    })]));
    const result = await new BatchJournal(storage).getInspectableBatches();

    expect(storage.writes).to.equal(0);
    assert.isTrue(Object.isFrozen(result));
    assert.isTrue(Object.isFrozen(result[0]));
    assert.isTrue(Object.isFrozen(result[0].items));
    assert.isTrue(Object.isFrozen(result[0].items[0].source.identifiers[0]));
    assert.isTrue(Object.isFrozen(result[0].items[0].operations[0].before.nested));
    try { result[0].items[0].title = "已篡改"; } catch { /* strict mode 会抛错 */ }
    try { result[0].items.push({}); } catch { /* 冻结数组会抛错 */ }

    const reread = await new BatchJournal(storage).getInspectableBatches();
    expect(reread[0].items[0].title).to.equal("测试图书");
    expect(reread[0].items).to.have.length(1);
    expect(storage.writes).to.equal(0);
  });

  it("存在待恢复快照时只读查询不触发重刷，并展示内存中的最新状态", async function () {
    class FailAfterPlanningStorage extends MemoryBatchJournalStorage {
      constructor() {
        super();
        this.writes = 0;
      }
      async write(value) {
        this.writes += 1;
        if (this.writes >= 3) throw new Error("磁盘持续失败");
        await super.write(value);
      }
    }
    const storage = new FailAfterPlanningStorage();
    const batchJournal = new BatchJournal(storage, () => "2026-08-30T01:00:00.000Z");
    const item = { itemID: 1, itemKey: "BOOK0001", libraryID: 1, title: "测试图书" };
    await batchJournal.startBatch("pending-snapshot", [item]);
    await batchJournal.planField("pending-snapshot", item.itemKey, { field: "title", before: "旧", after: "新" });
    try {
      await batchJournal.resolveField("pending-snapshot", item.itemKey, "title", "applied");
    } catch { /* 预期落盘失败，journal 保留待恢复快照 */ }
    expect(storage.writes).to.equal(3);

    const result = await batchJournal.getInspectableBatches();
    expect(storage.writes).to.equal(3);
    expect(result[0].items[0].operations[0].status).to.equal("applied");
  });

  it("损坏 JSON 与读取异常均向调用层报错，不降级为空记录", async function () {
    let parseError = null;
    try {
      await new BatchJournal(new MemoryBatchJournalStorage("{broken")).getInspectableBatches();
    } catch (error) { parseError = error; }
    assert.isOk(parseError);

    const readFailure = new Error("读取失败");
    let readError = null;
    try {
      await new BatchJournal({ read: async () => { throw readFailure; }, write: async () => {} }).getInspectableBatches();
    } catch (error) { readError = error; }
    expect(readError).to.equal(readFailure);
  });

  it("递归拒绝未知状态、空 item 与损坏操作，不把损坏日志当成空批次", async function () {
    const invalidRecords = [
      [record({ status: "unknown" })],
      [record({ items: [null] })],
      [record({ items: [{
        itemID: 1, itemKey: "BAD00001", libraryID: 1, title: "损坏字段",
        fields: [{ field: "title", before: "旧", after: "新", status: "unknown" }],
        createdItems: [],
      }] })],
      [record({ items: [{
        itemID: 1, itemKey: "BAD00002", libraryID: 1, title: "损坏子条目",
        fields: [], createdItems: [{ kind: "file", itemKey: "BAD", status: "applied" }],
      }] })],
      [record({ items: [{
        itemID: 1, itemKey: "BAD00003", libraryID: 1, title: "损坏来源",
        fields: [], createdItems: [], sourceEvidence: { providerId: "test", identifiers: null },
      }] })],
    ];

    for (const records of invalidRecords) {
      let error = null;
      try { await journal(records).getInspectableBatches(); } catch (caught) { error = caught; }
      expect(error).to.be.an("error").with.property("message", "批次日志格式无效");
    }
  });
});
