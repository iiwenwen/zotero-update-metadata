const { assert, expect } = require("chai");

describe("DOI fallback 批量链路集成（纯 fake，不联网不写真实库）", function () {
  let api;

  before(function () {
    api = { ...Zotero.zmtaAddon?.api, ...Zotero.zmtaAddon?.testApi };
    assert.isFunction(api.preflightBatch);
    assert.isFunction(api.preflightDOIBatch);
    assert.isFunction(api.applyBatch);
    assert.isFunction(api.retryFailedBatch);
  });

  function item(overrides = {}) {
    const fields = {
      title: "本地标题",
      publisher: "",
      DOI: "10.1000/example",
      url: "",
      ...(overrides.fields || {}),
    };
    const counters = { set: 0, save: 0 };
    return {
      id: 31,
      key: "ITEM31",
      libraryID: 1,
      itemType: "journalArticle",
      fields,
      counters,
      isNote: () => false,
      isAttachment: () => false,
      getField: (field) => fields[field] ?? "",
      setField: (field, value) => { counters.set += 1; fields[field] = value; },
      saveTx: async () => { counters.save += 1; },
      ...overrides,
    };
  }

  function candidate(local, routeId = "doi.search", overrides = {}) {
    const sourceURL = routeId === "doi.search"
      ? "https://doi.org/10.1000/example"
      : "https://example.test/article";
    return {
      providerId: routeId === "doi.search" ? "zotero-search" : "url-web",
      item: {
        itemID: local.id,
        itemKey: local.key,
        libraryID: local.libraryID,
        itemType: local.itemType,
        title: local.fields.title,
      },
      evidence: {
        providerId: routeId === "doi.search" ? "zotero-search" : "url-web",
        sourceURL,
        identifiers: [{ type: "doi", value: "10.1000/example" }],
        fetchedAt: "2026-08-30T00:00:00.000Z",
        routeId,
        sourceId: "fixture-source",
        translator: { id: "fixture-translator", label: "Fixture" },
      },
      itemType: local.itemType,
      fields: [{ field: "publisher", value: "上游出版社" }],
      attachments: [],
      notes: [],
      ...overrides,
    };
  }

  function resolverFor(value) {
    const resolve = async () => {
        const digest = api.createCandidateDigest(value);
        return {
          candidate: value,
          terminalOutcome: "candidate",
          attempts: [{
            routeId: value.evidence.routeId,
            attempt: 1,
            inputIdentifiers: [{ type: "doi", value: "10.1000/example" }],
            returnedIdentifiers: [{ type: "doi", value: "10.1000/example" }],
            sourceId: value.evidence.sourceId,
            fetchedAt: value.evidence.fetchedAt,
            outcome: "candidate",
            candidateDigest: digest,
          }],
        };
    };
    return {
      resolve,
      resolveDOI: resolve,
    };
  }

  it("主动 DOI 预检只调用明确的 DOI 入口，不把模式写入 Preview", async function () {
    const local = item({ fields: { url: "https://example.test/article" } });
    const calls = [];
    const value = candidate(local, "doi.search");
    const base = resolverFor(value);
    const preview = (await api.preflightDOIBatch([local], {
      resolver: {
        resolve: async () => { calls.push("automatic"); return base.resolve(); },
        resolveDOI: async () => { calls.push("doi"); return base.resolveDOI(); },
      },
    }))[0];

    expect(calls).to.deep.equal(["doi"]);
    expect(preview.routeId).to.equal("doi.search");
    expect(preview).not.to.have.property("routeMode");
  });

  function selectionFrom(preview) {
    return {
      itemID: preview.itemID,
      itemKey: preview.itemKey,
      fields: preview.fields,
      attachments: preview.attachments,
      notes: preview.notes,
      candidate: preview.candidate,
      attempts: preview.attempts,
      candidateDigest: preview.candidateDigest,
      routeId: preview.routeId,
      normalizedDOI: preview.normalizedDOI,
    };
  }

  it("无 URL + DOI 候选复用 Preview→ChangePlan→Executor，确认前零写入", async function () {
    const local = item();
    const preview = (await api.preflightBatch([local], {
      resolver: resolverFor(candidate(local)),
    }))[0];

    expect(preview).to.include({ status: "ready", routeId: "doi.search", normalizedDOI: "10.1000/example" });
    expect(preview.attempts).to.have.length(1);
    expect(local.counters).to.deep.equal({ set: 0, save: 0 });

    const result = await api.applyBatch([selectionFrom(preview)], { getItem: () => local });
    expect(result.items[0].status).to.equal("applied");
    expect(local.fields.publisher).to.equal("上游出版社");
    expect(local.counters).to.deep.equal({ set: 1, save: 1 });
  });

  it("Translator 类型与本地不一致时只能显示阻断，不产生勾选项", async function () {
    const local = item();
    const mismatched = candidate(local, "doi.search", { itemType: "dataset" });
    const preview = (await api.preflightBatch([local], { resolver: resolverFor(mismatched) }))[0];

    expect(preview.status).to.equal("blocked");
    expect(preview.message).to.include("类型不一致");
    expect(preview.fields).to.deep.equal([]);
    expect(local.counters).to.deep.equal({ set: 0, save: 0 });
  });

  it("Web 来源 URL 使用统一规范化比较，不因等价尾斜杠误拒绝", async function () {
    const local = item();
    local.fields.url = "https://example.test";
    const webCandidate = candidate(local, "url.web");
    webCandidate.evidence.sourceURL = "https://example.test/";
    const preview = (await api.preflightBatch([local], {
      resolver: resolverFor(webCandidate),
    }))[0];
    const result = await api.applyBatch([selectionFrom(preview)], { getItem: () => local });

    expect(result.items[0].status).to.equal("applied");
    expect(local.fields.publisher).to.equal("上游出版社");
  });

  it("失败项重试若路线或候选摘要变化则不自动接纳", async function () {
    const local = item();
    const originalPreview = (await api.preflightBatch([local], {
      resolver: resolverFor(candidate(local, "doi.search")),
    }))[0];
    const original = selectionFrom(originalPreview);
    const previous = {
      batchId: "previous",
      total: 1,
      applied: 0,
      partial: 0,
      skipped: 0,
      failed: 1,
      items: [{
        itemID: local.id,
        itemKey: local.key,
        title: local.fields.title,
        status: "failed",
        operations: [{ kind: "field", identity: "publisher", status: "failed" }],
      }],
    };
    const changedRoute = candidate(local, "url.web");
    const calls = [];
    const changedResolver = resolverFor(changedRoute);
    const retried = await api.retryFailedBatch([original], previous, {
      getItem: () => local,
      resolver: {
        resolve: async () => { calls.push("automatic"); return changedResolver.resolve(); },
        resolveDOI: async () => { calls.push("doi"); return changedResolver.resolveDOI(); },
      },
    });

    expect(calls).to.deep.equal(["doi"], "重试应从原候选实际 routeId 推导路线");
    expect(retried.total).to.equal(0);
    expect(local.counters).to.deep.equal({ set: 0, save: 0 });
  });
});
