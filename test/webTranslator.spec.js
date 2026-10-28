const { assert, expect } = require("chai");

describe("WebTranslatorAdapter（纯 mock，不发网络请求）", function () {
  let api;

  before(function () {
    api = Zotero.zmtaAddon?.api;
    assert.isFunction(api?.createWebTranslatorAdapter, "应暴露 Web Translator 测试入口");
  });

  function makeHost(options = {}) {
    const calls = {
      processURLs: [],
      documents: [],
      translators: [],
      translateSettings: [],
    };
    const document = { URL: "https://book.douban.com/subject/123/" };
    const translator = {
      setDocument(value) { calls.documents.push(value); },
      async getTranslators() {
        return options.translators === undefined ? [{ translatorID: "douban" }] : options.translators;
      },
      setTranslator(value) { calls.translators.push(value); },
      async translate(settings) {
        calls.translateSettings.push(settings);
        if (options.translateError) throw options.translateError;
        return options.results === undefined
          ? [{ toJSON: () => ({ url: document.URL, title: "测试书" }) }]
          : options.results;
      },
    };
    return {
      calls,
      host: {
        async processDocuments(url, visitor) {
          calls.processURLs.push(url);
          if (options.processError) throw options.processError;
          visitor(document);
          return options.documents === undefined ? [document] : options.documents;
        },
        createWebTranslator() { return translator; },
        getZoteroVersion() { return "8.0-test"; },
      },
    };
  }

  it("只抓取一次页面，并强制禁用隐式库写入和附件保存", async function () {
    const fixture = makeHost();
    const adapter = api.createWebTranslatorAdapter(fixture.host);
    const result = await adapter.translate("https://book.douban.com/subject/123/");

    expect(result).to.deep.equal({
      url: "https://book.douban.com/subject/123/",
      title: "测试书",
    });
    expect(fixture.calls.processURLs).to.deep.equal(["https://book.douban.com/subject/123/"]);
    expect(fixture.calls.documents).to.have.length(1);
    expect(fixture.calls.translators).to.deep.equal([{ translatorID: "douban" }]);
    expect(fixture.calls.translateSettings).to.deep.equal([{
      libraryID: false,
      saveAttachments: false,
    }]);
  });

  it("详细结果暴露实际 Translator 证据，同时保持 translate(url) 返回旧结构", async function () {
    const fixture = makeHost({
      translators: [{
        translatorID: "translator-1",
        label: "Example Web",
        lastUpdated: "2026-08-30 00:00:00",
      }],
    });
    const adapter = api.createWebTranslatorAdapter(fixture.host);
    const detailed = await adapter.translateDetailed("https://example.test/item");

    expect(detailed.item.title).to.equal("测试书");
    expect(detailed.translator).to.deep.equal({
      id: "translator-1",
      label: "Example Web",
      updatedAt: "2026-08-30 00:00:00",
      zoteroVersion: "8.0-test",
      attribution: "selected",
    });
    expect(await adapter.translate("https://example.test/item")).to.deep.equal(detailed.item);
  });

  it("多个翻译结果明确阻断，不默认取第一条", async function () {
    const fixture = makeHost({ results: [{ title: "A" }, { title: "B" }] });
    let thrown;
    try {
      await api.createWebTranslatorAdapter(fixture.host).translate("https://example.test/item");
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.code).to.equal("multiple-results");
    expect(thrown?.retryable).to.equal(false);
  });

  it("区分页面获取失败、无 Translator 与无结果", async function () {
    const cases = [
      [makeHost({ processError: new Error("offline") }), "fetch-failed", true],
      [makeHost({ translators: [] }), "translator-missing", false],
      [makeHost({ results: [] }), "no-result", false],
    ];

    for (const [fixture, code, retryable] of cases) {
      let thrown;
      try {
        await api.createWebTranslatorAdapter(fixture.host).translate("https://book.douban.com/subject/123/");
      } catch (error) {
        thrown = error;
      }
      expect(thrown?.code).to.equal(code);
      expect(thrown?.retryable).to.equal(retryable);
    }
  });

  it("页面请求异常保留阶段、HTTP 状态和原始原因", async function () {
    const cause = Object.assign(new Error("Unexpected status code 403"), { status: 403 });
    let thrown;
    try {
      await api.createWebTranslatorAdapter(makeHost({ processError: cause }).host)
        .translate("https://book.douban.com/subject/38438331/");
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.diagnostic).to.deep.include({
      stage: "document-fetch",
      errorName: "Error",
      httpStatus: 403,
    });
    expect(thrown?.diagnostic.message).to.include("Unexpected status code 403");
  });
});
