const { expect } = require("chai");

describe("交付安全收口F1/F2（生产函数与内存端口，不启动Zotero）", function () {
  let api;
  before(function () { api = { ...Zotero.zmtaAddon.api, ...Zotero.zmtaAddon.testApi }; });
  const url = "https://example.test/closure/1";
  const oldCreators = [{ creatorType: "author", name: "Local Author" }];
  const newCreators = [...oldCreators, { creatorType: "editor", name: "New Editor" }];
  const copy = (value) => structuredClone(value);

  function port() {
    const item = {
      id: 77, key: "CLOSURE1", libraryID: 1, itemType: "book",
      fields: { title: "Local Title", publisher: "Local Press", date: "2025", url, DOI: "", ISBN: "" },
      creators: copy(oldCreators),
      getField(k) { return this.fields[k] ?? ""; },
      getCreatorsJSON() { return copy(this.creators); },
      isRegularItem() { return true; },
    };
    const calls = { saves: 0, fields: 0, creators: 0, attachments: 0, notes: 0 };
    return {
      item, calls, getItem: async () => item,
      getField: (i, k) => i.getField(k),
      setField: (i, k, v) => { calls.fields += 1; i.fields[k] = v; },
      getCreators: (i) => copy(i.creators),
      setCreators: (i, v) => { calls.creators += 1; i.creators = copy(v); },
      saveItem: async () => { calls.saves += 1; },
      createAttachment: async () => { calls.attachments += 1; return { key: "ATT1" }; },
      createNote: async () => { calls.notes += 1; return { key: "NOTE1" }; },
      getCreatedItemKey: (i) => i.key,
      getCreatedItemFingerprint: () => "fixture",
      trashCreatedItem: async () => {}, trashItem: async () => {},
    };
  }

  async function journalFor(p, kind, extraField = false) {
    const journal = new api.BatchJournal(new api.MemoryBatchJournalStorage());
    const ref = { itemID: p.item.id, itemKey: p.item.key, libraryID: 1, title: "Fixture" };
    await journal.startBatch("closure", [ref]);
    if (kind === "field") {
      p.item.fields.title = "After";
      await journal.planField("closure", ref.itemKey, { field: "title", before: "Before", after: "After" });
      await journal.resolveField("closure", ref.itemKey, "title", "applied");
    } else {
      p.item.creators = copy(newCreators);
      await journal.planCreators("closure", ref.itemKey, { before: oldCreators, after: newCreators });
      await journal.resolveCreators("closure", ref.itemKey, "applied");
    }
    if (extraField) {
      await journal.planField("closure", ref.itemKey, { field: "publisher", before: "Before Press", after: "Local Press" });
      await journal.resolveField("closure", ref.itemKey, "publisher", "applied");
    }
    await journal.finalizeBatch("closure", "completed");
    return journal;
  }

  for (const kind of ["field", "creators"]) {
    it(`F1 ${kind}：回退save等待中人工修改且reject，保留人工值并报告冲突`, async function () {
      const p = port();
      const journal = await journalFor(p, kind);
      p.saveItem = async (i) => {
        p.calls.saves += 1;
        await Promise.resolve();
        if (kind === "field") i.fields.title = "Human";
        else i.creators = [{ creatorType: "author", name: "Human" }];
        throw new Error("synthetic rollback save rejection");
      };
      const result = await journal.rollbackLatest(p);
      expect(kind === "field" ? p.item.fields.title : p.item.creators[0].name).to.equal("Human");
      expect(p.calls.saves).to.equal(1);
      expect(result).to.include({ rolledBack: 0, conflicts: 1, failed: 0 });
      expect(result.items[0].operations[0].message).to.include("synthetic rollback save rejection");
    });

    it(`F1 ${kind}：无并发保存失败仍恢复调用前值，不额外保存`, async function () {
      const p = port();
      const journal = await journalFor(p, kind);
      p.saveItem = async () => { p.calls.saves += 1; throw new Error("save rejected"); };
      const result = await journal.rollbackLatest(p);
      expect(kind === "field" ? p.item.fields.title : p.item.creators).to.deep.equal(kind === "field" ? "After" : newCreators);
      expect(p.calls.saves).to.equal(1);
      expect(result).to.include({ rolledBack: 0, conflicts: 0, failed: 1 });
    });
  }

  it("F1：后续字段继续保存时也不会持久化被清理覆盖的人工标题", async function () {
    const p = port();
    const journal = await journalFor(p, "field", true);
    const saved = [];
    p.saveItem = async (i) => {
      if (++p.calls.saves === 1) { await Promise.resolve(); i.fields.title = "Human"; throw new Error("first rejected"); }
      saved.push(copy(i.fields));
    };
    const result = await journal.rollbackLatest(p);
    expect(saved[0]).to.include({ title: "Human", publisher: "Before Press" });
    expect(result).to.include({ rolledBack: 1, conflicts: 1, failed: 0 });
  });

  async function selection(p, kind = "field", returned = {}) {
    // 真正URLRoute→Preview→Apply；Translator只返回fixture，不联网、不仿造宿主Schema。
    const incoming = { itemType: "book", title: "Local Title", date: "2025-01-01", publisher: "Local Press", url, libraryCatalog: "Fixture Catalog",
      abstractNote: "Incoming summary", notes: [{ note: "Fixture note" }],
      attachments: [{ url: "https://example.test/closure/a.pdf", title: "PDF" }], ...returned };
    const route = api.createURLWebRoute({ translator: { translateDetailed: async () => ({ item: incoming, translator: { id: "fixture" } }) } });
    const resolved = await route.attempt({ item: api.snapshotProviderItem(p.item), url, doi: null, attempt: 1 });
    expect(resolved.evidence.outcome).to.equal("candidate");
    const candidate = resolved.candidate;
    const preview = api.candidateToBatchPreview(p.item, candidate, () => "valid");
    return { itemID: p.item.id, itemKey: p.item.key, candidate, candidateDigest: api.createCandidateDigest(candidate),
      routeId: "url.web", identityConfirmed: true,
      fields: kind === "field" ? preview.fields.filter((f) => f.field === "abstractNote") : [],
      creators: kind === "creators" ? { local: copy(oldCreators), incoming: copy(newCreators) } : undefined,
      attachments: kind === "attachment" ? preview.attachments : [],
      notes: kind === "note" ? preview.notes : [],
    };
  }

  for (const kind of ["field", "creators", "attachment", "note"]) {
    it(`F2 ${kind}：planned日志等待后标题改变，旧组合确认不能产生写入`, async function () {
      const p = port();
      const selected = await selection(p, kind);
      const result = await api.applyBatch([selected], { port: p, getItem: p.getItem,
        onOperationStatus: async (e) => { if (e.status === "planned") { await Promise.resolve(); p.item.fields.title = "Another Work"; } },
      });
      expect(p.calls).to.deep.equal({ saves: 0, fields: 0, creators: 0, attachments: 0, notes: 0 });
      expect(result.failed).to.equal(1);
    });
  }

  it("F2：审核后Apply前标题改变，旧确认失效", async function () {
    const p = port();
    const selected = await selection(p);
    p.item.fields.title = "Another Work";
    const result = await api.applyBatch([selected], { port: p, getItem: p.getItem });
    expect(p.calls.saves).to.equal(0);
    expect(result.failed).to.equal(1);
  });

  it("F2：原规则等价的标题格式变化允许，未参与原依据的字段变化允许", async function () {
    const p = port();
    const selected = await selection(p);
    p.item.fields.title = "Ｌｏｃａｌ Title!";
    p.item.fields.language = "zh-CN";
    const result = await api.applyBatch([selected], { port: p, getItem: p.getItem });
    expect(result.applied).to.equal(1);
    expect(p.item.fields.abstractNote).to.equal("Incoming summary");
  });

  for (const kind of ["field", "creators"]) {
    it(`F1 ${kind}：同步规范化后reject可安全恢复，成功时可正常回退`, async function () {
      for (const reject of [true, false]) {
        const p = port();
        const journal = await journalFor(p, kind);
        p.saveItem = async (i) => {
          p.calls.saves += 1;
          if (kind === "field") i.fields.title = "Normalized";
          else i.creators = [{ creatorType: "author", name: "Normalized" }];
          if (reject) throw new Error("normalized rejection");
        };
        const result = await journal.rollbackLatest(p);
        expect(kind === "field" ? p.item.fields.title : p.item.creators).to.deep.equal(reject
          ? kind === "field" ? "After" : newCreators
          : kind === "field" ? "Normalized" : [{ creatorType: "author", name: "Normalized" }]);
        expect(result).to.include({ rolledBack: reject ? 0 : 1, failed: reject ? 1 : 0, conflicts: 0 });
      }
    });

    it(`F1 ${kind}：save成功期间出现人工修改也不能误记回退成功`, async function () {
      const p = port();
      const journal = await journalFor(p, kind);
      p.saveItem = async (i) => {
        await Promise.resolve();
        if (kind === "field") i.fields.title = "Human";
        else i.creators = [{ creatorType: "author", name: "Human" }];
      };
      const result = await journal.rollbackLatest(p);
      expect(result).to.include({ rolledBack: 0, conflicts: 1 });
      expect(kind === "field" ? p.item.fields.title : p.item.creators[0].name).to.equal("Human");
    });
  }

  it("F1：Creator getter返回可变引用时，等待中修改不能污染归因快照", async function () {
    const p = port();
    const journal = await journalFor(p, "creators");
    p.getCreators = (i) => i.creators;
    p.saveItem = async (i) => { await Promise.resolve(); i.creators[0].name = "Human"; throw new Error("rejected"); };
    expect((await journal.rollbackLatest(p)).conflicts).to.equal(1);
    expect(p.item.creators[0].name).to.equal("Human");
  });

  it("F1：save同步调用后无法读取归因值，仍等待save并保留人工值", async function () {
    const p = port();
    const journal = await journalFor(p, "field");
    let capturing = false;
    p.getField = (i, k) => { if (capturing) throw new Error("capture failed"); return i.fields[k]; };
    p.saveItem = async (i) => { capturing = true; await Promise.resolve(); capturing = false; i.fields.title = "Human"; throw new Error("rejected"); };
    const result = await journal.rollbackLatest(p);
    expect(p.item.fields.title).to.equal("Human");
    expect(result.conflicts).to.equal(1);
  });

  for (const [field, value] of [["date", "2026"], ["publisher", "Another Press"]]) {
    it(`F2：原匹配依据${field}变化也使确认失效，不能改用title+URL放行`, async function () {
      const p = port();
      const selected = await selection(p);
      p.item.fields[field] = value;
      expect((await api.applyBatch([selected], { port: p, getItem: p.getItem })).failed).to.equal(1);
      expect(p.calls.saves).to.equal(0);
    });
  }

  for (const [reason, corrupt] of [
    ["缺失", (review) => { delete review.localEvidence; }],
    ["不完整", (review) => { review.localEvidence.pop(); }],
    ["依赖改指其他字段", (review) => { review.localEvidence[0].sourceField = "publisher"; }],
  ]) {
    it(`F2：${reason}的组合依据快照拒绝执行`, async function () {
      const p = port();
      const selected = copy(await selection(p));
      corrupt(selected.candidate.identityReview);
      selected.candidateDigest = api.createCandidateDigest(selected.candidate);
      expect((await api.applyBatch([selected], { port: p, getItem: p.getItem })).failed).to.equal(1);
      expect(p.calls.saves).to.equal(0);
    });
  }

  function withCreatorBasis(selected) {
    // 内存Candidate合同；角色Schema与Translator Creator验证留给既有宿主套件。
    const output = copy(selected);
    output.candidate.identityReview.matchedFields.push("creator");
    output.candidate.identityReview.localEvidence.push({ field: "creator", value: ["localauthor"] });
    output.candidateDigest = api.createCandidateDigest(output.candidate);
    return output;
  }

  it("F2：原Creator依据被人工改变时拒绝；等价名字格式仍允许", async function () {
    for (const [name, expected] of [["Human", "failed"], ["Local-Author!", "applied"]]) {
      const p = port();
      const selected = withCreatorBasis(await selection(p));
      p.item.creators[0].name = name;
      const result = await api.applyBatch([selected], { port: p, getItem: p.getItem });
      expect(result.items[0].status).to.equal(expected);
    }
  });

  for (const changeDuringJournal of [false, true]) {
    it(`F2：本批Creator完整更新后Note${changeDuringJournal ? "被applied日志期间人工变化阻断" : "可继续"}`, async function () {
      const p = port();
      const selected = withCreatorBasis(await selection(p, "creators"));
      selected.notes = [{ content: "Fixture note", batchOperationId: "note:next" }];
      const result = await api.applyBatch([selected], { port: p, getItem: p.getItem,
        onOperationStatus: async (e) => {
          if (changeDuringJournal && e.kind === "creators" && e.status === "applied") {
            await Promise.resolve(); p.item.creators = [{ creatorType: "author", name: "Human" }];
          }
        },
      });
      expect(p.calls.creators).to.equal(1);
      expect(p.calls.notes).to.equal(changeDuringJournal ? 0 : 1);
      expect(result.items[0].status).to.equal(changeDuringJournal ? "partial" : "applied");
    });
  }

  it("F2：本批字段合法格式更新后Note可继续，快照进入digest且不进入journal", async function () {
    const p = port();
    const selected = await selection(p);
    selected.fields.push({ field: "title", local: "Local Title", incoming: "Local-Title!" });
    selected.notes.push({ content: "Fixture note", batchOperationId: "note:next" });
    const digest = api.createCandidateDigest(selected.candidate);
    const changed = copy(selected.candidate);
    changed.identityReview.localEvidence[0].value = "anotherwork";
    expect(api.createCandidateDigest(changed)).not.to.equal(digest);
    const result = await api.applyBatch([selected], { port: p, getItem: p.getItem });
    expect(result.applied).to.equal(1);
    expect(p.calls.notes).to.equal(1);
    const evidence = api.selectionSourceEvidence(selected);
    expect(evidence.identityConfirmation).to.deep.equal({ method: "user-confirmed", matchedFields: selected.candidate.identityReview.matchedFields });
    expect(JSON.stringify(evidence)).not.to.include("localEvidence");
  });

  it("F2：planned回调篡改原Selection不能放宽执行中的组合快照", async function () {
    const p = port();
    const selected = copy(await selection(p));
    const result = await api.applyBatch([selected], { port: p, getItem: p.getItem,
      onOperationStatus: async (e) => {
        if (e.status !== "planned") return;
        p.item.fields.title = "Another Work";
        selected.candidate.identityReview.localEvidence[0].value = "anotherwork";
        selected.candidateDigest = api.createCandidateDigest(selected.candidate);
      },
    });
    expect(result.failed).to.equal(1);
    expect(p.calls.saves).to.equal(0);
  });

  it("F2：重新预检后的本地依据改变不能继承旧确认，未变的旧失败项仍可重试", async function () {
    for (const changed of [false, true]) {
      const p = port();
      const original = await selection(p, "note");
      // 即使旧调用者没存digest，显式的依据比较仍不能缺失。
      delete original.candidateDigest;
      if (changed) p.item.fields.publisher = "New Press";
      const fresh = await selection(p, "note", { publisher: p.item.fields.publisher });
      const previous = { batchId: "retry", total: 1, applied: 0, partial: 0, failed: 1, skipped: 0,
        items: [{ itemID: 77, itemKey: "CLOSURE1", status: "failed", operations: [{ kind: "note", identity: original.notes[0].batchOperationId, status: "failed" }] }] };
      const resolver = { resolve: async () => ({ candidate: fresh.candidate, attempts: [], terminalOutcome: "candidate" }) };
      const result = await api.retryFailedBatch([original], previous, { port: p, getItem: p.getItem, resolver });
      expect(p.calls.notes).to.equal(changed ? 0 : 1);
      expect(result.applied).to.equal(changed ? 0 : 1);
    }
  });

  it("F2：publicationTitle作为原出版依据时不切换为另一个兜底字段", async function () {
    const p = port();
    p.item.getField = (key) => p.item.fields[key];
    p.item.fields.publisher = null;
    p.item.fields.publicationTitle = "Original Journal";
    const selected = await selection(p, "field", { publisher: null, publicationTitle: "Original Journal" });
    const basis = selected.candidate.identityReview.localEvidence.find((entry) => entry.field === "publisher");
    expect(basis).to.include({ sourceField: "publicationTitle", value: "originaljournal" });
    p.item.fields.publicationTitle = "Another Journal";
    p.item.fields.publisher = "Original Journal";
    expect((await api.applyBatch([selected], { port: p, getItem: p.getItem })).failed).to.equal(1);
    expect(p.calls.saves).to.equal(0);
  });

  it("F2：开发Mock的主动DOI身份确认也绑定本地URL，缺URL不能伪造本地依据", async function () {
    const p = port();
    p.item.fields.DOI = "10.5555/closure";
    p.item.fields.extra = "ZMTA-MOCK: identity-review";
    const request = { item: api.snapshotProviderItem(p.item), url, doi: "10.5555/closure" };
    const resolver = api.createMockMetadataResolver();
    const result = await resolver.resolveDOI(request);
    expect(result.candidate.identityReview.localEvidence.find((entry) => entry.field === "url").value).to.equal(url);
    const missing = await resolver.resolveDOI({ ...request, item: { ...request.item, fields: { ...request.item.fields, url: "" } } });
    expect(missing.terminalOutcome).to.equal("blocked");
    expect(missing.candidate).to.equal(null);
  });
});
