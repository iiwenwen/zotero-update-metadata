const { assert, expect } = require("chai");

describe("batchJournal（批次日志与最近一次撤销）", function () {
  let BatchJournal;
  let MemoryBatchJournalStorage;

  before(function () {
    const api = Zotero.zmtaAddon?.api;
    assert.isObject(api, "addon.api 应存在");
    BatchJournal = api.BatchJournal;
    MemoryBatchJournalStorage = api.MemoryBatchJournalStorage;
    assert.isFunction(BatchJournal, "BatchJournal 应暴露给测试");
    assert.isFunction(MemoryBatchJournalStorage, "MemoryBatchJournalStorage 应暴露给测试");
  });

  function makeJournal(times) {
    let index = 0;
    return new BatchJournal(
      new MemoryBatchJournalStorage(),
      () => times[index++] || times[times.length - 1],
    );
  }

  const inputItem = {
    itemID: 1,
    itemKey: "BOOK0001",
    libraryID: 1,
    title: "测试图书",
  };

  it("只为进入执行的最终候选持久化可选 SourceEvidence，旧记录仍兼容", async function () {
    const storage = new MemoryBatchJournalStorage();
    const journal = new BatchJournal(storage, () => "2026-08-30T00:00:00.000Z");
    const sourceEvidence = {
      providerId: "zotero-search",
      sourceURL: "https://doi.org/10.1000/example",
      identifiers: [{ type: "doi", value: "10.1000/example" }],
      fetchedAt: "2026-08-30T00:00:00.000Z",
      routeId: "doi.search",
      sourceId: "Crossref",
      translator: {
        id: "crossref-translator",
        label: "Crossref",
        attribution: "observed",
      },
    };
    const started = await journal.startBatch("source-evidence", [inputItem]);
    expect(started.items[0]).not.to.have.property("sourceEvidence");
    await journal.recordSourceEvidence("source-evidence", inputItem.itemKey, sourceEvidence);
    const record = await journal.finalizeBatch("source-evidence", "failed");
    expect(record.items[0].sourceEvidence).to.deep.equal(sourceEvidence);

    const legacy = new BatchJournal(new MemoryBatchJournalStorage(JSON.stringify([{
      batchId: "legacy",
      createdAt: "2026-08-29T00:00:00.000Z",
      completedAt: "2026-08-29T00:01:00.000Z",
      status: "failed",
      items: [{ ...inputItem, fields: [], createdItems: [] }],
    }])));
    expect((await legacy.getLatestCompletedBatch()).items[0]).not.to.have.property("sourceEvidence");
  });

  it("未知 Translator 归因值使 journal fail closed", async function () {
    const broken = new BatchJournal(new MemoryBatchJournalStorage(JSON.stringify([{
      batchId: "broken-attribution",
      createdAt: "2026-08-30T00:00:00.000Z",
      completedAt: "2026-08-30T00:01:00.000Z",
      status: "failed",
      items: [{
        ...inputItem,
        fields: [],
        createdItems: [],
        sourceEvidence: {
          providerId: "zotero-search",
          sourceURL: "https://doi.org/10.1000/example",
          identifiers: [{ type: "doi", value: "10.1000/example" }],
          fetchedAt: "2026-08-30T00:00:00.000Z",
          translator: { attribution: "guessed" },
        },
      }],
    }])));

    let thrown;
    try { await broken.getLatestCompletedBatch(); } catch (error) { thrown = error; }
    expect(String(thrown?.message || thrown)).to.include("格式无效");
  });

  it("用户身份确认依据可持久化，非法确认结构仍 fail closed", async function () {
    const journal = makeJournal(["2026-08-30T00:00:00.000Z"]);
    const evidence = {
      providerId: "url-web",
      sourceURL: "https://example.test/item",
      identifiers: [{ type: "url", value: "https://example.test/item" }],
      fetchedAt: "2026-08-30T00:00:00.000Z",
      identityConfirmation: { method: "user-confirmed", matchedFields: ["title", "creator"] },
    };
    await journal.startBatch("identity-confirmed", [inputItem]);
    await journal.recordSourceEvidence("identity-confirmed", inputItem.itemKey, evidence);
    await journal.finalizeBatch("identity-confirmed", "completed");
    expect((await journal.getLatestCompletedBatch()).items[0].sourceEvidence.identityConfirmation)
      .to.deep.equal(evidence.identityConfirmation);

    const broken = new BatchJournal(new MemoryBatchJournalStorage(JSON.stringify([{
      batchId: "broken-identity",
      createdAt: "2026-08-30T00:00:00.000Z",
      completedAt: "2026-08-30T00:01:00.000Z",
      status: "failed",
      items: [{ ...inputItem, fields: [], createdItems: [], sourceEvidence: { ...evidence, identityConfirmation: { method: "guessed", matchedFields: [] } } }],
    }])));
    let thrown;
    try { await broken.getLatestCompletedBatch(); } catch (error) { thrown = error; }
    expect(String(thrown?.message || thrown)).to.include("格式无效");
  });

  it("持久化 planned → applied/failed，并拒绝仍有 planned 的批次结束", async function () {
    const journal = makeJournal(["2026-08-29T01:00:00.000Z", "2026-08-29T01:01:00.000Z"]);
    await journal.startBatch("batch-1", [inputItem]);
    await journal.planField("batch-1", inputItem.itemKey, { field: "title", before: "旧", after: "新" });
    await journal.planCreatedItem("batch-1", inputItem.itemKey, { kind: "attachment", operationId: "att-op-1" });

    let finalizeError = null;
    try {
      await journal.finalizeBatch("batch-1", "completed");
    } catch (error) {
      finalizeError = error;
    }
    assert.isOk(finalizeError, "仍有 planned 操作时应拒绝结束批次");
    expect(String(finalizeError.message || finalizeError)).to.include("仍有未完成操作");

    await journal.resolveField("batch-1", inputItem.itemKey, "title", "applied");
    await journal.resolveCreatedItem("batch-1", inputItem.itemKey, "att-op-1", "failed", undefined, "下载失败");
    const completed = await journal.finalizeBatch("batch-1", "partial");

    expect(completed.status).to.equal("partial");
    expect(completed.items[0].fields[0].status).to.equal("applied");
    expect(completed.items[0].createdItems[0]).to.include({ status: "failed", message: "下载失败" });
  });

  it("Creator 列表作为一个操作持久化并兼容实际 after", async function () {
    const journal = makeJournal(["2026-08-29T01:00:00.000Z", "2026-08-29T01:01:00.000Z"]);
    const before = [{ creatorType: "author", firstName: "旧", lastName: "作者" }];
    const after = [
      { creatorType: "author", firstName: "新", lastName: "作者" },
      { creatorType: "translator", name: "翻译组" },
    ];
    await journal.startBatch("creator-operation", [inputItem]);
    await journal.planCreators("creator-operation", inputItem.itemKey, { before, after });
    let finalizeError;
    try { await journal.finalizeBatch("creator-operation", "completed"); } catch (error) { finalizeError = error; }
    expect(String(finalizeError?.message || finalizeError)).to.include("仍有未完成操作");

    const actualAfter = [...after, { creatorType: "editor", firstName: "实际", lastName: "编辑" }];
    await journal.resolveCreators("creator-operation", inputItem.itemKey, "applied", undefined, false, actualAfter);
    const completed = await journal.finalizeBatch("creator-operation", "completed");
    expect(completed.items[0].creators).to.deep.equal({ before, after: actualAfter, status: "applied" });
    expect(completed.items[0]).not.to.have.property("creatorChanges");
  });

  it("识别崩溃后仍为 running 或缺少 completedAt 的未完成批次", async function () {
    const storage = new MemoryBatchJournalStorage(JSON.stringify([
      { batchId: "running", createdAt: "2026-08-29T01:00:00.000Z", status: "running", items: [] },
      { batchId: "broken", createdAt: "2026-08-29T01:01:00.000Z", status: "partial", items: [] },
      {
        batchId: "done",
        createdAt: "2026-08-29T01:02:00.000Z",
        completedAt: "2026-08-29T01:03:00.000Z",
        status: "completed",
        items: [],
      },
    ]));
    const journal = new BatchJournal(storage);

    expect((await journal.listIncompleteBatches()).map((entry) => entry.batchId)).to.deep.equal(["running", "broken"]);
  });

  it("只暴露最新终态批次，不因最新批次不可撤销而回退到旧批次", async function () {
    const journal = makeJournal([
      "2026-08-29T01:00:00.000Z", "2026-08-29T01:01:00.000Z",
      "2026-08-29T02:00:00.000Z", "2026-08-29T02:01:00.000Z",
    ]);
    await journal.startBatch("old", [inputItem]);
    await journal.planField("old", inputItem.itemKey, { field: "title", before: "旧", after: "新" });
    await journal.resolveField("old", inputItem.itemKey, "title", "applied");
    await journal.finalizeBatch("old", "completed");

    await journal.startBatch("new", [inputItem]);
    await journal.finalizeBatch("new", "failed");

    expect((await journal.getLatestCompletedBatch()).batchId).to.equal("new");
    expect(await journal.getLatestUndoableBatch()).to.equal(null);
  });

  it("较新的未完成批次存在时 fail closed，不撤销旧终态批次", async function () {
    const journal = makeJournal([
      "2026-08-29T01:00:00.000Z", "2026-08-29T01:01:00.000Z",
      "2026-08-29T02:00:00.000Z",
    ]);
    await journal.startBatch("old", [inputItem]);
    await journal.planField("old", inputItem.itemKey, { field: "title", before: "旧", after: "新" });
    await journal.resolveField("old", inputItem.itemKey, "title", "applied");
    await journal.finalizeBatch("old", "completed");
    await journal.startBatch("new-running", [inputItem]);

    let latestError = null;
    try { await journal.getLatestUndoableBatch(); } catch (error) { latestError = error; }
    expect(String(latestError?.message || latestError)).to.include("new-running");

    let rollbackError = null;
    try {
      await journal.rollbackLatest({
        getItem: () => { throw new Error("不应读取旧条目"); },
        getField: () => null,
        setField: () => {},
        saveItem: async () => {},
        trashItem: async () => {},
      });
    } catch (error) { rollbackError = error; }
    expect(String(rollbackError?.message || rollbackError)).to.include("拒绝撤销较早批次");
  });

  it("applied 日志瞬时落盘失败后保留快照，并在 finalize 前恢复", async function () {
    class FailOnceStorage extends MemoryBatchJournalStorage {
      constructor() {
        super();
        this.writes = 0;
      }
      async write(value) {
        this.writes += 1;
        if (this.writes === 3) throw new Error("瞬时磁盘错误");
        await super.write(value);
      }
    }
    const storage = new FailOnceStorage();
    const journal = new BatchJournal(storage, () => "2026-08-29T01:00:00.000Z");
    await journal.startBatch("recover", [inputItem]);
    await journal.planField("recover", inputItem.itemKey, { field: "title", before: "旧", after: "新" });

    let resolveError = null;
    try { await journal.resolveField("recover", inputItem.itemKey, "title", "applied"); } catch (error) { resolveError = error; }
    expect(String(resolveError?.message || resolveError)).to.include("瞬时磁盘错误");

    const completed = await journal.finalizeBatch("recover", "completed");
    expect(completed.items[0].fields[0].status).to.equal("applied");
    expect((await journal.getLatestUndoableBatch()).batchId).to.equal("recover");
  });

  it("补偿成功可将恢复出的 applied 改记 failed，补偿失败则保留可撤销依据", async function () {
    const journal = makeJournal(["2026-08-29T01:00:00.000Z", "2026-08-29T01:01:00.000Z"]);
    await journal.startBatch("compensation", [inputItem]);
    await journal.planField("compensation", inputItem.itemKey, { field: "title", before: "旧", after: "新" });
    await journal.resolveField("compensation", inputItem.itemKey, "title", "applied");
    await journal.resolveField("compensation", inputItem.itemKey, "title", "failed", "已恢复旧值");
    const failed = await journal.finalizeBatch("compensation", "failed");
    expect(failed.items[0].fields[0].status).to.equal("failed");
    expect(await journal.getLatestUndoableBatch()).to.equal(null);

    const serious = makeJournal(["2026-08-29T02:00:00.000Z", "2026-08-29T02:01:00.000Z"]);
    await serious.startBatch("serious", [inputItem]);
    await serious.planCreatedItem("serious", inputItem.itemKey, { kind: "note", operationId: "note-op" });
    await serious.resolveCreatedItem("serious", inputItem.itemKey, "note-op", "applied", "NOTE0001");
    await serious.resolveCreatedItem(
      "serious", inputItem.itemKey, "note-op", "failed", undefined,
      "严重：applied 日志失败，补偿也失败", true,
    );
    const preserved = await serious.finalizeBatch("serious", "failed");
    expect(preserved.items[0].createdItems[0]).to.include({ status: "applied", itemKey: "NOTE0001" });
    expect(await serious.getLatestUndoableBatch()).to.not.equal(null);
  });

  it("安全回滚字段，并仅将本批记录的新附件与 note 移入回收站", async function () {
    const journal = makeJournal(["2026-08-29T01:00:00.000Z", "2026-08-29T01:01:00.000Z"]);
    await journal.startBatch("batch-safe", [inputItem]);
    await journal.planField("batch-safe", inputItem.itemKey, { field: "title", before: "旧标题", after: "新标题" });
    await journal.resolveField("batch-safe", inputItem.itemKey, "title", "applied");
    await journal.planCreatedItem("batch-safe", inputItem.itemKey, { kind: "attachment", operationId: "a-op" });
    await journal.resolveCreatedItem("batch-safe", inputItem.itemKey, "a-op", "applied", "ATT00001", undefined, false, "fixture");
    await journal.planCreatedItem("batch-safe", inputItem.itemKey, { kind: "note", operationId: "n-op" });
    await journal.resolveCreatedItem("batch-safe", inputItem.itemKey, "n-op", "applied", "NOTE0001", undefined, false, "fixture");
    await journal.finalizeBatch("batch-safe", "completed");

    const item = { fields: { title: "新标题" } };
    const trashed = [];
    const result = await journal.rollbackLatest({
      getItem: async () => item,
      getCreatedItemFingerprint: () => "fixture",
      getField: (target, field) => target.fields[field],
      setField: (target, field, value) => { target.fields[field] = value; },
      saveItem: async () => {},
      trashItem: async (libraryID, itemKey) => { trashed.push([libraryID, itemKey]); },
    });

    expect(item.fields.title).to.equal("旧标题");
    expect(trashed).to.deep.equal([[1, "ATT00001"], [1, "NOTE0001"]]);
    expect(result).to.include({ batchId: "batch-safe", rolledBack: 3, conflicts: 0, failed: 0 });
    expect(await journal.getLatestUndoableBatch()).to.equal(null);
  });

  it("当前字段已变化时不覆盖，回滚部分失败仍继续后续操作", async function () {
    const journal = makeJournal(["2026-08-29T01:00:00.000Z", "2026-08-29T01:01:00.000Z"]);
    await journal.startBatch("batch-partial", [inputItem]);
    await journal.planField("batch-partial", inputItem.itemKey, { field: "title", before: "旧标题", after: "新标题" });
    await journal.resolveField("batch-partial", inputItem.itemKey, "title", "applied");
    for (const [operationId, itemKey] of [["bad-op", "BAD00001"], ["ok-op", "OK000001"]]) {
      await journal.planCreatedItem("batch-partial", inputItem.itemKey, { kind: "attachment", operationId });
      await journal.resolveCreatedItem("batch-partial", inputItem.itemKey, operationId, "applied", itemKey, undefined, false, "fixture");
    }
    await journal.finalizeBatch("batch-partial", "completed");

    const item = { fields: { title: "人工修改" } };
    const trashed = [];
    const result = await journal.rollbackLatest({
      getItem: async () => item,
      getCreatedItemFingerprint: () => "fixture",
      getField: (target, field) => target.fields[field],
      setField: () => { throw new Error("冲突字段不应写入"); },
      saveItem: async () => {},
      trashItem: async (_libraryID, itemKey) => {
        if (itemKey === "BAD00001") throw new Error("移入回收站失败");
        trashed.push(itemKey);
      },
    });

    expect(item.fields.title).to.equal("人工修改");
    expect(trashed).to.deep.equal(["OK000001"]);
    expect(result).to.include({ rolledBack: 1, conflicts: 1, failed: 1 });
    expect(result.items[0].status).to.equal("rollback-conflict");
    expect((await journal.getLatestCompletedBatch()).status).to.equal("rollback-partial");
  });

  it("Creator 回滚只在当前列表仍等于 after 时恢复完整 before", async function () {
    const journal = makeJournal(["2026-08-29T01:00:00.000Z", "2026-08-29T01:01:00.000Z"]);
    const before = [
      { creatorType: "author", firstName: "旧", lastName: "作者" },
      { creatorType: "translator", name: "旧翻译组" },
    ];
    const after = [
      { creatorType: "author", firstName: "新", lastName: "作者" },
      { creatorType: "translator", name: "新翻译组" },
    ];
    await journal.startBatch("creator-rollback", [inputItem]);
    await journal.planCreators("creator-rollback", inputItem.itemKey, { before, after });
    await journal.resolveCreators("creator-rollback", inputItem.itemKey, "applied");
    await journal.finalizeBatch("creator-rollback", "completed");

    const item = { creators: after };
    const result = await journal.rollbackLatest({
      getItem: async () => item,
      getField: () => undefined,
      setField: () => {},
      getCreators: (target) => target.creators,
      setCreators: (target, creators) => { target.creators = creators; },
      saveItem: async () => {},
      trashItem: async () => {},
    });
    expect(item.creators).to.deep.equal(before);
    expect(result).to.include({ rolledBack: 1, conflicts: 0, failed: 0 });
    expect(result.items[0].operations[0]).to.include({ kind: "creators", identity: "creators:set", status: "rolled-back" });
  });

  it("Creator 当前列表被人工修改时记回滚冲突且零写入", async function () {
    const journal = makeJournal(["2026-08-29T01:00:00.000Z", "2026-08-29T01:01:00.000Z"]);
    const before = [{ creatorType: "author", firstName: "旧", lastName: "作者" }];
    const after = [{ creatorType: "author", firstName: "新", lastName: "作者" }];
    await journal.startBatch("creator-conflict", [inputItem]);
    await journal.planCreators("creator-conflict", inputItem.itemKey, { before, after });
    await journal.resolveCreators("creator-conflict", inputItem.itemKey, "applied");
    await journal.finalizeBatch("creator-conflict", "completed");

    let setCalls = 0;
    const item = { creators: [{ creatorType: "editor", name: "人工编辑" }] };
    const result = await journal.rollbackLatest({
      getItem: async () => item,
      getField: () => undefined,
      setField: () => {},
      getCreators: (target) => target.creators,
      setCreators: () => { setCalls += 1; },
      saveItem: async () => {},
      trashItem: async () => {},
    });
    expect(setCalls).to.equal(0);
    expect(result).to.include({ rolledBack: 0, conflicts: 1, failed: 0 });
    expect(result.items[0].operations[0]).to.include({ kind: "creators", status: "rollback-conflict" });
  });
});
