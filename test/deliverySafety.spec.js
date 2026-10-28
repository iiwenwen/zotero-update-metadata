const { assert, expect } = require("chai");

describe("交付数据安全回归（审计S1/S2/S3，纯内存）", function () {
  let api;
  before(function () { api = { ...Zotero.zmtaAddon.api, ...Zotero.zmtaAddon.testApi }; });
  const ref = { itemID: 1, itemKey: "SAFE1", libraryID: 1, itemType: "book", title: "合成数据" };
  function plan(operations) {
    return api.createChangePlan({ planId: "safe", createdAt: "2026-10-27T00:00:00Z", items: [{
      item: ref, evidence: [{ providerId: "fixture", sourceURL: "https://example.test/1", identifiers: [{ type: "url", value: "https://example.test/1" }], fetchedAt: "2026-10-27T00:00:00Z" }], operations,
    }] });
  }
  function port(fields = {}) {
    const item = { fields: { ...fields }, creators: [{ creatorType: "author", name: "Before" }] };
    let saves = 0;
    return { item, get saves() { return saves; },
      getItem: async () => item, getField: (i, k) => i.fields[k] ?? "", setField: (i, k, v) => { i.fields[k] = v; },
      getCreators: (i) => structuredClone(i.creators), setCreators: (i, v) => { i.creators = structuredClone(v); },
      saveItem: async () => { saves += 1; },
    };
  }
  const field = (name, before, after) => ({ kind: "field-set", operationId: `field:${name}`, field: name, before, after });

  it("S1a：其他字段失败日志等待期间的人工作品在最终写前复核被保留", async function () {
    const fake = port({ title: "old", publisher: "manual" });
    const result = await new api.ChangeExecutor(fake, async (event) => {
      if (event.status === "failed" && event.operation.field === "publisher") {
        await Promise.resolve(); fake.item.fields.title = "human-later";
      }
    }).execute(plan([field("title", "old", "incoming"), field("publisher", "old", "incoming")]));
    expect(fake.item.fields.title).to.equal("human-later");
    expect(fake.saves).to.equal(0);
    expect(result.items[0].operations.every((entry) => entry.status === "failed")).to.equal(true);
  });
  it("S1b：applied日志失败后的字段补偿不覆盖人工后改", async function () {
    const fake = port({ title: "old" });
    const result = await new api.ChangeExecutor(fake, async (event) => {
      if (event.status === "applied") { fake.item.fields.title = "human-after"; throw new Error("journal unavailable"); }
    }).execute(plan([field("title", "old", "incoming")]));
    expect(fake.item.fields.title).to.equal("human-after");
    expect(fake.saves).to.equal(1);
    expect(result.items[0].operations[0].message).to.include("compensation-failed");
  });
  it("S1同源：Creator日志失败补偿同样保留人工后改名单", async function () {
    const fake = port();
    const before = structuredClone(fake.item.creators);
    const result = await new api.ChangeExecutor(fake, async (event) => {
      if (event.status === "applied") { fake.item.creators = [{ creatorType: "author", name: "Human" }]; throw new Error("journal unavailable"); }
    }).execute(plan([{ kind: "creators-set", operationId: "creators:list", before, after: [{ creatorType: "author", name: "Incoming" }] }]));
    expect(fake.item.creators[0].name).to.equal("Human");
    expect(result.items[0].operations[0].message).to.include("compensation-failed");
  });
  function child(kind = "note") {
    return {
      id: 2, key: "CHILD2", libraryID: 1, parentID: 1, content: "new note", annotations: [],
      isNote() { return kind === "note"; }, isAttachment() { return kind === "attachment"; },
      getAnnotations() { return this.annotations; }, getFilePath() { return false; },
      toJSON() { return { itemType: kind, note: this.content }; },
    };
  }
  async function childJournal(fingerprint) {
    const journal = new api.BatchJournal(new api.MemoryBatchJournalStorage());
    await journal.startBatch("child-safe", [ref]);
    await journal.planCreatedItem("child-safe", ref.itemKey, { kind: "note", operationId: "note:1" });
    await journal.resolveCreatedItem("child-safe", ref.itemKey, "note:1", "applied", "CHILD2", undefined, false, fingerprint);
    await journal.finalizeBatch("child-safe", "completed");
    return journal;
  }
  it("S2：创建状态摘要不含Note正文，编辑或换父后回滚标记冲突", async function () {
    for (const mutate of [(i) => { i.content = "human edited"; }, (i) => { i.parentID = 99; }]) {
      const item = child();
      const port = new api.DefaultZoteroMutationPort({});
      const fp = port.getCreatedItemFingerprint(item);
      expect(fp).to.be.a("string").and.not.include(item.content);
      const journal = await childJournal(fp);
      mutate(item);
      let trashes = 0;
      const result = await journal.rollbackLatest({ getItem: async () => item,
        getCreatedItemFingerprint: (i) => port.getCreatedItemFingerprint(i), trashItem: async () => { trashes += 1; },
      });
      expect(result.conflicts).to.equal(1);
      expect(trashes).to.equal(0);
    }
  });
  it("S2：附件新增或编辑标注会改变摘要，缺少状态的旧日志一律保留子项", async function () {
    const item = child("attachment");
    const port = new api.DefaultZoteroMutationPort({});
    const fp = port.getCreatedItemFingerprint(item);
    item.annotations.push({ toJSON: () => ({ annotationComment: "human note" }) });
    expect(port.getCreatedItemFingerprint(item)).not.to.equal(fp);
    const journal = await childJournal(undefined);
    let trashes = 0;
    const result = await journal.rollbackLatest({ getItem: async () => item,
      getCreatedItemFingerprint: () => fp, trashItem: async () => { trashes += 1; },
    });
    expect(result.conflicts).to.equal(1);
    expect(trashes).to.equal(0);
  });
  it("S2：未改子项可回收；真实端口在回收前再次核对状态", async function () {
    const item = child();
    let trashes = 0;
    const port = new api.DefaultZoteroMutationPort({ trashItem: async () => { trashes += 1; } });
    const fp = port.getCreatedItemFingerprint(item);
    const journal = await childJournal(fp);
    const result = await journal.rollbackLatest({ getItem: async () => item,
      getCreatedItemFingerprint: (i) => port.getCreatedItemFingerprint(i),
      trashItem: async (_library, _key, expected) => port.trashCreatedItem(item, expected),
    });
    expect(result.rolledBack).to.equal(1);
    expect(trashes).to.equal(1);
    item.content = "human-later";
    try { await port.trashCreatedItem(item, fp); assert.fail("应拒绝"); }
    catch (error) { expect(error.code).to.equal("conflict"); }
    expect(trashes).to.equal(1);
  });
  it("S2：journal事件桥接保存状态摘要，正文不进入创建记录", async function () {
    const journal = new api.BatchJournal(new api.MemoryBatchJournalStorage());
    await journal.startBatch("bridge", [ref]);
    const callback = api.createJournalCallback(journal);
    const base = { batchId: "bridge", itemID: 1, itemKey: ref.itemKey, kind: "note", identity: "note:bridge" };
    await callback({ ...base, status: "planned" });
    await callback({ ...base, status: "applied", createdItemKey: "CHILD2", createdItemFingerprint: "fixture-digest" });
    const record = await journal.finalizeBatch("bridge", "completed");
    expect(record.items[0].createdItems[0].fingerprint).to.equal("fixture-digest");
    expect(record.items[0].createdItems[0]).not.to.have.property("content");
  });
  it("S3：未选择更新ISBN，也必须在Apply核对来源ISBN，变化则零写入", async function () {
    const item = {
      id: 1, key: ref.itemKey, libraryID: 1, itemType: "book", isRegularItem: () => true,
      getField: (k) => ({ ISBN: "9780140328721", url: "https://example.test/1", publisher: "" })[k] || "",
    };
    const candidate = { providerId: "url-web", item: ref, itemType: "book",
      evidence: { providerId: "url-web", sourceURL: "https://example.test/1", identifiers: [{ type: "isbn", value: "9780262033848" }], fetchedAt: "2026-10-27T00:00:00Z", routeId: "url.web" },
      fields: [{ field: "publisher", value: "Incoming" }], attachments: [], notes: [],
    };
    let saves = 0;
    const selection = { itemID: 1, itemKey: ref.itemKey, candidate,
      fields: [{ field: "publisher", local: "", incoming: "Incoming" }], attachments: [], notes: [],
    };
    const result = await api.applyBatch([selection], { getItem: async () => item,
      port: { saveItem: async () => { saves += 1; } },
    });
    expect(saves).to.equal(0);
    expect(result.items[0].status).to.equal("failed");
    expect(result.items[0].message).to.include("ISBN");
  });
  it("S3：上游同时含两个ISBN时仍冻结原本地ISBN，不放行改成另一个版本", async function () {
    const fields = { title: "Fixture", ISBN: "9780262033848", url: "https://example.test/1", publisher: "" };
    const route = api.createURLWebRoute({ translator: { translateDetailed: async () => ({ item: {
      ...fields, itemType: "book", ISBN: "9780262033848 9780140328721", libraryCatalog: "Fixture", publisher: "Incoming",
    } }) } });
    const resolved = await route.attempt({ item: { ...ref, fields: { ...fields } }, url: fields.url, doi: null, attempt: 1 });
    expect(resolved.candidate.localIdentifiers).to.deep.equal([{ type: "isbn", value: "9780262033848" }]);
    fields.ISBN = "9780140328721";
    const item = { id: 1, key: ref.itemKey, libraryID: 1, itemType: "book", isRegularItem: () => true, getField: (k) => fields[k] || "" };
    const result = await api.applyBatch([{ itemID: 1, itemKey: ref.itemKey, candidate: resolved.candidate,
      fields: [{ field: "publisher", local: "", incoming: "Incoming" }], attachments: [], notes: [],
    }], { getItem: async () => item });
    expect(result.items[0].status).to.equal("failed");
    expect(result.items[0].message).to.include("ISBN");
  });
});
