const { assert, expect } = require("chai");

describe("异步写入边界（独立核验R1/R2回归）", function () {
  let api;
  before(function () { api = { ...Zotero.zmtaAddon.api, ...Zotero.zmtaAddon.testApi }; });
  const ref = { itemID: 1, itemKey: "ASYNC1", libraryID: 1, itemType: "book", title: "Fixture" };
  const url = "https://example.test/async/1";
  const oldISBN = "9780262033848";
  const newISBN = "9780140328721";
  function fakePort() {
    const item = { id: 1, key: ref.itemKey, libraryID: 1, itemType: "book",
      fields: { title: "old", publisher: "", ISBN: oldISBN, url },
      creators: [{ creatorType: "author", name: "before" }],
      isRegularItem() { return true; }, getField(k) { return this.fields[k] ?? ""; },
      getCreatorsJSON() { return structuredClone(this.creators); },
    };
    const counts = { saves: 0, creators: 0, attachments: 0, notes: 0, trash: 0 };
    return { item, counts, getItem: async () => item,
      getField: (i, k) => i.getField(k), setField: (i, k, v) => { i.fields[k] = v; },
      getCreators: (i) => structuredClone(i.creators),
      setCreators: (i, v) => { counts.creators += 1; i.creators = structuredClone(v); },
      saveItem: async () => { counts.saves += 1; },
      createAttachment: async () => { counts.attachments += 1; return { key: "ATT1" }; },
      createNote: async () => { counts.notes += 1; return { key: "NOTE1" }; },
      getCreatedItemKey: (child) => child.key, getCreatedItemFingerprint: () => "unchanged",
      getCreatedItemCreationFingerprint: () => "unchanged",
      trashCreatedItem: async () => { counts.trash += 1; },
    };
  }
  function plan(operations) {
    return api.createChangePlan({ planId: "async-boundary", createdAt: "2026-10-27T00:00:00Z", items: [{ item: ref,
      evidence: [{ providerId: "fixture", sourceURL: url, identifiers: [{ type: "isbn", value: oldISBN }], fetchedAt: "2026-10-27T00:00:00Z" }], operations,
    }] });
  }
  const field = { kind: "field-set", operationId: "field:title", field: "title", before: "old", after: "incoming" };
  const creators = { kind: "creators-set", operationId: "creators:set", before: [{ creatorType: "author", name: "before" }], after: [{ creatorType: "author", name: "incoming" }] };

  for (const kind of ["field", "creators"]) {
    it(`R1 ${kind}：save promise返回前的人工作品不被归因为actualAfter或补偿覆盖`, async function () {
      const port = fakePort();
      port.saveItem = async (item) => {
        if (++port.counts.saves === 1) {
          await Promise.resolve();
          if (kind === "field") item.fields.title = "human-during-save";
          else item.creators = [{ creatorType: "author", name: "human-during-save" }];
        }
      };
      const events = [];
      const result = await new api.ChangeExecutor(port, async (event) => {
        events.push(event);
        if (event.status === "applied") throw new Error("synthetic applied journal failure");
      }).execute(plan([kind === "field" ? field : creators]));
      expect(kind === "field" ? port.item.fields.title : port.item.creators[0].name).to.equal("human-during-save");
      expect(port.counts.saves).to.equal(1);
      expect(result.items[0].status).to.equal("failed");
      expect(events.filter((entry) => entry.status === "applied")).to.have.length(0);
      expect(JSON.stringify(events.map((entry) => entry.actualAfter))).not.to.include("human-during-save");
    });
  }
  for (const kind of ["field", "creators"]) {
    it(`R1 ${kind}：同步宿主规范化仍写实际值，无并发日志失败可正常补偿`, async function () {
      const port = fakePort();
      port.saveItem = async (item) => {
        if (++port.counts.saves === 1) {
          if (kind === "field") item.fields.title = "canonical";
          else item.creators = [{ creatorType: "author", name: "canonical" }];
        }
      };
      const events = [];
      const result = await new api.ChangeExecutor(port, async (event) => {
        events.push(event);
        if (event.status === "applied") throw new Error("journal failure");
      }).execute(plan([kind === "field" ? field : creators]));
      const applied = events.find((entry) => entry.status === "applied");
      expect(kind === "field" ? applied.actualAfter : applied.actualAfter[0].name).to.equal("canonical");
      expect(kind === "field" ? port.item.fields.title : port.item.creators[0].name).to.equal(kind === "field" ? "old" : "before");
      expect(port.counts.saves).to.equal(2);
      expect(result.items[0].operations[0].message).not.to.include("compensation-failed");
    });
  }
  it("R1：只在await后出现的规范化无法归因，同样保守保留而不盲目恢复", async function () {
    const port = fakePort();
    port.saveItem = async (item) => { port.counts.saves += 1; await Promise.resolve(); item.fields.title = "async-canonical-or-human"; };
    const result = await new api.ChangeExecutor(port).execute(plan([field]));
    expect(port.item.fields.title).to.equal("async-canonical-or-human");
    expect(port.counts.saves).to.equal(1);
    expect(result.items[0].status).to.equal("failed");
  });
  function selection(port, includeISBN = false) {
    const candidate = { providerId: "url-web", item: ref, itemType: "book",
      evidence: { providerId: "url-web", sourceURL: url, identifiers: [{ type: "isbn", value: oldISBN }], fetchedAt: "2026-10-27T00:00:00Z", routeId: "url.web" },
      localIdentifiers: [{ type: "isbn", value: oldISBN }],
      fields: [{ field: "publisher", value: "Source A" }, ...(includeISBN ? [{ field: "ISBN", value: `${oldISBN} ${newISBN}` }] : [])],
      attachments: [], notes: includeISBN ? [{ content: "fixture note" }] : [],
    };
    const preview = api.candidateToBatchPreview(port.item, candidate, () => "valid");
    return { itemID: 1, itemKey: ref.itemKey, fields: preview.fields, attachments: [], notes: preview.notes, candidate,
      candidateDigest: api.createCandidateDigest(candidate), routeId: "url.web" };
  }
  it("R2：生产Apply在planned日志await后再次核对ISBN，未选ISBN也零写入", async function () {
    const port = fakePort();
    const result = await api.applyBatch([selection(port)], { getItem: async () => port.item, port,
      onOperationStatus: async (event) => { if (event.status === "planned") { await Promise.resolve(); port.item.fields.ISBN = newISBN; } },
    });
    expect(port.item.fields.publisher).to.equal("");
    expect(port.counts.saves).to.equal(0);
    expect(result.items[0].status).to.equal("failed");
  });
  it("R2：planned期间只改ISBN格式仍允许正常写入", async function () {
    const port = fakePort();
    const result = await api.applyBatch([selection(port)], { getItem: async () => port.item, port,
      onOperationStatus: async (event) => { if (event.status === "planned") port.item.fields.ISBN = "978-0-262-03384-8"; },
    });
    expect(port.item.fields.publisher).to.equal("Source A");
    expect(result.applied).to.equal(1);
  });
  it("R2：日志回调修改原审核对象不能同步篡改执行中的身份快照", async function () {
    const port = fakePort();
    const selected = selection(port);
    const result = await api.applyBatch([selected], { getItem: async () => port.item, port,
      onOperationStatus: async (event) => {
        if (event.status !== "planned") return;
        port.item.fields.ISBN = newISBN;
        selected.candidate.evidence.identifiers = [{ type: "isbn", value: newISBN }];
        selected.candidate.localIdentifiers = [{ type: "isbn", value: newISBN }];
        selected.candidateDigest = api.createCandidateDigest(selected.candidate);
      },
    });
    expect(port.counts.saves).to.equal(0);
    expect(result.failed).to.equal(1);
  });
  for (const operation of [creators,
    { kind: "attachment-create", operationId: "attachment:1", attachment: { title: "PDF", url: "https://example.test/1.pdf", mimeType: "application/pdf" } },
    { kind: "note-create", operationId: "note:1", content: "fixture note" },
  ]) {
    it(`R2 ${operation.kind}：共同写入边界在planned之后复核，不仅字段受保护`, async function () {
      const port = fakePort();
      const result = await new api.ChangeExecutor(port, async (event) => {
        if (event.status === "planned") { await Promise.resolve(); port.item.fields.ISBN = newISBN; }
      }, (_ref, item) => { if (item.fields.ISBN !== oldISBN) throw new Error("ISBN changed"); }).execute(plan([operation]));
      expect(port.counts).to.include({ saves: 0, creators: 0, attachments: 0, notes: 0 });
      expect(result.items[0].status).to.equal("failed");
    });
  }
  it("R2：本批已确认写入的ISBN扩展可用于后续Note，不能误报自己的写入", async function () {
    const port = fakePort();
    const result = await api.applyBatch([selection(port, true)], { getItem: async () => port.item, port });
    expect(port.counts.notes).to.equal(1);
    expect(result.applied).to.equal(1);
  });
  it("R2：自己的ISBN写入日志等待期间再被人工修改，后续Note仍被阻断", async function () {
    const port = fakePort();
    const result = await api.applyBatch([selection(port, true)], { getItem: async () => port.item, port,
      onOperationStatus: async (event) => {
        if (event.status === "applied" && event.identity === "ISBN") { await Promise.resolve(); port.item.fields.ISBN = newISBN; }
      },
    });
    expect(port.item.fields.ISBN).to.equal(newISBN);
    expect(port.counts.notes).to.equal(0);
    expect(result.items[0].status).to.equal("partial");
  });
  it("R2：异步子项创建期间ISBN变化，保留人工ISBN并补偿未编辑新建项", async function () {
    const port = fakePort();
    port.createNote = async () => { port.counts.notes += 1; await Promise.resolve(); port.item.fields.ISBN = newISBN; return { key: "NOTE1" }; };
    const result = await new api.ChangeExecutor(port, undefined,
      (_ref, item) => { if (item.fields.ISBN !== oldISBN) throw new Error("ISBN changed"); },
    ).execute(plan([{ kind: "note-create", operationId: "note:1", content: "fixture note" }]));
    expect(port.item.fields.ISBN).to.equal(newISBN);
    expect(port.counts.trash).to.equal(1);
    expect(result.items[0].status).to.equal("failed");
  });
});
