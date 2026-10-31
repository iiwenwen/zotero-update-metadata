const { expect } = require("chai");

describe("只读候选取消与默认豆瓣诊断（离线）", function () {
  let api;
  const item = () => ({ id: 1, key: "A", libraryID: 1, itemType: "book",
    isRegularItem: () => true, getCreatorsJSON: () => [],
    getField: field => ({ title: "书", url: "https://book.douban.com/subject/1/" })[field] || "",
    setField: () => { throw new Error("禁止写入"); }, saveTx: () => { throw new Error("禁止写入"); } });
  before(function () { api = Zotero.zmtaAddon.uiTestApi; });

  it("旧Provider请求不返回时也能取消，迟到结果不生成预览或下一条请求", async function () {
    const controller = new AbortController();
    let finishFetch, fetches = 0;
    const events = [];
    const pending = api.preflightBatch([item(), { ...item(), id: 2, key: "B" }], {
      signal: controller.signal,
      fetch: url => { fetches++; return new Promise(resolve => { finishFetch = () => resolve({ itemType: "book", title: "书", url }); }); },
      onProgress: event => events.push(event.stage),
    });
    const outcome = pending.catch(error => error);
    await Promise.resolve(); controller.abort();
    try {
      const error = await Promise.race([outcome, new Promise((_, reject) => setTimeout(() => reject(new Error("取消还在等待来源")), 100))]);
      expect(error.name).to.equal("BatchPreflightCancelledError");
      expect(fetches).to.equal(1);
      expect(events.slice(-2)).to.deep.equal(["stopping", "cancelled"]);
    } finally { finishFetch(); }
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(fetches).to.equal(1);
    expect(events).not.to.include("item-complete");
  });

  it("默认豆瓣路线包装后仍保留标题解析原因，不误报网络故障", async function () {
    const originalHTTP = Zotero.HTTP, originalTranslate = Zotero.Translate, originalLocale = Zotero.locale;
    Zotero.HTTP = { ...originalHTTP, processDocuments: async (_url, visitor) => [visitor({})] };
    Zotero.Translate = { Web: class {
      setDocument() {} getTranslators() { return Promise.resolve([{ label: "Douban" }]); }
      setTranslator() {} translate() { return Promise.reject(new Error("No title specified for item")); }
    } };
    Zotero.locale = "zh-CN";
    try {
      const [preview] = await api.preflightBatch([item()]);
      expect(preview.message).to.include("未获取到标题");
      expect(preview.message).not.to.include("检查网络");
      expect(preview.attempts[0].diagnostic.stage).to.equal("translator-run");
      expect(preview.attempts[0].diagnostic.message).to.include("No title specified");
    } finally { Zotero.HTTP = originalHTTP; Zotero.Translate = originalTranslate; Zotero.locale = originalLocale; }
  });
});
