const { assert, expect } = require("chai");

describe("URLWebRoute（纯 fixture，不联网）", function () {
  let api;

  before(function () {
    api = { ...Zotero.zmtaAddon?.api, ...Zotero.zmtaAddon?.testApi };
    assert.isFunction(api?.createURLWebRoute, "应暴露通用 URL Web route 测试入口");
  });

  function item(overrides = {}) {
    return {
      itemID: 17,
      itemKey: "ITEM0017",
      libraryID: 1,
      itemType: "journalArticle",
      title: "本地标题",
      fields: {
        title: "本地标题",
        DOI: "10.1000/EXAMPLE",
        url: "https://example.test/article",
        edition: "",
        version: "",
        ...(overrides.fields || {}),
      },
      ...overrides,
    };
  }

  function request(overrides = {}) {
    return {
      item: item(),
      url: "https://example.test/article",
      doi: "10.1000/example",
      attempt: 1,
      ...overrides,
    };
  }

  function translatedItem(overrides = {}) {
    return {
      itemType: "journalArticle",
      title: "上游标题",
      DOI: "https://doi.org/10.1000/EXAMPLE",
      libraryCatalog: "Example Catalog",
      creators: [{ creatorType: "author", firstName: "A", lastName: "B" }],
      tags: [{ tag: "ignored" }],
      relations: { ignored: true },
      attachments: [{ url: "https://example.test/a.pdf", title: "PDF" }],
      notes: [{ note: "候选 Note" }],
      ...overrides,
    };
  }

  function fakeTranslator(result = translatedItem()) {
    const calls = [];
    return {
      calls,
      async translate(url) { calls.push(url); return result; },
      async translateDetailed(url) {
        calls.push(url);
        return {
          item: result,
          translator: {
            id: "web-1",
            label: "Example Web",
            updatedAt: "2026-08-29 00:00:00",
            zoteroVersion: "8.0-test",
          },
        };
      },
    };
  }

  function route(translator) {
    return api.createURLWebRoute({
      translator,
      now: () => new Date("2026-08-30T01:02:03.000Z"),
    });
  }

  it("有效 HTTP(S) URL + 严格 DOI/类型/版本一致时生成完整单一候选", async function () {
    const translator = fakeTranslator();
    const result = await route(translator).attempt(request());

    assert.isNotNull(result.candidate);
    expect(translator.calls).to.deep.equal(["https://example.test/article"]);
    expect(result.candidate.itemType).to.equal("journalArticle");
    expect(result.candidate.evidence).to.deep.include({
      routeId: "url.web",
      sourceId: "Example Catalog",
      sourceURL: "https://example.test/article",
      fetchedAt: "2026-08-30T01:02:03.000Z",
    });
    expect(result.candidate.evidence.identifiers).to.deep.equal([
      { type: "doi", value: "10.1000/example" },
    ]);
    expect(result.candidate.fields).to.deep.include({ field: "title", value: "上游标题" });
    expect(result.candidate.creators).to.deep.equal([
      { creatorType: "author", firstName: "A", lastName: "B" },
    ]);
    for (const forbidden of ["creators", "tags", "relations", "itemType", "attachments", "notes"]) {
      expect(result.candidate.fields.some((entry) => entry.field === forbidden)).to.equal(false);
    }
    expect(result.candidate.attachments).to.have.length(1);
    expect(result.candidate.notes).to.have.length(1);
    expect(result.evidence.outcome).to.equal("candidate");
    expect(result.evidence.candidateDigest).to.match(/^fnv1a:/);
    expect(result.evidence.returnedIdentifiers).to.deep.equal([
      { type: "doi", value: "10.1000/example" },
    ]);
  });

  it("非法 URL 不调用 Translator；有效 URL 即使本地无 DOI 也交给 Zotero 后再判身份不足", async function () {
    for (const input of [
      request({ url: "file:///tmp/a" }),
      request({ doi: null, item: item({ fields: { DOI: "bad" } }) }),
    ]) {
      const translator = fakeTranslator();
      const result = await route(translator).attempt(input);
      expect(result.candidate).to.equal(null);
      expect(translator.calls).to.have.length(input.url.startsWith("file:") ? 0 : 1);
      expect(result.evidence.outcome).to.equal(
        input.url.startsWith("file:") ? "unsupported" : "identity-evidence-missing",
      );
    }
  });

  it("无 DOI 时以标题加组合证据形成需用户确认的完整候选", async function () {
    const local = item({ fields: {
      DOI: "",
      title: "同一篇文章",
      date: "2025",
      publicationTitle: "测试期刊",
      creators: [{ creatorType: "author", firstName: "A", lastName: "B" }],
    } });
    const translated = translatedItem({
      DOI: "",
      title: "同一篇文章",
      date: "2025-01-01",
      publicationTitle: "测试期刊",
      url: "https://example.test/article",
      creators: [{ creatorType: "author", firstName: "A", lastName: "B" }],
    });
    const result = await route(fakeTranslator(translated)).attempt(request({ item: local, doi: null }));

    expect(result.evidence.outcome).to.equal("candidate");
    expect(result.candidate.identityReview).to.deep.include({ required: true });
    expect(result.candidate.identityReview.matchedFields).to.include.members(["title", "creator", "year", "publisher", "url"]);
    expect(result.candidate.evidence.identifiers).to.deep.equal([
      { type: "url", value: "https://example.test/article" },
    ]);
  });

  it("无 DOI 时 ISBN 一致直接证明身份，ISBN 冲突仍阻断", async function () {
    const local = item({ fields: { DOI: "", ISBN: "9787300000001", title: "图书" }, itemType: "book" });
    const same = await route(fakeTranslator(translatedItem({
      DOI: "", ISBN: "978-7-300-00000-1", title: "其他标题", itemType: "book",
    }))).attempt(request({ item: local, doi: null }));
    expect(same.evidence.outcome).to.equal("candidate");
    expect(same.candidate.identityReview).to.equal(undefined);

    const conflict = await route(fakeTranslator(translatedItem({
      DOI: "", ISBN: "9787300000002", title: "图书", itemType: "book",
    }))).attempt(request({ item: local, doi: null }));
    expect(conflict.evidence.outcome).to.equal("identifier-conflict");
    expect(conflict.candidate).to.equal(null);
  });

  it("返回 DOI 缺失进入 fallback，DOI 冲突则阻断", async function () {
    const missing = await route(fakeTranslator(translatedItem({ DOI: "" }))).attempt(request());
    expect(missing.evidence.outcome).to.equal("identity-evidence-missing");
    expect(missing.retryable).to.equal(false);

    const conflict = await route(fakeTranslator(translatedItem({ DOI: "10.1000/other" }))).attempt(request());
    expect(conflict.evidence.outcome).to.equal("identifier-conflict");
    expect(conflict.evidence.returnedIdentifiers).to.deep.equal([
      { type: "doi", value: "10.1000/other" },
    ]);
  });

  it("保留 Translator itemType，并阻断类型或 edition/version 不明确一致", async function () {
    const typeConflict = await route(fakeTranslator(translatedItem({ itemType: "dataset" }))).attempt(request());
    expect(typeConflict.evidence.outcome).to.equal("item-type-conflict");

    const versionMissing = await route(fakeTranslator(translatedItem({ versionNumber: "2" }))).attempt(request());
    expect(versionMissing.evidence.outcome).to.equal("version-ambiguous");

    const sameVersion = await route(fakeTranslator(translatedItem({ versionNumber: " V2 " }))).attempt(request({
      item: item({ fields: { DOI: "10.1000/example", versionNumber: "v2" } }),
    }));
    expect(sameVersion.evidence.outcome).to.equal("candidate");
  });

  it("来源不可确认时记录 unknown 且不放行", async function () {
    const result = await route(fakeTranslator(translatedItem({ libraryCatalog: "" }))).attempt(request());
    expect(result.candidate).to.equal(null);
    expect(result.evidence.sourceId).to.equal("unknown");
    expect(result.evidence.outcome).to.equal("identity-evidence-missing");
  });

  it("Creator 保留个人、机构、角色、重复项与原始顺序，空列表则省略", async function () {
    const creators = [
      { creatorType: "author", firstName: "San", lastName: "Zhang" },
      { creatorType: "author", name: "示例研究会" },
      { creatorType: "editor", firstName: "Si", lastName: "Li" },
      { creatorType: "translator", firstName: "San", lastName: "Zhang" },
    ];
    const result = await route(fakeTranslator(translatedItem({ creators }))).attempt(request());
    expect(result.candidate.creators).to.deep.equal(creators);

    const empty = await route(fakeTranslator(translatedItem({ creators: [] }))).attempt(request());
    expect(empty.candidate).not.to.have.property("creators");
  });

  it("Creator 结构或角色无效时拒绝整个候选", async function () {
    for (const creators of [
      [{ firstName: "A", lastName: "B" }],
      [{ creatorType: "not-a-zotero-role", firstName: "A", lastName: "B" }],
      [{ creatorType: "author", name: "机构", lastName: "混合模式" }],
    ]) {
      const result = await route(fakeTranslator(translatedItem({ creators }))).attempt(request());
      expect(result.candidate).to.equal(null);
      expect(result.evidence).to.include({ outcome: "invalid-response", errorCode: "invalid-creators" });
    }
  });

  it("Web 异常诊断进入 attempt evidence，供预检界面检查", async function () {
    const translator = {
      async translateDetailed() {
        const error = new Error("页面获取失败");
        error.name = "WebTranslatorError";
        error.code = "fetch-failed";
        error.retryable = true;
        error.diagnostic = {
          stage: "document-fetch",
          message: "页面获取失败：Unexpected status code 403",
          errorName: "UnexpectedStatusException",
          httpStatus: 403,
        };
        throw error;
      },
    };
    // 跨 realm／fake 错误不满足 instanceof 时仍须给出 route 级诊断。
    const result = await route(translator).attempt(request());
    expect(result.evidence.outcome).to.equal("fetch-failed");
    expect(result.evidence.diagnostic.stage).to.equal("route");
    expect(result.evidence.diagnostic.message).to.include("页面获取失败");
  });
});
