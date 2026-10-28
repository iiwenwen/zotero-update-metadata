const { assert, expect } = require("chai");

describe("SearchTranslatorAdapter（纯 fake host，不联网）", function () {
  let api;

  before(function () {
    api = { ...Zotero.zmtaAddon?.api, ...Zotero.zmtaAddon?.testApi };
    assert.isFunction(api?.createSearchTranslatorAdapter, "应暴露 Search Translator 测试入口");
  });

  function makeHost(options = {}) {
    const calls = { identifiers: [], translators: [], settings: [], handlers: [] };
    const handlers = {};
    const matched = options.translators === undefined
      ? [{ translatorID: "crossref-translator", label: "Crossref", lastUpdated: "2026-08-01" }]
      : options.translators;
    const instance = {
      setIdentifier(value) { calls.identifiers.push(value); },
      async getTranslators() {
        if (options.detectError) throw options.detectError;
        return matched;
      },
      setTranslator(value) { calls.translators.push(value); },
      setHandler(type, handler) {
        calls.handlers.push(type);
        handlers[type] = handler;
      },
      async translate(settings) {
        calls.settings.push(settings);
        if (options.translateError) throw options.translateError;
        const results = options.results === undefined
          ? [{ toJSON: () => ({ itemType: "journalArticle", DOI: "10.1000/example", libraryCatalog: "Crossref" }) }]
          : options.results;
        for (const translator of options.observedTranslators || []) {
          handlers.itemDone?.({ translator: [translator] });
        }
        return results;
      },
    };
    return {
      calls,
      matched,
      host: {
        createSearchTranslator() { return instance; },
        getZoteroVersion() { return "8.0-test"; },
      },
    };
  }

  it("用规范 DOI 调用 Zotero 返回的匹配 Translator，并禁止隐式写库和附件保存", async function () {
    const fixture = makeHost();
    const result = await api.createSearchTranslatorAdapter(fixture.host)
      .translateDOI(" DOI:10.1000/EXAMPLE ");

    expect(fixture.calls.identifiers).to.deep.equal([{ DOI: "10.1000/example" }]);
    expect(fixture.calls.translators).to.deep.equal([fixture.matched]);
    expect(fixture.calls.settings).to.deep.equal([{ libraryID: false, saveAttachments: false }]);
    expect(result.item.itemType).to.equal("journalArticle");
    expect(result.sourceId).to.equal("Crossref");
    expect(result.translator).to.deep.equal({
      id: "crossref-translator",
      label: "Crossref",
      updatedAt: "2026-08-01",
      zoteroVersion: "8.0-test",
      attribution: "single-match",
    });
  });

  it("区分零 Translator、零结果、多结果、执行异常和非法响应", async function () {
    const cases = [
      [makeHost({ translators: [] }), "translator-missing", false],
      [makeHost({ results: [] }), "no-result", false],
      [makeHost({ results: [{ DOI: "10.1/a" }, { DOI: "10.1/b" }] }), "multiple-results", false],
      [makeHost({ translateError: new Error("offline") }), "fetch-failed", true],
      [makeHost({ results: ["bad"] }), "invalid-response", false],
    ];

    for (const [fixture, code, retryable] of cases) {
      let thrown;
      try {
        await api.createSearchTranslatorAdapter(fixture.host).translateDOI("10.1000/example");
      } catch (error) {
        thrown = error;
      }
      expect(thrown?.code).to.equal(code);
      expect(thrown?.retryable).to.equal(retryable);
    }
  });

  it("Search 执行异常保留阶段和底层原因", async function () {
    const cause = Object.assign(new Error("Gateway timeout"), { status: 504 });
    let thrown;
    try {
      await api.createSearchTranslatorAdapter(makeHost({ translateError: cause }).host)
        .translateDOI("10.1000/example");
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.diagnostic).to.deep.include({
      stage: "translator-run",
      errorName: "Error",
      httpStatus: 504,
    });
    expect(thrown?.diagnostic.message).to.include("Gateway timeout");
  });

  it("多匹配 Translator 时不把结果伪归因给第一条", async function () {
    const fixture = makeHost({
      translators: [{ translatorID: "a", label: "A" }, { translatorID: "b", label: "B" }],
      results: [{ itemType: "dataset", DOI: "10.1000/example", libraryCatalog: "DataCite" }],
    });
    const result = await api.createSearchTranslatorAdapter(fixture.host).translateDOI("10.1000/example");

    expect(result.translator).to.deep.equal({
      id: "unknown",
      label: "unknown",
      updatedAt: "unknown",
      zoteroVersion: "8.0-test",
      attribution: "unknown",
    });
    expect(result.sourceId).to.equal("DataCite");
    expect(fixture.calls.translators[0]).to.have.length(2);
  });

  it("多个匹配 Translator 时使用 itemDone 当场观察到的实际 Translator", async function () {
    const matched = [
      { translatorID: "a", label: "A" },
      { translatorID: "b", label: "B", lastUpdated: "2026-08-02" },
    ];
    const fixture = makeHost({
      translators: matched,
      observedTranslators: [matched[1]],
      results: [{ itemType: "dataset", DOI: "10.1000/example", libraryCatalog: "DataCite" }],
    });
    const result = await api.createSearchTranslatorAdapter(fixture.host).translateDOI("10.1000/example");

    expect(result.translator).to.deep.equal({
      id: "b",
      label: "B",
      updatedAt: "2026-08-02",
      zoteroVersion: "8.0-test",
      attribution: "observed",
    });
    expect(fixture.calls.translators[0]).to.equal(matched);
    expect(fixture.calls.handlers).to.deep.equal(["itemDone"]);
  });

  it("itemDone 观察到不同 Translator 时标记 ambiguous，不猜测来源", async function () {
    const fixture = makeHost({
      translators: [{ translatorID: "a", label: "A" }, { translatorID: "b", label: "B" }],
      observedTranslators: [{ translatorID: "a", label: "A" }, { translatorID: "b", label: "B" }],
    });
    const result = await api.createSearchTranslatorAdapter(fixture.host).translateDOI("10.1000/example");

    expect(result.translator).to.include({
      id: "unknown",
      label: "unknown",
      attribution: "ambiguous",
    });
  });
});
