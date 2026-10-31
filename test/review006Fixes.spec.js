const { expect } = require("chai");

describe("评审006修复C1/C2/C3（真实生产函数，内存宿主）", function () {
  let api;
  before(function () { api = { ...Zotero.zmtaAddon.api, ...Zotero.zmtaAddon.testApi }; });
  const url = "https://example.test/review006/1";
  const isbn = "9780262033848";
  const ref = { itemID: 1, itemKey: "PARENT1", libraryID: 1, itemType: "book", title: "Local" };

  async function childFlow(options = {}) {
    const kind = options.kind || "note";
    const parent = { id: 1, key: "PARENT1", libraryID: 1, itemType: "book",
      fields: { title: "Local", ISBN: isbn, url },
      getField(k) { return this.fields[k] ?? ""; }, isRegularItem: () => true,
    };
    let child, observer, registrations = 0, removals = 0, trashes = 0;
    const edit = () => {
      if (kind === "note") child.content = "Human";
      else child.annotations.push({ toJSON: () => ({ annotationComment: "Human" }) });
    };
    function makeChild(type) {
      return { id: 2, key: "CHILD2", libraryID: 1, parentID: 1, content: "", annotations: [],
        isNote: () => type === "note", isAttachment: () => type === "attachment",
        getNote() { return this.content; }, setNote(value) { this.content = value.trim(); },
        getAnnotations() { return this.annotations; }, getFilePath: () => false,
        toJSON() { return type === "note" ? { itemType: type, note: this.content } : {
          itemType: type, title: "PDF", url: url + ".pdf", contentType: "application/pdf" }; },
        saveTx: saved,
      };
    }
    async function saved(saveOptions) {
      if (options.createThrows) throw new Error("create failed");
      await Promise.resolve();
      if (options.editAt === "before-notification") edit();
      observer?.notify("add", "item", [2], { 2: { zmtaCreationToken:
        options.wrongToken ? "unrelated" : saveOptions?.notifierData.zmtaCreationToken } });
      if (options.editAt === "after-notification") edit();
      if (options.duplicateNotification) observer?.notify("add", "item", [2], { 2: saveOptions?.notifierData });
      if (options.identityChanges) parent.fields.ISBN = "9780140328721";
    }
    const host = {
      userLibraryID: 1, getItem: async () => parent,
      createItem: (type) => child = makeChild(type),
      importAttachment: async (settings) => { child = makeChild("attachment"); await saved(settings.saveOptions); return child; },
      trashItem: async () => { if (options.trashFails) throw new Error("trash failed"); trashes += 1; },
      ...(!options.noObserver ? { creationNotifier: {
        register(value) { observer = value; registrations += 1; return "observer-1"; },
        unregister() { observer = undefined; removals += 1; },
        getItem: () => child,
      } } : {}),
    };
    const port = new api.DefaultZoteroMutationPort(host);
    const storage = new api.MemoryBatchJournalStorage();
    const journal = new api.BatchJournal(storage);
    await journal.startBatch("review006", [ref]);
    const callback = api.createJournalCallback(journal);
    const candidate = { providerId: "url-web", item: ref, itemType: "book",
      evidence: { providerId: "url-web", sourceURL: url, routeId: "url.web", fetchedAt: "2026-10-27T00:00:00Z",
        identifiers: [{ type: "isbn", value: isbn }] },
      localIdentifiers: [{ type: "isbn", value: isbn }], fields: [], attachments: [], notes: [],
    };
    const selected = { itemID: 1, itemKey: "PARENT1", candidate, candidateDigest: api.createCandidateDigest(candidate),
      fields: [],
      notes: kind === "note" ? [{ content: " Upstream ", batchOperationId: "note:1" }] : [],
      attachments: kind === "attachment" ? [{ url: url + ".pdf", title: "PDF", mimeType: "application/pdf", batchOperationId: "attachment:1" }] : [],
    };
    const result = await api.applyBatch([selected], { batchId: "review006", getItem: async () => parent, port,
      onOperationStatus: async (event) => {
        await callback(options.localizeError && event.status === "failed" ? { ...event, message: "localized error" } : event);
      },
    });
    await journal.finalizeBatch("review006", api.finalJournalStatus(result));
    const record = await journal.getLatestCompletedBatch();
    const inspections = await journal.getInspectableBatches();
    const rollback = await journal.rollbackLatest({
      getItem: async (_library, key) => key === "CHILD2" ? child : parent,
      getCreatedItemFingerprint: (value) => port.getCreatedItemFingerprint(value),
      trashItem: async (_library, _key, expected) => port.trashCreatedItem(child, expected),
    });
    return { result, record, inspections, rollback, trashes, registrations, removals, child, storage, selected, port, parent };
  }

  for (const kind of ["note", "attachment"]) {
    for (const editAt of ["before-notification", "after-notification"]) {
      it(`C1 ${kind}：${editAt}发生人工编辑，撤销保留子项`, async function () {
        const r = await childFlow({ kind, editAt });
        expect(r.result.applied).to.equal(1);
        expect(r.trashes).to.equal(0);
        expect(r.rollback.conflicts).to.equal(1);
        expect(kind === "note" ? r.child.content : r.child.annotations[0].toJSON().annotationComment).to.equal("Human");
        expect(r.registrations).to.equal(1);
        expect(r.removals).to.equal(1);
      });
    }
    it(`C1 ${kind}：取得创建通知证明且未编辑时正常回退`, async function () {
      const r = await childFlow({ kind });
      expect(r.record.items[0].createdItems[0].fingerprint).to.match(/^child-v2:/);
      expect(r.trashes).to.equal(1);
      expect(r.rollback.rolledBack).to.equal(1);
    });
    it(`C1 ${kind}：无观察能力或通知标记不匹配时不补造指纹`, async function () {
      for (const settings of [{ noObserver: true }, { wrongToken: true }]) {
        const r = await childFlow({ kind, ...settings });
        expect(r.record.items[0].createdItems[0].fingerprint).to.equal(undefined);
        expect(r.record.items[0].createdItems[0].message).to.include("保留该内容");
        expect(r.trashes).to.equal(0);
      }
    });
  }

  it("C1：创建抛错也清理本次通知观察者，且不产生回收动作", async function () {
    const r = await childFlow({ createThrows: true });
    expect(r.result.failed).to.equal(1);
    expect(r.registrations).to.equal(r.removals);
    expect(r.trashes).to.equal(0);
  });

  it("C1：重复add通知不能以人工新值重建初始证明", async function () {
    const r = await childFlow({ editAt: "after-notification", duplicateNotification: true });
    expect(r.trashes).to.equal(0);
    expect(r.rollback.conflicts).to.equal(1);
  });

  it("C1：默认宿主正确传递notifierData并优先捕获，结束后注销观察者", async function () {
    const original = { Libraries: Zotero.Libraries, Items: Zotero.Items, Item: Zotero.Item, Notifier: Zotero.Notifier };
    let child, observer, removed = false;
    try {
      Zotero.Libraries = { userLibraryID: 1 };
      Zotero.Items = { get: () => child };
      Zotero.Notifier = {
        registerObserver(value, types, _name, priority) { expect(types).to.deep.equal(["item"]); expect(priority).to.be.below(0); observer = value; return "default-observer"; },
        unregisterObserver(id) { expect(id).to.equal("default-observer"); removed = true; },
      };
      Zotero.Item = function () {
        child = { id: 2, key: "DEFAULT2", content: "", isNote: () => true, isAttachment: () => false,
          getNote() { return this.content; }, setNote(value) { this.content = value.trim(); },
          toJSON() { return { itemType: "note", note: this.content }; },
          async saveTx(options) {
            observer.notify("add", "item", [2], { 2: options.notifierData });
            await Promise.resolve(); this.content = "Human";
          },
        };
        return child;
      };
      const port = new api.DefaultZoteroMutationPort();
      const created = await port.createNote({ id: 1, libraryID: 1 }, " Upstream ");
      expect(port.getCreatedItemCreationFingerprint(created)).to.be.a("string");
      expect(port.getCreatedItemCreationFingerprint(created)).not.to.equal(port.getCreatedItemFingerprint(created));
      expect(removed).to.equal(true);
    } finally { Object.assign(Zotero, original); }
  });

  it("C2：首次applied前补偿失败保留真实key、指纹与恢复标记，不冒充成功", async function () {
    const r = await childFlow({ identityChanges: true, trashFails: true, localizeError: true });
    const entry = r.record.items[0].createdItems[0];
    expect(entry).to.include({ itemKey: "CHILD2", operationId: "note:1", status: "failed", recoveryRequired: true, message: "localized error" });
    expect(entry.fingerprint).to.match(/^child-v2:/);
    expect(r.result.items[0].operations[0]).to.include({ status: "failed", recoveryRequired: true });
    expect(r.inspections[0].items[0].operations[0].recoveryRequired).to.equal(true);
    expect(r.rollback).to.equal(null); // 人工处理状态，不能把所有failed自动当applied删除。
    const reloaded = new api.BatchJournal(r.storage);
    expect((await reloaded.getLatestCompletedBatch()).items[0].createdItems[0]).to.deep.equal(entry);
  });

  it("C2：补偿成功不留下恢复待办；只有错误文案不能伪造恢复标记", async function () {
    const r = await childFlow({ identityChanges: true });
    expect(r.record.items[0].createdItems[0].recoveryRequired).not.to.equal(true);
    expect(r.trashes).to.equal(1);
    const journal = new api.BatchJournal(new api.MemoryBatchJournalStorage());
    await journal.startBatch("wording", [ref]);
    const cb = api.createJournalCallback(journal);
    const event = { batchId: "wording", itemID: 1, itemKey: ref.itemKey, kind: "field", identity: "title", before: "A", after: "B" };
    await cb({ ...event, status: "planned" });
    await cb({ ...event, status: "failed", message: "严重：applied 日志失败只是错误文案" });
    await journal.finalizeBatch("wording", "failed");
    expect((await journal.getLatestCompletedBatch()).items[0].fields[0].recoveryRequired).not.to.equal(true);
  });

  it("C2：无创建证明且补偿无法安全执行时，仍记录真实key和人工处理要求", async function () {
    const r = await childFlow({ noObserver: true, identityChanges: true });
    const entry = r.record.items[0].createdItems[0];
    expect(entry).to.include({ itemKey: "CHILD2", recoveryRequired: true, status: "failed" });
    expect(entry.fingerprint).to.equal(undefined);
    expect(r.trashes).to.equal(0);
  });

  for (const kind of ["field", "creators"]) {
    it(`C2 ${kind}：首次applied前日志失败且补偿失败保存实际after与恢复标记`, async function () {
      const journal = new api.BatchJournal(new api.MemoryBatchJournalStorage());
      await journal.startBatch("residual", [ref]);
      const cb = api.createJournalCallback(journal);
      const beforeCreators = [{ creatorType: "author", name: "Before" }];
      const afterCreators = [{ creatorType: "author", name: "After" }];
      const item = { title: "Before", creators: structuredClone(beforeCreators) };
      let saves = 0;
      const port = { getItem: async () => item, getField: (i) => i.title, setField: (i, _f, v) => i.title = v,
        getCreators: (i) => structuredClone(i.creators), setCreators: (i, v) => i.creators = structuredClone(v),
        saveItem: async () => { if (++saves === 2) throw new Error("compensation save rejected"); },
      };
      const operation = kind === "field" ? { kind: "field-set", operationId: "field:title", field: "title", before: "Before", after: "After" }
        : { kind: "creators-set", operationId: "creators:set", before: beforeCreators, after: afterCreators };
      const plan = api.createChangePlan({ planId: "residual", createdAt: "2026-10-27T00:00:00Z", items: [{ item: ref,
        evidence: [{ providerId: "fixture", sourceURL: url, identifiers: [], fetchedAt: "2026-10-27T00:00:00Z" }], operations: [operation] }] });
      const result = await new api.ChangeExecutor(port, async (event) => {
        if (event.status === "applied") throw new Error("applied failed before journal");
        await cb({ batchId: "residual", itemID: 1, itemKey: ref.itemKey, kind, identity: kind === "field" ? "title" : "creators:set",
          status: event.status, before: operation.before, after: event.actualAfter ?? operation.after, recoveryRequired: event.recoveryRequired, message: event.message });
      }).execute(plan);
      await journal.finalizeBatch("residual", "failed");
      const record = (await journal.getLatestCompletedBatch()).items[0];
      const entry = kind === "field" ? record.fields[0] : record.creators;
      expect(entry).to.include({ status: "failed", recoveryRequired: true });
      expect(entry.after).to.deep.equal(operation.after);
      expect(result.items[0].operations[0].recoveryRequired).to.equal(true);
    });
  }

  it("C2：恢复待办不进入普通重试，也不开放仅有残留项的重试入口", async function () {
    const r = await childFlow({ identityChanges: true, trashFails: true });
    r.parent.fields.ISBN = isbn;
    api.resetBatchRuntimeForTests({ journal: new api.BatchJournal(r.storage), retryState: { selections: [r.selected], result: r.result } });
    expect((await api.refreshBatchRuntimeCapabilities()).hasRetryableItems).to.equal(false);
    api.resetBatchRuntimeForTests();
    let resolved, preflights = 0;
    await api.retryFailedBatch([r.selected], r.result, { getItem: async () => r.parent, port: r.port,
      resolver: { resolve: async () => { preflights += 1; return { candidate: r.selected.candidate, attempts: [], terminalOutcome: "candidate" }; } },
      onResolvedSelections: (selections) => { resolved = selections; },
    });
    expect(resolved).to.deep.equal([]);
    expect(preflights).to.equal(0);
  });

  async function batches(clock, reverse = false) {
    const storage = new api.MemoryBatchJournalStorage();
    const journal = new api.BatchJournal(storage, clock);
    for (const id of ["older", "newer"]) {
      await journal.startBatch(id, [ref]);
      await journal.planField(id, ref.itemKey, { field: id === "older" ? "title" : "publisher", before: "Before", after: "After" });
      await journal.resolveField(id, ref.itemKey, id === "older" ? "title" : "publisher", "applied");
    }
    for (const id of reverse ? ["newer", "older"] : ["older", "newer"]) await journal.finalizeBatch(id, "completed");
    return { storage, journal };
  }

  for (const rollbackClock of [false, true]) {
    it(`C3：${rollbackClock ? "时钟回退" : "相同毫秒"}仍选择最近完成批次，重启读取一致`, async function () {
      let tick = 0;
      const { journal, storage } = await batches(() => rollbackClock ? new Date(1793059200000 - tick++).toISOString() : "2026-10-27T00:00:00.000Z");
      expect((await journal.getLatestCompletedBatch()).batchId).to.equal("newer");
      expect((await new api.BatchJournal(storage).getLatestUndoableBatch()).batchId).to.equal("newer");
      const item = { title: "After", publisher: "After" };
      const result = await journal.rollbackLatest({ getItem: async () => item,
        getField: (i, f) => i[f], setField: (i, f, v) => i[f] = v, saveItem: async () => {} });
      expect(result.batchId).to.equal("newer");
      expect(item).to.deep.equal({ title: "After", publisher: "Before" });
    });
  }

  it("C3：交错批次按完成顺序而非开始顺序选择，较新未完成批次仍阻断", async function () {
    const { journal } = await batches(() => "2026-10-27T00:00:00Z", true);
    expect((await journal.getLatestCompletedBatch()).batchId).to.equal("older");
    await journal.startBatch("running", [ref]);
    let error;
    try { await journal.getLatestUndoableBatch(); } catch (e) { error = e; }
    expect(error?.name).to.equal("IncompleteBatchBlocksRollbackError");
  });

  it("C3：旧日志无完成序号时兼容，相同时间优先后写入记录", async function () {
    const records = ["older", "newer"].map((id) => ({ batchId: id, createdAt: "2026-10-27T00:00:00Z", completedAt: "2026-10-27T00:00:00Z", status: "completed", items: [] }));
    const journal = new api.BatchJournal(new api.MemoryBatchJournalStorage(JSON.stringify(records)));
    expect((await journal.getLatestCompletedBatch()).batchId).to.equal("newer");
  });

  it("C3：时钟回退后新建的未完成批次也阻断回退", async function () {
    let clock = "2026-10-27T10:00:00Z";
    const { journal } = await batches(() => clock);
    clock = "2026-10-26T00:00:00Z";
    await journal.startBatch("clock-back-running", [ref]);
    let error;
    try { await journal.rollbackLatest({}); } catch (e) { error = e; }
    expect(error?.name).to.equal("IncompleteBatchBlocksRollbackError");
  });
});
