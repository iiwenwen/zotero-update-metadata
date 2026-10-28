const { expect } = require("chai");

describe("评审006外审意见定向回归", function () {
  let api;
  before(function () { api = { ...Zotero.zmtaAddon.api, ...Zotero.zmtaAddon.testApi }; });
  const ref = { itemID: 1, itemKey: "FOLLOW1", libraryID: 1, itemType: "book", title: "Local" };
  const evidence = { providerId: "fixture", sourceURL: "https://example.test/followup", identifiers: [], fetchedAt: "2026-10-27T00:00:00Z" };
  const field = { kind: "field-set", operationId: "field:title", field: "title", before: "Before", after: "Planned" };
  const creators = { kind: "creators-set", operationId: "creators:set", before: [{ creatorType: "author", name: "Before" }], after: [{ creatorType: "author", name: "Planned" }] };
  const note = { kind: "note-create", operationId: "note:1", content: "Upstream" };
  function plan(operation) {
    return api.createChangePlan({ planId: "followup", createdAt: evidence.fetchedAt, items: [{ item: ref, evidence: [evidence], operations: [operation] }] });
  }
  async function journal() {
    const storage = new api.MemoryBatchJournalStorage();
    const j = new api.BatchJournal(storage);
    await j.startBatch("followup", [ref]);
    return { j, storage, cb: api.createJournalCallback(j) };
  }
  function bridge(cb) {
    return (event) => {
      const op = event.operation;
      const kind = op.kind === "field-set" ? "field" : op.kind === "creators-set" ? "creators" : "note";
      return cb({ batchId: event.planId, itemID: 1, itemKey: ref.itemKey, kind,
        identity: kind === "field" ? op.field : op.operationId, status: event.status,
        before: op.before, after: event.status === "planned" ? op.after : event.actualAfter,
        createdItemKey: event.createdItemKey, createdItemFingerprint: event.createdItemFingerprint,
        recoveryRequired: event.recoveryRequired, message: "localized failure" });
    };
  }

  for (const keyThrows of [false, true]) {
    it(`C2：${keyThrows ? "读取key抛错" : "新子项缺key"}仍持久化身份未知的恢复状态，不留planned`, async function () {
      const { j, storage, cb } = await journal();
      let trashes = 0;
      const port = { getItem: async () => ({}), createNote: async () => ({}),
        getCreatedItemKey() { if (keyThrows) throw new Error("key unavailable"); },
        getCreatedItemCreationFingerprint: () => undefined,
        trashCreatedItem: async () => { trashes++; throw new Error("cannot safely trash"); } };
      const result = await new api.ChangeExecutor(port, bridge(cb)).execute(plan(note));
      await j.finalizeBatch("followup", "failed");
      const entry = (await new api.BatchJournal(storage).getLatestCompletedBatch()).items[0].createdItems[0];
      expect(entry).to.include({ status: "failed", recoveryRequired: true, identityUnknown: true, operationId: "note:1" });
      expect(result.items[0].operations[0].recoveryRequired).to.equal(true);
      expect(trashes).to.equal(0);
      expect(await j.getLatestUndoableBatch()).to.equal(null);
      const inspect = (await j.getInspectableBatches())[0].items[0].operations[0];
      expect(inspect.identityUnknown).to.equal(true);
      expect(inspect).not.to.have.property("createdItemKey");
      expect(inspect.message).to.include("身份未知");
    });
  }

  for (const kind of ["field", "creators", "note", "attachment"]) {
    it(`C2：混合批次回退保留${kind}人工恢复项，不能误报全部撤销`, async function () {
      const { j, storage } = await journal();
      await j.planField("followup", ref.itemKey, { field: "publisher", before: "Before", after: "Applied" });
      await j.resolveField("followup", ref.itemKey, "publisher", "applied");
      if (kind === "field") {
        await j.planField("followup", ref.itemKey, { field: "title", before: "Before", after: "Planned" });
        await j.resolveField("followup", ref.itemKey, "title", "failed", "localized", false, "Actual", true);
      } else if (kind === "creators") {
        await j.planCreators("followup", ref.itemKey, creators);
        await j.resolveCreators("followup", ref.itemKey, "failed", "localized", false, creators.after, true);
      } else {
        await j.planCreatedItem("followup", ref.itemKey, { kind, operationId: `${kind}:1` });
        await j.resolveCreatedItem("followup", ref.itemKey, `${kind}:1`, "failed", "CHILD2", "localized", false, "proof", true);
      }
      await j.finalizeBatch("followup", "partial");
      const item = { publisher: "Applied", title: "Human" };
      let trashes = 0;
      const result = await j.rollbackLatest({ getItem: async () => item,
        getField: (i, f) => i[f], setField: (i, f, v) => i[f] = v, saveItem: async () => {},
        trashItem: async () => { trashes++; } });
      expect(result).to.include({ rolledBack: 1, conflicts: 1 });
      expect(item).to.deep.equal({ publisher: "Before", title: "Human" });
      expect(trashes).to.equal(0);
      expect(result.items[0].operations.find((op) => op.recoveryRequired)).to.include({ status: "rollback-conflict" });
      const reloaded = new api.BatchJournal(storage);
      expect((await reloaded.getLatestCompletedBatch()).status).to.equal("rollback-partial");
      expect((await reloaded.getInspectableBatches())[0].items[0].operations.some((op) => op.recoveryRequired)).to.equal(true);
    });
  }

  it("C2：恢复检查从结构化记录提供真实子项key，不依赖错误文案", async function () {
    const { j } = await journal();
    await j.planCreatedItem("followup", ref.itemKey, { kind: "note", operationId: "note:1" });
    await j.resolveCreatedItem("followup", ref.itemKey, "note:1", "failed", "REALKEY2", "localized", false, "proof", true);
    await j.finalizeBatch("followup", "failed");
    const op = (await j.getInspectableBatches())[0].items[0].operations[0];
    expect(op).to.include({ operationId: "note:1", createdItemKey: "REALKEY2", recoveryRequired: true });
    expect(op.message).to.include("REALKEY2");
    expect(await j.getLatestUndoableBatch()).to.equal(null);
  });

  it("C2：后续恢复事件丢失key时仍保留已知真实身份；已捕获的null不是未知", async function () {
    const { j } = await journal();
    await j.planCreatedItem("followup", ref.itemKey, { kind: "note", operationId: "note:1" });
    await j.resolveCreatedItem("followup", ref.itemKey, "note:1", "applied", "REALKEY2", undefined, false, "proof");
    await j.resolveCreatedItem("followup", ref.itemKey, "note:1", "failed", undefined, "localized", true, undefined, true);
    await j.planField("followup", ref.itemKey, { field: "title", before: "Before", after: "Planned" });
    await j.resolveField("followup", ref.itemKey, "title", "failed", "localized", false, null, true);
    await j.finalizeBatch("followup", "partial");
    const item = (await j.getLatestCompletedBatch()).items[0];
    expect(item.createdItems[0]).to.include({ itemKey: "REALKEY2", fingerprint: "proof", recoveryRequired: true });
    expect(item.createdItems[0].identityUnknown).not.to.equal(true);
    expect(item.fields[0].after).to.equal(null);
    expect(item.fields[0].afterUnknown).not.to.equal(true);
  });

  for (const kind of ["field", "creators"]) {
    it(`C2 ${kind}：实际写入值捕获失败时明确标记未知，不能持久化计划值当实际值`, async function () {
      const { j, storage, cb } = await journal();
      let saved = false;
      const item = { value: "Before", creators: structuredClone(creators.before) };
      const port = { getItem: async () => item,
        getField: (i) => { if (saved) throw new Error("unreadable"); return i.value; },
        setField: (i, _f, v) => i.value = v,
        getCreators: (i) => { if (saved) throw new Error("unreadable"); return i.creators; },
        setCreators: (i, v) => i.creators = structuredClone(v), saveItem: async () => { saved = true; },
      };
      const result = await new api.ChangeExecutor(port, bridge(cb)).execute(plan(kind === "field" ? field : creators));
      await j.finalizeBatch("followup", "failed");
      const record = (await new api.BatchJournal(storage).getLatestCompletedBatch()).items[0];
      const entry = kind === "field" ? record.fields[0] : record.creators;
      expect(entry).to.include({ afterUnknown: true, recoveryRequired: true });
      expect(entry.after).not.to.deep.equal(kind === "field" ? field.after : creators.after);
      expect(result.items[0].operations[0].recoveryRequired).to.equal(true);
      const inspect = (await j.getInspectableBatches())[0].items[0].operations[0];
      expect(inspect.afterUnknown).to.equal(true);
      expect(inspect.after).to.equal(undefined);
      expect(inspect.message).to.include("实际值未知");
    });
  }

  it("C2：已经applied的字段若实际值未知，撤销不能把占位值当证明", async function () {
    const { j } = await journal();
    await j.planField("followup", ref.itemKey, { field: "title", before: "Before", after: "Planned" });
    await j.resolveField("followup", ref.itemKey, "title", "applied");
    await j.resolveField("followup", ref.itemKey, "title", "failed", "capture lost", true, undefined, true);
    await j.finalizeBatch("followup", "partial");
    let writes = 0;
    const result = await j.rollbackLatest({ getItem: async () => ({}), getField: () => null,
      setField: () => { writes++; }, saveItem: async () => {} });
    expect(result.conflicts).to.equal(1);
    expect(writes).to.equal(0);
  });

  for (const kind of ["createNote", "createAttachment"]) {
    it(`C1 ${kind}：覆盖创建方法但不提供显式创建证明时不得现算`, function () {
      const child = {};
      let reads = 0;
      const port = new api.DelegatingZoteroMutationPort({ [kind]: async () => child,
        getCreatedItemFingerprint: () => { reads++; return "human-current"; } }, {});
      expect(port.getCreatedItemCreationFingerprint(child)).to.equal(undefined);
      expect(reads).to.equal(0);
    });
  }
  it("C1：无创建证明的直接端口不允许以当前指纹补偿回收", async function () {
    let trashes = 0, reads = 0;
    const events = [];
    const port = { getItem: async () => ({}), createNote: async () => ({ key: "CHILD2" }),
      getCreatedItemKey: (i) => i.key, getCreatedItemFingerprint: () => { reads++; return "human"; },
      trashCreatedItem: async () => { trashes++; } };
    const result = await new api.ChangeExecutor(port, async (e) => { events.push(e); if (e.status === "applied") throw new Error("journal fail"); }).execute(plan(note));
    expect(trashes).to.equal(0);
    expect(reads).to.equal(0);
    expect(result.items[0].operations[0].recoveryRequired).to.equal(true);
    expect(events.find((e) => e.status === "failed").createdItemFingerprint).to.equal(undefined);
  });
  it("C1：显式创建证明正常委托，不能覆盖为当前指纹", function () {
    const port = new api.DelegatingZoteroMutationPort({ createNote: async () => ({}),
      getCreatedItemCreationFingerprint: () => "initial", getCreatedItemFingerprint: () => "human" }, {});
    expect(port.getCreatedItemCreationFingerprint({})).to.equal("initial");
  });

  it("C1：同步版本号变化不伪造内容冲突，文件编辑和人工字段仍受保护", function () {
    let version = 0, noteText = "Upstream", modified = 10;
    const child = { key: "CHILD2", libraryID: 1, parentID: 1,
      isAttachment: () => true, isNote: () => false, getAnnotations: () => [], getFilePath: () => "synthetic.pdf",
      toJSON: () => ({ itemType: "attachment", version, title: "PDF", note: noteText }),
    };
    const originalFile = Zotero.File;
    try {
      Zotero.File = { pathToFile: () => ({ fileSize: 100, lastModifiedTime: modified }) };
      const port = new api.DefaultZoteroMutationPort({});
      const proof = port.getCreatedItemFingerprint(child);
      expect(proof).to.be.a("string");
      version = 99;
      expect(port.getCreatedItemFingerprint(child)).to.equal(proof);
      modified++;
      expect(port.getCreatedItemFingerprint(child)).not.to.equal(proof);
      modified--;
      noteText = "Human";
      expect(port.getCreatedItemFingerprint(child)).not.to.equal(proof);
    } finally { Zotero.File = originalFile; }
  });

  it("C1：指纹格式升级不猜测旧证明，旧v1保留，新v2正常回收", async function () {
    const child = { id: 2, key: "CHILD2", libraryID: 1, parentID: 1,
      isNote: () => true, isAttachment: () => false, toJSON: () => ({ itemType: "note", note: "Upstream", version: 0 }) };
    let trashes = 0, error;
    const port = new api.DefaultZoteroMutationPort({ trashItem: async () => { trashes++; } });
    const proof = port.getCreatedItemFingerprint(child);
    try { await port.trashCreatedItem(child, proof.replace("child-v2:", "child-v1:")); } catch (e) { error = e; }
    expect(error?.code).to.equal("conflict");
    expect(trashes).to.equal(0);
    await port.trashCreatedItem(child, proof);
    expect(trashes).to.equal(1);
  });

  it("C3：交错批次检查面只呈现最近完成终态，与撤销目标一致", async function () {
    const { j } = await journal();
    await j.planField("followup", ref.itemKey, { field: "title", before: "A", after: "B" });
    await j.resolveField("followup", ref.itemKey, "title", "applied");
    await j.startBatch("later-created", [ref]);
    await j.finalizeBatch("later-created", "completed");
    await j.finalizeBatch("followup", "completed");
    expect((await j.getInspectableBatches()).map((b) => b.batchId)).to.deep.equal(["followup"]);
    expect((await j.getLatestUndoableBatch()).batchId).to.equal("followup");
  });
});
