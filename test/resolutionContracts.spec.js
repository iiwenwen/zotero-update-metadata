const { assert, expect } = require("chai");

describe("resolution contracts（固定两路与证据终态）", function () {
  let api;

  before(function () {
    api = Zotero.zmtaAddon?.api;
    assert.isObject(api);
  });

  function candidate(fields) {
    return {
      providerId: "doi-search",
      item: { itemID: 1, itemKey: "ITEM1", libraryID: 1, itemType: "journalArticle", title: "Local" },
      evidence: {
        providerId: "doi-search",
        sourceURL: "https://doi.org/10.1000/example",
        identifiers: [{ type: "doi", value: "10.1000/example" }],
        fetchedAt: "2026-08-30T00:00:00.000Z",
        routeId: "doi.search",
        sourceId: "crossref",
        translator: { id: "translator-1", label: "Crossref" },
      },
      itemType: "journalArticle",
      fields,
      attachments: [],
      notes: [],
    };
  }

  it("路线和 outcome 是固定枚举，不是动态来源 DSL", function () {
    expect(api.ROUTE_IDS).to.deep.equal(["url.web", "doi.search"]);
    expect(api.ATTEMPT_OUTCOMES).to.include.members([
      "candidate",
      "retry-exhausted",
      "identifier-conflict",
      "item-type-conflict",
      "version-ambiguous",
    ]);
    expect(api.classifyAttemptOutcome("candidate")).to.equal("candidate");
    expect(api.classifyAttemptOutcome("no-result")).to.equal("acquisition-failure");
    expect(api.classifyAttemptOutcome("identity-evidence-missing")).to.equal("candidate-rejected");
    assert.isFalse(api.isFallbackAttemptOutcome("identity-evidence-missing"));
    assert.isTrue(api.isBlockingAttemptOutcome("identity-evidence-missing"));
    assert.isTrue(api.isBlockingAttemptOutcome("identifier-conflict"));
    assert.isFalse(api.isFallbackAttemptOutcome("identifier-conflict"));
  });

  it("候选摘要不受对象 key 顺序影响，并能识别候选变化", function () {
    const first = candidate([{ field: "title", value: "New" }, { field: "date", value: "2026" }]);
    const reordered = { itemType: first.itemType, notes: [], attachments: [], fields: first.fields, evidence: first.evidence, item: first.item, providerId: first.providerId };
    expect(api.createCandidateDigest(first)).to.equal(api.createCandidateDigest(reordered));

    const changed = candidate([{ field: "title", value: "Changed" }, { field: "date", value: "2026" }]);
    expect(api.createCandidateDigest(changed)).not.to.equal(api.createCandidateDigest(first));

    const withCreators = {
      ...first,
      creators: [{ firstName: "Ada", lastName: "Lovelace", creatorType: "author" }],
    };
    const reorderedCreators = {
      ...withCreators,
      creators: [{ name: "示例机构", creatorType: "author" }],
    };
    expect(api.createCandidateDigest(withCreators)).not.to.equal(api.createCandidateDigest(first));
    expect(api.createCandidateDigest(reorderedCreators)).not.to.equal(api.createCandidateDigest(withCreators));
  });

  it("旧 SourceEvidence 仍可进入不可变 ChangePlan", function () {
    const plan = api.createChangePlan({
      planId: "legacy",
      createdAt: "2026-08-30T00:00:00.000Z",
      items: [{
        item: candidate([]).item,
        evidence: [{
          providerId: "douban",
          sourceURL: "https://book.douban.com/subject/1/",
          identifiers: [{ type: "douban-subject", value: "1" }],
          fetchedAt: "2026-08-30T00:00:00.000Z",
        }],
        operations: [],
      }],
    });
    expect(plan.items[0].evidence[0]).not.to.have.property("routeId");
  });
});
