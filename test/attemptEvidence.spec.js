const { assert, expect } = require("chai");

describe("fallback AttemptEvidence（一次真实调用一条证据）", function () {
  let createResolver;

  before(function () {
    createResolver = Zotero.zmtaAddon?.testApi?.createDOIFallbackResolver;
    assert.isFunction(createResolver);
  });

  const item = {
    itemID: 9,
    itemKey: "ITEM9",
    libraryID: 1,
    itemType: "journalArticle",
    title: "Local",
    fields: {},
  };

  function attemptEvidence(routeId, attempt, outcome, extras = {}) {
    return {
      routeId,
      attempt,
      inputIdentifiers: [{ type: "doi", value: "10.1000/test" }],
      returnedIdentifiers: [],
      sourceId: `${routeId}-source`,
      fetchedAt: `2026-08-30T00:00:0${attempt}.000Z`,
      outcome,
      ...extras,
    };
  }

  function candidate(digest) {
    return {
      providerId: "doi.search",
      item,
      evidence: {
        providerId: "doi.search",
        sourceURL: "https://doi.org/10.1000/test",
        identifiers: [{ type: "doi", value: "10.1000/test" }],
        fetchedAt: "2026-08-30T00:00:03.000Z",
      },
      itemType: item.itemType,
      fields: [],
      attachments: [],
      notes: [],
      digest,
    };
  }

  it("两次 Web fetch 失败后才 Search，第二条真实证据表达 retry-exhausted", async function () {
    const calls = [];
    const webEvidence = [
      attemptEvidence("url.web", 1, "fetch-failed", { errorCode: "timeout-1" }),
      attemptEvidence("url.web", 2, "fetch-failed", { errorCode: "timeout-2" }),
    ];
    let webIndex = 0;
    const digest = "fnv1a:deadbeef";
    const resolver = createResolver({
      urlWebRoute: {
        id: "url.web",
        async attempt(request) {
          calls.push(["url.web", request.attempt]);
          const current = webEvidence[webIndex++];
          return { candidate: null, evidence: current, retryable: true };
        },
      },
      doiSearchRoute: {
        id: "doi.search",
        async attempt(request) {
          calls.push(["doi.search", request.attempt]);
          return {
            candidate: candidate(digest),
            evidence: attemptEvidence("doi.search", 1, "candidate", { candidateDigest: digest }),
          };
        },
      },
    });

    const resolved = await resolver.resolve({ item, url: "https://example.test/paper", doi: "10.1000/test" });

    expect(calls).to.deep.equal([["url.web", 1], ["url.web", 2], ["doi.search", 1]]);
    expect(resolved.attempts).to.have.length(3);
    expect(resolved.attempts[0]).to.equal(webEvidence[0]);
    expect(resolved.attempts[1].outcome).to.equal("retry-exhausted");
    expect(resolved.attempts[1].errorCode).to.equal("timeout-2");
    expect(resolved.attempts[2].candidateDigest).to.equal(digest);
    expect(resolved.candidate.digest).to.equal(digest);
  });

  it("非重试失败只保留一次实际 evidence，不伪造 Search 尝试", async function () {
    let searchCalls = 0;
    const onlyEvidence = attemptEvidence("url.web", 1, "no-result");
    const resolver = createResolver({
      urlWebRoute: {
        id: "url.web",
        async attempt() {
          return { candidate: null, evidence: onlyEvidence, retryable: false };
        },
      },
      doiSearchRoute: {
        id: "doi.search",
        async attempt() {
          searchCalls += 1;
          throw new Error("不应调用");
        },
      },
    });

    const resolved = await resolver.resolve({ item, url: "https://example.test/paper" });
    expect(resolved.terminalOutcome).to.equal("no-safe-candidate");
    expect(resolved.attempts).to.deep.equal([onlyEvidence]);
    expect(searchCalls).to.equal(0);
  });

  it("DOI Search 同样最多尝试两次，耗尽后不产生第三条 evidence", async function () {
    let searchCalls = 0;
    const resolver = createResolver({
      urlWebRoute: {
        id: "url.web",
        async attempt() {
          throw new Error("无 URL 时不应调用");
        },
      },
      doiSearchRoute: {
        id: "doi.search",
        async attempt(request) {
          searchCalls += 1;
          return {
            candidate: null,
            retryable: true,
            evidence: attemptEvidence("doi.search", request.attempt, "fetch-failed"),
          };
        },
      },
    });

    const resolved = await resolver.resolve({ item, doi: "10.1000/test" });
    expect(searchCalls).to.equal(2);
    expect(resolved.terminalOutcome).to.equal("no-safe-candidate");
    expect(resolved.attempts.map((entry) => entry.outcome)).to.deep.equal([
      "fetch-failed",
      "retry-exhausted",
    ]);
  });
});
