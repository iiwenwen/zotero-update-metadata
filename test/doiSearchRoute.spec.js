const { assert, expect } = require("chai");

describe("DOISearchRoute（单次尝试、纯 fake Translator）", function () {
  let api;
  const fetchedAt = "2026-08-30T01:02:03.000Z";

  before(function () {
    api = { ...Zotero.zmtaAddon?.api, ...Zotero.zmtaAddon?.testApi };
    assert.isFunction(api?.createDOISearchRoute, "应暴露 DOI Search route 测试入口");
  });

  function item(itemType = "journalArticle", fields = {}) {
    return {
      itemID: 7,
      itemKey: "ITEM7",
      libraryID: 1,
      itemType,
      title: "Local title",
      fields: { DOI: "10.1000/example", ...fields },
    };
  }

  function translation(overrides = {}) {
    return {
      item: {
        itemType: "journalArticle",
        DOI: "10.1000/EXAMPLE",
        title: "Translated title",
        creators: [{ creatorType: "author", firstName: "A", lastName: "Author" }],
        tags: [{ tag: "Ignored" }],
        relations: { ignored: true },
        attachments: [{ url: "https://example.test/full.pdf", title: "PDF", mimeType: "application/pdf" }],
        notes: [{ note: "candidate note" }],
        libraryCatalog: "Crossref",
        ...overrides,
      },
      translator: { id: "translator-1", label: "Crossref", updatedAt: "2026-08-01", zoteroVersion: "8.0" },
      sourceId: "Crossref",
    };
  }

  function route(result = translation()) {
    const calls = [];
    return {
      calls,
      value: api.createDOISearchRoute({
        translator: {
          async translateDOI(doi) {
            calls.push(doi);
            if (result instanceof Error) throw result;
            return result;
          },
        },
        now: () => new Date(fetchedAt),
      }),
    };
  }

  function request(local = item(), overrides = {}) {
    return { item: local, url: null, doi: "10.1000/example", attempt: 1, ...overrides };
  }

  it("保留 Translator itemType，过滤非字段结构，并只形成附件与 Note 候选", async function () {
    const fixture = route();
    const result = await fixture.value.attempt(request());

    expect(fixture.calls).to.deep.equal(["10.1000/example"]);
    expect(result.candidate.itemType).to.equal("journalArticle");
    expect(result.candidate.fields.map((entry) => entry.field)).to.include.members([
      "DOI", "libraryCatalog", "title",
    ]);
    expect(result.candidate.fields.map((entry) => entry.field)).not.to.include.members([
      "itemType", "creators", "tags", "relations", "attachments", "notes",
    ]);
    expect(result.candidate.creators).to.deep.equal([
      { creatorType: "author", firstName: "A", lastName: "Author" },
    ]);
    expect(result.candidate.attachments).to.have.length(1);
    expect(result.candidate.notes).to.have.length(1);
    expect(result.candidate.evidence).to.include({
      providerId: "zotero-search",
      routeId: "doi.search",
      sourceId: "Crossref",
      fetchedAt,
    });
    expect(result.evidence).to.include({ routeId: "doi.search", outcome: "candidate", attempt: 1 });
    expect(result.evidence.returnedIdentifiers).to.deep.equal([{ type: "doi", value: "10.1000/EXAMPLE" }]);
    expect(result.evidence.candidateDigest).to.match(/^fnv1a:[0-9a-f]{8}$/);
  });

  it("不按 DOI 猜类型，dataset、bookSection、preprint 仅在本地类型完全一致时通过", async function () {
    for (const itemType of ["dataset", "bookSection", "preprint"]) {
      const fixture = route(translation({ itemType }));
      const result = await fixture.value.attempt(request(item(itemType)));
      expect(result.candidate?.itemType).to.equal(itemType);
      expect(result.evidence.outcome).to.equal("candidate");
    }
  });

  it("DOI 缺失、不回显和不一致分别 fail closed", async function () {
    const invalidFixture = route();
    const invalid = await invalidFixture.value.attempt(request(item(), { doi: "not-a-doi" }));
    expect(invalid.evidence.outcome).to.equal("identity-evidence-missing");
    expect(invalidFixture.calls).to.deep.equal([]);

    const missing = await route(translation({ DOI: undefined })).value.attempt(request());
    expect(missing.evidence.outcome).to.equal("identity-evidence-missing");

    const conflict = await route(translation({ DOI: "10.1000/other" })).value.attempt(request());
    expect(conflict.evidence.outcome).to.equal("identifier-conflict");
  });

  it("类型、edition/version 与 unknown 来源阻断，不产生候选", async function () {
    const typeConflict = await route(translation({ itemType: "preprint" })).value.attempt(request());
    expect(typeConflict.candidate).to.equal(null);
    expect(typeConflict.evidence.outcome).to.equal("item-type-conflict");

    const versionConflict = await route(translation({ edition: "2" })).value.attempt(request(item("journalArticle", { edition: "1" })));
    expect(versionConflict.evidence.outcome).to.equal("version-ambiguous");

    const unknown = translation();
    unknown.item.libraryCatalog = undefined;
    unknown.translator = {};
    unknown.sourceId = "unknown";
    const sourceUnknown = await route(unknown).value.attempt(request());
    expect(sourceUnknown.candidate).to.equal(null);
    expect(sourceUnknown.evidence).to.include({ outcome: "identity-evidence-missing", sourceId: "unknown", errorCode: "source-unknown" });
  });

  it("零／多结果等 adapter 错误被保留为单条 attempt evidence", async function () {
    const cases = [
      ["translator-missing", "unsupported", false],
      ["no-result", "no-result", false],
      ["multiple-results", "multiple-results", false],
      ["fetch-failed", "fetch-failed", true],
      ["invalid-response", "invalid-response", false],
    ];
    for (const [code, outcome, retryable] of cases) {
      const error = new Error(code);
      error.name = "SearchTranslatorError";
      error.code = code;
      error.retryable = retryable;
      const result = await route(error).value.attempt(request());
      expect(result.candidate).to.equal(null);
      expect(result.evidence.outcome).to.equal(outcome);
      expect(result.evidence.errorCode).to.equal(code);
      expect(result.retryable).to.equal(retryable);
    }
  });

  it("Creator 保留有序完整列表；空列表省略，非法结构或角色拒绝候选", async function () {
    const creators = [
      { creatorType: "author", name: "示例实验室" },
      { creatorType: "author", firstName: "A", lastName: "Author" },
      { creatorType: "editor", firstName: "E", lastName: "Editor" },
      { creatorType: "translator", firstName: "A", lastName: "Author" },
    ];
    const valid = await route(translation({ creators })).value.attempt(request());
    expect(valid.candidate.creators).to.deep.equal(creators);

    const empty = await route(translation({ creators: [] })).value.attempt(request());
    expect(empty.candidate).not.to.have.property("creators");

    for (const invalidCreators of [
      "not-a-list",
      [{ creatorType: "author" }],
      [{ creatorType: "not-a-zotero-role", name: "机构" }],
    ]) {
      const invalid = await route(translation({ creators: invalidCreators })).value.attempt(request());
      expect(invalid.candidate).to.equal(null);
      expect(invalid.evidence).to.include({ outcome: "invalid-response", errorCode: "invalid-creators" });
    }
  });
});
