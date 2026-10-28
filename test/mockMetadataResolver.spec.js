const { assert, expect } = require("chai");

describe("开发环境 Mock 元数据（纯内存、零网络）", function () {
  let createResolver;

  before(function () {
    createResolver = Zotero.zmtaAddon?.testApi?.createMockMetadataResolver;
    assert.isFunction(createResolver);
  });

  function request(extra = "", overrides = {}) {
    return {
      item: {
        itemID: 71,
        itemKey: "MOCK71",
        libraryID: 1,
        itemType: "book",
        title: "Mock 本地标题",
        fields: {
          title: "Mock 本地标题",
          url: "https://book.example.test/subject/71/",
          ISBN: "9787300000001",
          extra,
          ...overrides,
        },
      },
      url: "https://book.example.test/subject/71/",
      doi: overrides.DOI,
    };
  }

  it("默认生成身份与类型一致的离线候选", async function () {
    const result = await createResolver().resolve(request());

    expect(result.terminalOutcome).to.equal("candidate");
    expect(result.candidate).to.deep.include({ providerId: "zmta-mock", itemType: "book" });
    expect(result.candidate.evidence).to.deep.include({
      routeId: "url.web",
      sourceId: "mock.local",
    });
    expect(result.candidate.evidence.translator.label).to.equal("ZMTA Mock（离线）");
    expect(result.candidate.fields.find((field) => field.field === "abstractNote").value)
      .to.include("离线测试候选");
  });

  it("rich-success 才产生固定 .example 附件与 Note", async function () {
    const plain = await createResolver().resolve(request("ZMTA-MOCK: success"));
    const rich = await createResolver().resolve(request("ZMTA-MOCK: rich-success"));

    expect(plain.candidate.attachments).to.deep.equal([]);
    expect(plain.candidate.notes).to.deep.equal([]);
    expect(rich.candidate.attachments[0].url).to.equal("https://example.test/zmta/mock.pdf");
    expect(rich.candidate.notes[0].content).to.include("Mock 离线测试 Note");
    expect(rich.candidate.creators).to.deep.equal([
      { creatorType: "author", firstName: "三", lastName: "张" },
      { creatorType: "author", name: "中国图书研究会" },
      { creatorType: "editor", firstName: "四", lastName: "李" },
      { creatorType: "translator", firstName: "三", lastName: "张" },
    ]);
  });

  it("无结果、403 与三类阻断场景不返回候选", async function () {
    const expectations = [
      ["no-result", "no-safe-candidate", "no-result"],
      ["http-403", "no-safe-candidate", "fetch-failed"],
      ["identifier-conflict", "blocked", "identifier-conflict"],
      ["item-type-conflict", "blocked", "item-type-conflict"],
      ["version-ambiguous", "blocked", "version-ambiguous"],
    ];
    for (const [name, terminalOutcome, finalOutcome] of expectations) {
      const result = await createResolver().resolve(request(`ZMTA-MOCK: ${name}`));
      expect(result.candidate, name).to.equal(null);
      expect(result.terminalOutcome, name).to.equal(terminalOutcome);
      expect(result.attempts.at(-1).outcome, name).to.equal(finalOutcome);
    }
  });

  it("403 场景只产生一次进度和安全诊断，不模拟立即重试", async function () {
    const calls = [];
    const result = await createResolver().resolve({
      ...request("ZMTA-MOCK: http-403"),
      beforeAttempt: (routeId, attempt) => calls.push(`${routeId}:${attempt}`),
    });

    expect(calls).to.deep.equal(["url.web:1"]);
    expect(result.attempts).to.have.length(1);
    expect(result.attempts[0].diagnostic).to.deep.include({
      stage: "document-fetch",
      httpStatus: 403,
    });
  });

  it("主动 DOI 只接受有效 DOI，并形成 doi.search 候选", async function () {
    const resolver = createResolver();
    const missing = await resolver.resolveDOI(request());
    const found = await resolver.resolveDOI(request("", { DOI: "10.5555/mock.71" }));

    expect(missing.terminalOutcome).to.equal("not-applicable");
    expect(found.candidate.evidence.routeId).to.equal("doi.search");
    expect(found.candidate.evidence.identifiers).to.deep.equal([{ type: "doi", value: "10.5555/mock.71" }]);
  });

  it("identity-review 只增加确认门，不改变完整候选", async function () {
    const result = await createResolver().resolve(request("ZMTA-MOCK: identity-review"));

    expect(result.terminalOutcome).to.equal("candidate");
    expect(result.candidate.identityReview).to.deep.include({ required: true });
    expect(result.candidate.identityReview.matchedFields).to.deep.equal(["title", "url"]);
  });
});
