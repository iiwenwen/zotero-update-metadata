const { assert, expect } = require("chai");

describe("DOI fallback resolver（纯 fake route）", function () {
  let createResolver;

  before(function () {
    createResolver = Zotero.zmtaAddon?.testApi?.createDOIFallbackResolver;
    assert.isFunction(createResolver, "应暴露 createDOIFallbackResolver");
  });

  const item = Object.freeze({
    itemID: 1,
    itemKey: "ITEM1",
    libraryID: 1,
    itemType: "journalArticle",
    title: "Local title",
    fields: {},
  });

  function evidence(routeId, attempt, outcome, extras = {}) {
    return Object.freeze({
      routeId,
      attempt,
      inputIdentifiers: [],
      returnedIdentifiers: [],
      sourceId: routeId,
      fetchedAt: `2026-08-30T00:00:0${attempt}.000Z`,
      outcome,
      ...extras,
    });
  }

  function candidate(routeId, digest = `${routeId}-digest`) {
    return Object.freeze({
      providerId: routeId,
      item,
      evidence: {
        providerId: routeId,
        sourceURL: routeId === "url.web" ? "https://example.test/paper" : "https://doi.org/10.1000/test",
        identifiers: [{ type: "doi", value: "10.1000/test" }],
        fetchedAt: "2026-08-30T00:00:00.000Z",
        routeId,
        sourceId: routeId,
      },
      itemType: "journalArticle",
      fields: [{ field: "title", value: "Candidate" }],
      attachments: [],
      notes: [],
      _digestForTest: digest,
    });
  }

  function fakeRoute(id, results, calls) {
    let index = 0;
    return {
      id,
      async attempt(request) {
        calls.push({ id, request });
        const next = results[Math.min(index, results.length - 1)];
        index += 1;
        return typeof next === "function" ? next(request) : next;
      },
    };
  }

  function success(routeId, attempt = 1, digest) {
    return {
      candidate: candidate(routeId, digest),
      evidence: evidence(routeId, attempt, "candidate", { candidateDigest: digest }),
    };
  }

  function failure(routeId, attempt, outcome, retryable = false, extras = {}) {
    return {
      candidate: null,
      retryable,
      evidence: evidence(routeId, attempt, outcome, extras),
    };
  }

  function setup(webResults, searchResults) {
    const calls = [];
    const resolver = createResolver({
      urlWebRoute: fakeRoute("url.web", webResults, calls),
      doiSearchRoute: fakeRoute("doi.search", searchResults, calls),
    });
    return { resolver, calls };
  }

  it("有效 URL 先走 Web；安全候选立即停止，即使字段较少也不 Search", async function () {
    const { resolver, calls } = setup(
      [success("url.web", 1, "thin-web")],
      [success("doi.search", 1, "search")],
    );
    const resolved = await resolver.resolve({ item, url: "https://example.test/paper", doi: "10.1000/TEST" });

    expect(resolved.terminalOutcome).to.equal("candidate");
    expect(resolved.candidate.providerId).to.equal("url.web");
    expect(calls.map((call) => call.id)).to.deep.equal(["url.web"]);
    expect(calls[0].request.doi).to.equal("10.1000/test");
  });

  it("没有有效 URL 时直接 DOI Search；没有 URL/DOI 时不调用路线", async function () {
    const first = setup([], [success("doi.search")]);
    const searched = await first.resolver.resolve({ item, url: "ftp://example.test/paper", doi: "doi: 10.1000/TEST" });
    expect(searched.terminalOutcome).to.equal("candidate");
    expect(first.calls.map((call) => call.id)).to.deep.equal(["doi.search"]);
    expect(first.calls[0].request.url).to.equal(null);

    const second = setup([], []);
    const skipped = await second.resolver.resolve({ item, url: "not a URL", doi: "bad-doi" });
    expect(skipped.terminalOutcome).to.equal("not-applicable");
    expect(skipped.attempts).to.deep.equal([]);
    expect(second.calls).to.deep.equal([]);
  });

  it("用户主动改用 DOI 时跳过 Web，并且仍只采用一个完整候选", async function () {
    const { resolver, calls } = setup(
      [success("url.web")],
      [success("doi.search")],
    );
    const resolved = await resolver.resolveDOI({
      item,
      url: "https://example.test/article",
      doi: "10.1000/test",
    });
    expect(calls.map((call) => `${call.id}:${call.request.attempt}`)).to.deep.equal(["doi.search:1"]);
    expect(resolved.candidate.evidence.routeId).to.equal("doi.search");
  });
  it("解析结果保留临时故障的恢复依据，不让不支持来源变成可重查", async function () {
    const transient = setup([failure("url.web", 1, "fetch-failed", true)], []);
    const failed = await transient.resolver.resolve({ item, url: "https://example.test/paper" });
    expect(failed.attempts.at(-1).outcome).to.equal("retry-exhausted");
    expect(failed.attempts.at(-1).retryable).to.equal(true);
    const unsupported = setup([failure("url.web", 1, "unsupported", false)], []);
    const ended = await unsupported.resolver.resolve({ item, url: "https://example.test/paper" });
    expect(ended.attempts.at(-1).retryable).to.equal(false);
    expect(unsupported.calls).to.have.lengthOf(1);
  });

  for (const outcome of ["unsupported", "no-result"]) {
    it(`Web ${outcome} 后有 DOI 才串行进入 Search`, async function () {
      const { resolver, calls } = setup(
        [failure("url.web", 1, outcome)],
        [success("doi.search")],
      );
      const resolved = await resolver.resolve({ item, url: "https://example.test/paper", doi: "10.1000/test" });
      expect(resolved.terminalOutcome).to.equal("candidate");
      expect(calls.map((call) => call.id)).to.deep.equal(["url.web", "doi.search"]);
      expect(resolved.attempts.map((entry) => entry.routeId)).to.deep.equal(["url.web", "doi.search"]);
    });
  }

  for (const outcome of ["multiple-results", "identity-evidence-missing", "identifier-conflict", "item-type-conflict", "version-ambiguous", "invalid-response"]) {
    it(`Web ${outcome} 直接 blocked，不用 Search 掩盖冲突`, async function () {
      const { resolver, calls } = setup(
        [failure("url.web", 1, outcome)],
        [success("doi.search")],
      );
      const resolved = await resolver.resolve({ item, url: "https://example.test/paper", doi: "10.1000/test" });
      expect(resolved.terminalOutcome).to.equal("blocked");
      expect(resolved.message).to.include("未更新");
      expect(resolved.message).not.to.include(outcome);
      expect(calls.map((call) => call.id)).to.deep.equal(["url.web"]);
    });
  }

  it("Search 多结果、非法响应和证据不足都作为候选拒绝阻断", async function () {
    for (const outcome of ["multiple-results", "invalid-response", "identity-evidence-missing"]) {
      const { resolver, calls } = setup([], [failure("doi.search", 1, outcome)]);
      const resolved = await resolver.resolve({ item, doi: "10.1000/test" });
      expect(resolved.terminalOutcome).to.equal("blocked");
      expect(resolved.message).to.include("未更新");
      expect(resolved.message).not.to.include(outcome);
      expect(resolved.candidate).to.equal(null);
      expect(calls).to.have.length(1);
    }
  });

  it("Search 的标识符、类型和版本冲突同样为 blocked", async function () {
    for (const outcome of ["identifier-conflict", "item-type-conflict", "version-ambiguous"]) {
      const { resolver } = setup([], [failure("doi.search", 1, outcome)]);
      const resolved = await resolver.resolve({ item, doi: "10.1000/test" });
      expect(resolved.terminalOutcome).to.equal("blocked");
    }
  });

  it("英文环境的阻断消息可理解且保留结构化证据", async function () {
    const calls = [];
    const resolver = createResolver({
      urlWebRoute: fakeRoute("url.web", [failure("url.web", 1, "identity-evidence-missing")], calls),
      doiSearchRoute: fakeRoute("doi.search", [], calls), locale: "en-US",
    });
    const resolved = await resolver.resolve({ item, url: "https://example.test/paper" });
    expect(resolved.message).to.include("Nothing was updated");
    expect(resolved.message).not.to.include("identity-evidence-missing");
    expect(resolved.attempts[0].outcome).to.equal("identity-evidence-missing");
  });

  it("英文 DOI 限流区分首次失败和后续未发起的请求", async function () {
    const calls = [];
    const resolver = createResolver({
      urlWebRoute: fakeRoute("url.web", [], calls),
      doiSearchRoute: fakeRoute("doi.search", [failure("doi.search", 1, "fetch-failed", false, {
        diagnostic: { stage: "route", message: "limited", httpStatus: 429 },
      })], calls), locale: "en-US",
    });
    const first = await resolver.resolveDOI({ item, doi: "10.1000/a" });
    const second = await resolver.resolveDOI({ item, doi: "10.1000/b" });
    expect(first.message).to.include("The DOI service limited requests");
    expect(second.message).to.include("No DOI request was sent");
    expect(calls).to.have.length(1);
  });

  it("先请求Web再跳过DOI时，停止提示只指DOI查询", async function () {
    for (const locale of ["zh-CN", "en-US"]) {
      const calls = [];
      const resolver = createResolver({
        urlWebRoute: fakeRoute("url.web", [failure("url.web", 1, "no-result")], calls),
        doiSearchRoute: fakeRoute("doi.search", [failure("doi.search", 1, "fetch-failed", false, {
          diagnostic: { stage: "route", message: "limited", httpStatus: 429 },
        })], calls), locale,
      });
      await resolver.resolveDOI({ item, doi: "10.1000/a" });
      const result = await resolver.resolve({ item, url: "https://example.test/item", doi: "10.1000/b" });
      expect(calls.map(call => call.id)).to.deep.equal(["doi.search", "url.web"]);
      expect(result.message).to.include(locale === "zh-CN" ? "未发起 DOI 请求" : "No DOI request was sent");
    }
  });

  it("获取失败不向用户泄露技术异常，限流等待提示仍可操作", async function () {
    const raw = setup([failure("url.web", 1, "fetch-failed", false, {
      diagnostic: { stage: "route", message: "internal translator stack" },
    })], []);
    const result = await raw.resolver.resolve({ item, url: "https://example.test/paper" });
    expect(result.message).to.include("无法获取来源信息");
    expect(result.message).not.to.include("internal translator stack");
    expect(result.attempts[0].diagnostic.message).to.equal("internal translator stack");
    const limited = setup([failure("url.web", 1, "fetch-failed", false, {
      diagnostic: { stage: "route", message: "raw error", httpStatus: 429, retryAfterMs: 3000 },
    })], []);
    const throttled = await limited.resolver.resolve({ item, url: "https://example.test/paper" });
    expect(throttled.message).to.include("3 秒");
    expect(throttled.message).not.to.include("raw error");
  });

  it("页面解析缺标题不误报网络故障，保留原始诊断但不展示技术异常", async function () {
    for (const locale of ["zh-CN", "en-US"]) {
      const resolver = createResolver({
        urlWebRoute: fakeRoute("url.web", [failure("url.web", 1, "fetch-failed", false, {
          diagnostic: { stage: "translator-run", message: "Translator 执行失败：No title specified for item" },
        })], []),
        doiSearchRoute: fakeRoute("doi.search", [], []), locale,
      });
      const result = await resolver.resolve({ item, url: "https://example.test/book" });
      expect(result.message).to.include(locale === "zh-CN" ? "未获取到标题" : "no title was retrieved");
      expect(result.message).not.to.include("No title specified");
      expect(result.message).not.to.include(locale === "zh-CN" ? "检查网络" : "Check your network");
      expect(result.attempts[0].diagnostic.message).to.include("No title specified");
    }
  });

  it("每次 route attempt 前调用 beforeAttempt，回调可在第一次 Web 失败后阻止重试与 Search", async function () {
    const normal = setup(
      [failure("url.web", 1, "no-result")],
      [success("doi.search")],
    );
    const normalBoundaries = [];
    await normal.resolver.resolve({
      item,
      url: "https://example.test/paper",
      doi: "10.1000/test",
      beforeAttempt: (routeId, attempt) => normalBoundaries.push(`${routeId}:${attempt}`),
    });
    expect(normalBoundaries).to.deep.equal(["url.web:1", "doi.search:1"]);

    const { resolver, calls } = setup(
      [
        failure("url.web", 1, "fetch-failed", true),
        success("url.web", 2),
      ],
      [success("doi.search")],
    );
    const boundaries = [];
    let thrown;
    try {
      await resolver.resolve({
        item,
        url: "https://example.test/paper",
        doi: "10.1000/test",
        beforeAttempt(routeId, attempt) {
          boundaries.push(`${routeId}:${attempt}`);
          if (routeId === "url.web" && attempt === 2) throw new Error("cancelled at safe boundary");
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown?.message).to.equal("cancelled at safe boundary");
    expect(boundaries).to.deep.equal(["url.web:1", "url.web:2"]);
    expect(calls.map((call) => `${call.id}:${call.request.attempt}`)).to.deep.equal(["url.web:1"]);
  });
});
