const { assert, expect } = require("chai");

describe("DoubanProvider（纯 fixture，不发豆瓣请求）", function () {
  let api;

  before(function () {
    api = Zotero.zmtaAddon?.api;
    assert.isFunction(api?.createDoubanProvider, "应暴露 DoubanProvider 测试入口");
    assert.isFunction(api?.extractDoubanSubject, "应暴露豆瓣 subject 提取入口");
  });

  function makeItem(fields = {}, itemType = "book") {
    return {
      itemID: 7,
      itemKey: "BOOK0007",
      libraryID: 1,
      itemType,
      title: "本地书名",
      fields: {
        title: "本地书名",
        url: "https://book.douban.com/subject/123/?from=test",
        ...fields,
      },
    };
  }

  it("只适用于 book + 豆瓣图书 URL，并提取精确 subject", function () {
    const provider = api.createDoubanProvider({ translator: { translate: async () => ({}) } });
    assert.isTrue(provider.applies(makeItem()));
    assert.isFalse(provider.applies(makeItem({}, "journalArticle")));
    assert.isFalse(provider.applies(makeItem({ url: "https://example.test/subject/123/" })));
    expect(api.extractDoubanSubject("https://book.douban.com/subject/123/?from=test")).to.equal("123");
    expect(api.extractDoubanSubject("https://book.douban.com/subject/123/photos/")).to.equal(null);
    expect(provider.resolveIdentifiers(makeItem())).to.deep.equal([
      { type: "douban-subject", value: "123" },
    ]);
  });

  it("输出统一候选与来源证据，不执行 diff 或审核策略", async function () {
    const incoming = {
      itemType: "book",
      title: "上游书名",
      publisher: "上游出版社",
      extra: "由 Planner 决定是否排除",
      url: "https://book.douban.com/subject/123/",
      creators: [
        { creatorType: "author", firstName: "三", lastName: "张" },
        { creatorType: "author", name: "示例研究会" },
        { creatorType: "editor", firstName: "四", lastName: "李" },
        { creatorType: "translator", firstName: "三", lastName: "张" },
      ],
      attachments: [
        { url: "https://example.test/a.pdf", title: "PDF", mimeType: "application/pdf", snapshot: false },
        { url: "https://example.test/a.pdf", title: "PDF", mimeType: "application/pdf", snapshot: false },
      ],
      notes: [{ note: "同一 note" }, { note: "同一 note" }],
    };
    const provider = api.createDoubanProvider({
      translator: { translate: async () => incoming },
      now: () => new Date("2026-08-30T01:02:03.000Z"),
    });
    const item = makeItem();
    const request = { item, identifiers: provider.resolveIdentifiers(item) };
    const source = await provider.fetch(request);
    const first = provider.transform(source, request);
    const second = provider.transform(source, request);
    await provider.verify(first, request);

    expect(first.providerId).to.equal("douban");
    expect(first.item).to.deep.equal({
      itemID: 7,
      itemKey: "BOOK0007",
      libraryID: 1,
      itemType: "book",
      title: "本地书名",
    });
    expect(first.evidence).to.deep.equal({
      providerId: "douban",
      sourceURL: "https://book.douban.com/subject/123/?from=test",
      identifiers: [{ type: "douban-subject", value: "123" }],
      fetchedAt: "2026-08-30T01:02:03.000Z",
    });
    expect(first.fields).to.deep.include.members([
      { field: "title", value: "上游书名" },
      { field: "publisher", value: "上游出版社" },
      { field: "extra", value: "由 Planner 决定是否排除" },
    ]);
    expect(first.fields.some((field) => "local" in field || "defaultChecked" in field)).to.equal(false);
    expect(first.creators).to.deep.equal(incoming.creators);
    expect(first.attachments).to.have.length(2);
    expect(first.notes).to.have.length(2);
    expect(new Set(first.attachments.map((entry) => entry.operationId)).size).to.equal(2);
    expect(new Set(first.notes.map((entry) => entry.operationId)).size).to.equal(2);
    expect(first.attachments.map((entry) => entry.operationId)).to.deep.equal(
      second.attachments.map((entry) => entry.operationId),
    );
    expect(first.notes.map((entry) => entry.operationId)).to.deep.equal(
      second.notes.map((entry) => entry.operationId),
    );
  });

  it("同源 subject 不一致时返回不可重试的来源错误", async function () {
    const provider = api.createDoubanProvider({
      translator: {
        translate: async () => ({
          itemType: "book",
          title: "另一条书",
          url: "https://book.douban.com/subject/999/",
        }),
      },
    });
    const item = makeItem();
    const request = { item, identifiers: provider.resolveIdentifiers(item) };
    const candidate = provider.transform(await provider.fetch(request), request);
    let thrown;
    try {
      await provider.verify(candidate, request);
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.code).to.equal("source-mismatch");
    expect(thrown?.retryable).to.equal(false);
  });

  it("将 Translator 错误映射为可分类 ProviderError", function () {
    const provider = api.createDoubanProvider({ translator: { translate: async () => ({}) } });
    const classified = provider.classifyError({
      name: "WebTranslatorError",
      code: "translator-missing",
      retryable: false,
      message: "无匹配 Translator",
    });
    expect(classified.name).to.equal("ProviderError");
    expect(classified.providerId).to.equal("douban");
    expect(classified.code).to.equal("translator-missing");
    expect(classified.retryable).to.equal(false);
  });

  it("空 Creator 不生成清空候选，非法 Creator fail closed", async function () {
    const item = makeItem();
    const emptyProvider = api.createDoubanProvider({
      translator: { translate: async () => ({
        itemType: "book",
        title: "上游书名",
        url: "https://book.douban.com/subject/123/",
        creators: [],
      }) },
    });
    const emptyRequest = { item, identifiers: emptyProvider.resolveIdentifiers(item) };
    const empty = emptyProvider.transform(await emptyProvider.fetch(emptyRequest), emptyRequest);
    expect(empty).not.to.have.property("creators");

    for (const creators of [
      [{ firstName: "三", lastName: "张" }],
      [{ creatorType: "not-a-zotero-role", name: "机构" }],
      [{ creatorType: "author", name: "机构", lastName: "混合模式" }],
    ]) {
      const provider = api.createDoubanProvider({
        translator: { translate: async () => ({
          itemType: "book",
          title: "上游书名",
          url: "https://book.douban.com/subject/123/",
          creators,
        }) },
      });
      const request = { item, identifiers: provider.resolveIdentifiers(item) };
      expect(() => provider.transform({ translatedItem: {
        itemType: "book",
        title: "上游书名",
        url: "https://book.douban.com/subject/123/",
        creators,
      }, fetchedAt: "2026-08-30T00:00:00.000Z" }, request)).to.throw();
    }
  });
});
