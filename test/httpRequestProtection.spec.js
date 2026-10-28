const { assert, expect } = require("chai");

describe("HTTP 请求保护（fake host/route，零网络零写库）", function () {
  let api;
  const item = { itemID: 1, itemKey: "I1", libraryID: 1, itemType: "book", fields: {} };
  before(function () {
    api = { ...Zotero.zmtaAddon.api, ...Zotero.zmtaAddon.testApi };
    assert.isFunction(api.createDOIFallbackResolver);
  });
  function failure(routeId, attempt, status, extra = {}) {
    return {
      candidate: null, retryable: true,
      evidence: {
        routeId, attempt, inputIdentifiers: [], returnedIdentifiers: [], sourceId: routeId,
        fetchedAt: "2026-10-27T00:00:00Z", outcome: "fetch-failed",
        diagnostic: { stage: "document-fetch", message: "test failure", httpStatus: status, ...extra },
      },
    };
  }
  function setup(status, extra) {
    const calls = [];
    return {
      calls,
      resolver: api.createDOIFallbackResolver({
        urlWebRoute: { id: "url.web", async attempt(request) {
          calls.push(request.url); return failure("url.web", request.attempt, status, extra);
        } },
        doiSearchRoute: { id: "doi.search", async attempt(request) {
          calls.push("search"); return failure("doi.search", request.attempt, status, extra);
        } },
      }),
    };
  }

  for (const status of [401, 403, 429]) {
    it(`${status} 不重试且同批同host后续条目零请求，其他host独立，新批次复位`, async function () {
      const { resolver, calls } = setup(status);
      const first = await resolver.resolve({ item, url: "https://example.test/a" });
      const next = await resolver.resolve({ item, url: "https://example.test/b" });
      await resolver.resolve({ item, url: "https://other.test/a" });
      expect(first.attempts).to.have.length(1);
      expect(next.attempts[0].errorCode).to.equal("host-request-stopped");
      expect(next.message).to.match(/停止/);
      expect(calls).to.deep.equal(["https://example.test/a", "https://other.test/a"]);
      const fresh = setup(status);
      await fresh.resolver.resolve({ item, url: "https://example.test/a" });
      expect(fresh.calls).to.have.length(1);
    });
  }
  it("Search 内部host未知时停止后续Search，不伪装成doi.org错误", async function () {
    const { resolver, calls } = setup(403);
    const first = await resolver.resolveDOI({ item, doi: "10.1000/a" });
    const next = await resolver.resolveDOI({ item, doi: "10.1000/b" });
    expect(calls).to.deep.equal(["search"]);
    expect(first.attempts).to.have.length(1);
    expect(next.attempts[0].errorCode).to.equal("host-request-stopped");
  });
  it("一个Web站点被拒绝不妨碍独立DOI获取路线", async function () {
    const { resolver, calls } = setup(403);
    await resolver.resolve({ item, url: "https://example.test/a", doi: "10.1000/a" });
    expect(calls).to.deep.equal(["https://example.test/a", "search"]);
  });
  it("网络超时仍只允许两次，且取消可在下一次实际尝试前生效", async function () {
    const { resolver, calls } = setup(504);
    const result = await resolver.resolve({ item, url: "https://example.test/a" });
    expect(calls).to.have.length(2);
    expect(result.attempts.at(-1).outcome).to.equal("retry-exhausted");
    const cancel = setup(504);
    try {
      await cancel.resolver.resolve({ item, url: "https://example.test/a", beforeAttempt(_route, attempt) {
        if (attempt === 2) throw new Error("cancelled");
      } });
      assert.fail("应取消");
    } catch (error) { expect(error.message).to.equal("cancelled"); }
    expect(cancel.calls).to.have.length(1);
  });
  it("Web和Search包装异常保留XHR状态及Retry-After秒数，并禁止立即重试", async function () {
    const cause = Object.assign(new Error("Too many requests"), {
      xmlhttp: { status: 429, responseURL: "https://limited.test/a", getResponseHeader: () => "120" },
    });
    const web = api.createWebTranslatorAdapter({ async processDocuments() { throw cause; } });
    let error;
    try { await web.translate("https://example.test/a"); } catch (value) { error = value; }
    expect(error.retryable).to.equal(false);
    expect(error.diagnostic).to.include({ httpStatus: 429, retryAfterMs: 120000, requestHost: "limited.test" });
    const nested = api.createAttemptDiagnostic("route", "Provider failed", { cause: { cause: error } });
    expect(nested).to.include({ httpStatus: 429, retryAfterMs: 120000 });
    const search = api.createSearchTranslatorAdapter({ createSearchTranslator: () => ({
      setIdentifier() {}, setTranslator() {}, async getTranslators() { return [{}]; },
      async translate() { throw cause; },
    }) });
    try { await search.translateDOI("10.1000/a"); } catch (value) { error = value; }
    expect(error.retryable).to.equal(false);
    expect(error.diagnostic.retryAfterMs).to.equal(120000);
  });
  it("Retry-After的日期、非法值及缺失值不会导致立即重试", async function () {
    const future = new Date(Date.now() + 60000).toUTCString();
    for (const header of [future, "garbage", "", "-1"]) {
      const diagnostic = api.createAttemptDiagnostic("route", "limited", {
        status: 429, headers: { "Retry-After": header },
      });
      if (header === future) expect(diagnostic.retryAfterMs).to.be.within(58000, 60000);
      else expect(diagnostic.retryAfterMs).to.equal(undefined);
      const { resolver, calls } = setup(429, diagnostic);
      const result = await resolver.resolve({ item, url: "https://example.test/a" });
      expect(calls).to.have.length(1);
      expect(result.message).to.include(header === future ? "至少等待" : "可靠等待时间");
    }
  });
  it("重定向拒绝时请求host和响应host都停止，不阻止其他站点", async function () {
    const { resolver, calls } = setup(403, { requestHost: "security.test" });
    await resolver.resolve({ item, url: "https://book.test/a" });
    const next = await resolver.resolve({ item, url: "https://security.test/b" });
    expect(calls).to.have.length(1);
    expect(next.attempts[0].errorCode).to.equal("host-request-stopped");
  });
});
