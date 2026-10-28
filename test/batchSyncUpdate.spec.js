const { assert, expect } = require("chai");

describe("batchSyncUpdate（纯 mock，不写真实 Zotero 库）", function () {
  let api;

  before(function () {
    api = { ...Zotero.zmtaAddon.api, ...Zotero.zmtaAddon.testApi };
    assert.isFunction(api.preflightBatch, "主入口应暴露只读 preflightBatch");
    assert.isFunction(api.applyBatch, "测试构建应暴露 applyBatch");
    assert.isFunction(api.retryFailedBatch, "测试构建应暴露 retryFailedBatch");
  });

  function makeItem(id, options = {}) {
    const fields = {
      title: options.title ?? `书 ${id}`,
      url: options.url ?? `https://book.douban.com/subject/${1000 + id}/`,
      publisher: options.publisher ?? "",
    };
    const counters = { set: 0, save: 0 };
    let creators = (options.creators || []).map((creator) => ({ ...creator }));
    const creatorCalls = [];
    return {
      id,
      key: options.key ?? `KEY${id}`,
      libraryID: 1,
      itemType: options.itemType ?? "book",
      fields,
      counters,
      creatorCalls,
      isNote: () => Boolean(options.isNote),
      isAttachment: () => Boolean(options.isAttachment),
      getField: (field) => fields[field] ?? "",
      getCreators: () => creators.map((creator) => ({ ...creator })),
      getCreatorsJSON: () => creators.map((creator) => ({ ...creator })),
      setCreators: (value, settings) => {
        creatorCalls.push({ value: value.map((creator) => ({ ...creator })), settings });
        creators = value.map((creator) => ({ ...creator }));
      },
      setField: (field, value) => {
        counters.set += 1;
        fields[field] = value;
      },
      saveTx: async () => {
        counters.save += 1;
        if (options.saveFails) throw new Error("save failed");
        if (options.onSave) await options.onSave(fields);
      },
    };
  }

  function incomingFor(item, extra = {}) {
    return {
      itemType: item.itemType,
      url: item.fields.url,
      title: item.fields.title,
      ...extra,
    };
  }

  function selectionFrom(preview) {
    return {
      itemID: preview.itemID,
      itemKey: preview.itemKey,
      fields: preview.fields,
      creators: preview.creators,
      attachments: preview.attachments,
      notes: preview.notes,
      candidate: preview.candidate,
    };
  }

  it("支持 1 条与 50 条，并在 51 条时于 fetch 前拒绝", async function () {
    const one = makeItem(1);
    let fetches = 0;
    const fetch = async (url) => {
      fetches += 1;
      return { itemType: "book", url, title: "上游标题" };
    };
    expect(await api.preflightBatch([one], { fetch })).to.have.length(1);

    const fifty = Array.from({ length: 50 }, (_, index) => makeItem(index + 10));
    expect(await api.preflightBatch(fifty, { fetch })).to.have.length(50);
    const beforeLimitCheck = fetches;
    let thrown;
    try {
      await api.preflightBatch([...fifty, makeItem(99)], { fetch });
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.name).to.equal("BatchLimitError");
    expect(fetches).to.equal(beforeLimitCheck, "超限不得开始网络预检");
  });

  it("0、1、50 条发送稳定的批次、条目与路线进度", async function () {
    const zeroEvents = [];
    expect(await api.preflightBatch([], { onProgress: (event) => zeroEvents.push(event) })).to.deep.equal([]);
    expect(zeroEvents.map((event) => event.stage)).to.deep.equal(["batch-start", "batch-complete"]);
    expect(zeroEvents.map(({ completed, total }) => [completed, total])).to.deep.equal([[0, 0], [0, 0]]);

    for (const count of [1, 50]) {
      const events = [];
      const items = Array.from({ length: count }, (_, index) => makeItem(100 + index));
      const previews = await api.preflightBatch(items, {
        fetch: async (url) => ({ itemType: "book", url, title: "上游标题" }),
        onProgress: (event) => events.push(event),
      });
      expect(previews).to.have.length(count);
      expect(events[0]).to.include({ stage: "batch-start", completed: 0, total: count });
      expect(events.at(-1)).to.include({ stage: "batch-complete", completed: count, total: count });
      expect(events.filter((event) => event.stage === "item-start")).to.have.length(count);
      expect(events.filter((event) => event.stage === "route-start")).to.have.length(count);
      expect(events.filter((event) => event.stage === "item-complete").map((event) => event.completed))
        .to.deep.equal(Array.from({ length: count }, (_, index) => index + 1));
    }
  });

  it("ready、blocked、failed、skipped 均按原顺序完成并推进 completed", async function () {
    const items = [
      makeItem(1),
      makeItem(2),
      makeItem(3),
      makeItem(4, { itemType: "journalArticle" }),
    ];
    const events = [];
    const previews = await api.preflightBatch(items, {
      fetch: async (url) => {
        if (url.includes("1002")) return { itemType: "journalArticle", url, title: "类型冲突" };
        if (url.includes("1003")) throw new Error("temporary failure");
        return { itemType: "book", url, title: "安全候选" };
      },
      onProgress: (event) => events.push(event),
    });

    expect(previews.map((preview) => preview.itemKey)).to.deep.equal(items.map((item) => item.key));
    expect(previews.map((preview) => preview.status)).to.deep.equal(["ready", "blocked", "failed", "skipped"]);
    const completed = events.filter((event) => event.stage === "item-complete");
    expect(completed.map((event) => event.status)).to.deep.equal(["ready", "blocked", "failed", "skipped"]);
    expect(completed.map((event) => event.completed)).to.deep.equal([1, 2, 3, 4]);
  });

  it("请求前取消不发请求，并以 stopping/cancelled 结束而非失败预览", async function () {
    const controller = new AbortController();
    controller.abort();
    const events = [];
    let fetches = 0;
    let thrown;
    try {
      await api.preflightBatch([makeItem(1)], {
        signal: controller.signal,
        fetch: async () => { fetches += 1; return {}; },
        onProgress: (event) => events.push(event),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.be.instanceOf(api.BatchPreflightCancelledError);
    expect(thrown).to.include({ completed: 0, total: 1 });
    expect(fetches).to.equal(0);
    expect(events.map((event) => event.stage)).to.deep.equal(["batch-start", "stopping", "cancelled"]);
    expect(events.some((event) => event.stage === "item-complete")).to.equal(false);
  });

  it("请求中取消会等待当前请求结束，随后不发下一条", async function () {
    const controller = new AbortController();
    const events = [];
    let resolveFetch;
    let fetches = 0;
    const running = api.preflightBatch([makeItem(1), makeItem(2)], {
      signal: controller.signal,
      fetch: async (url) => {
        fetches += 1;
        return new Promise((resolve) => { resolveFetch = () => resolve({ itemType: "book", url, title: "候选" }); });
      },
      onProgress: (event) => events.push(event),
    });
    await Promise.resolve();
    controller.abort();
    expect(events.at(-1).stage).to.equal("stopping");
    resolveFetch();
    let thrown;
    try {
      await running;
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.be.instanceOf(api.BatchPreflightCancelledError);
    expect(fetches).to.equal(1);
    expect(events.at(-1).stage).to.equal("cancelled");
    expect(events.some((event) => event.stage === "item-complete")).to.equal(false);
  });

  it("第一次 Web 失败后取消，不启动第二次 Web 或 DOI Search", async function () {
    const controller = new AbortController();
    const calls = [];
    const routeFailure = (routeId, attempt) => ({
      candidate: null,
      retryable: true,
      evidence: {
        routeId,
        attempt,
        inputIdentifiers: [],
        returnedIdentifiers: [],
        sourceId: routeId,
        fetchedAt: "2026-08-30T00:00:00.000Z",
        outcome: "fetch-failed",
      },
    });
    const resolver = api.createDOIFallbackResolver({
      urlWebRoute: {
        id: "url.web",
        async attempt(request) {
          calls.push(`url.web:${request.attempt}`);
          controller.abort();
          return routeFailure("url.web", request.attempt);
        },
      },
      doiSearchRoute: {
        id: "doi.search",
        async attempt(request) {
          calls.push(`doi.search:${request.attempt}`);
          return routeFailure("doi.search", request.attempt);
        },
      },
    });
    const item = makeItem(1);
    item.fields.DOI = "10.1000/test";
    const events = [];
    let thrown;
    try {
      await api.preflightBatch([item], {
        resolver,
        signal: controller.signal,
        onProgress: (event) => events.push(event),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.be.instanceOf(api.BatchPreflightCancelledError);
    expect(calls).to.deep.equal(["url.web:1"]);
    expect(events.filter((event) => event.stage === "route-start").map((event) => `${event.routeId}:${event.attempt}`))
      .to.deep.equal(["url.web:1"]);
    expect(events.slice(-2).map((event) => event.stage)).to.deep.equal(["stopping", "cancelled"]);
  });

  it("过滤 note/attachment，并严格顺序调用 Translator", async function () {
    const first = makeItem(1);
    const second = makeItem(2);
    const order = [];
    let active = 0;
    let maxActive = 0;
    const fetch = async (url) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(url);
      await Promise.resolve();
      active -= 1;
      return { url, publisher: "新出版社" };
    };
    const previews = await api.preflightBatch([
      makeItem(8, { isNote: true }),
      first,
      makeItem(9, { isAttachment: true }),
      second,
    ], { fetch });
    expect(previews.map((entry) => entry.itemKey)).to.deep.equal([first.key, second.key]);
    expect(order).to.deep.equal([first.fields.url, second.fields.url]);
    expect(maxActive).to.equal(1);
  });

  it("预检保留所有普通书目；旧 Douban Provider 仍只适用于 book", async function () {
    const book = makeItem(1);
    const journal = makeItem(2, { itemType: "journalArticle" });
    let fetches = 0;
    const previews = await api.preflightBatch([journal, book], {
      fetch: async (url) => { fetches += 1; return { itemType: "book", url, publisher: "新出版社" }; },
    });
    expect(previews.map((entry) => entry.itemKey)).to.deep.equal([journal.key, book.key]);
    expect(previews[0].status).to.equal("skipped");
    expect(fetches).to.equal(1);

    const result = await api.applyBatch([{
      itemID: journal.id,
      itemKey: journal.key,
      fields: [{ field: "publisher", local: "", incoming: "新出版社", isConflict: false, defaultChecked: true }],
      attachments: [],
      notes: [],
    }], { getItem: () => journal });
    expect(result.items[0].status).to.equal("failed");
    expect(journal.counters).to.deep.equal({ set: 0, save: 0 });
  });

  it("预检零写入，字段默认值按缺失/覆盖区分，附件和 notes 分区且不判重", async function () {
    const item = makeItem(1, { publisher: "本地出版社" });
    const duplicateAttachment = { url: "https://example.test/a.pdf", title: "PDF", mimeType: "application/pdf" };
    const previews = await api.preflightBatch([item], {
      fetch: async () => incomingFor(item, {
        publisher: "上游出版社",
        language: "zh-CN",
        extra: "不得进入批量字段候选",
        attachments: [duplicateAttachment, duplicateAttachment],
        notes: [{ note: "同一 note" }, { note: "同一 note" }],
      }),
    });
    const preview = previews[0];
    const publisher = preview.fields.find((entry) => entry.field === "publisher");
    const language = preview.fields.find((entry) => entry.field === "language");
    expect(publisher).to.include({ isConflict: true, defaultChecked: false });
    expect(language).to.include({ isConflict: false, defaultChecked: true });
    expect(preview.fields.some((entry) => entry.field === "extra")).to.equal(false);
    expect(preview.attachments).to.have.length(2, "第一版不判重");
    expect(preview.notes).to.have.length(2, "第一版不判重");
    expect(new Set(preview.attachments.map((entry) => entry.batchOperationId)).size).to.equal(2, "重复附件仍各自拥有日志身份");
    expect(new Set(preview.notes.map((entry) => entry.batchOperationId)).size).to.equal(2, "重复 note 仍各自拥有日志身份");
    expect(preview.notes[0].defaultChecked).to.equal(true);
    expect(item.counters).to.deep.equal({ set: 0, save: 0 });
  });

  it("Creator 候选作为一个有序整体预览并通过统一执行链全量替换", async function () {
    const local = [{ firstName: "旧", lastName: "作者", creatorType: "author" }];
    const incoming = [
      { name: "新机构", creatorType: "author" },
      { firstName: "新", lastName: "译者", creatorType: "translator" },
    ];
    const item = makeItem(1, { creators: local });
    const preview = (await api.preflightBatch([item], {
      fetch: async () => incomingFor(item, { creators: incoming }),
    }))[0];

    expect(preview.creators).to.deep.include({
      local,
      incoming,
      isConflict: true,
      defaultChecked: false,
    });
    expect(item.creatorCalls).to.deep.equal([]);

    const events = [];
    const result = await api.applyBatch([selectionFrom(preview)], {
      getItem: () => item,
      onOperationStatus: (event) => events.push(event),
    });
    expect(result.items[0].status).to.equal("applied");
    expect(result.items[0].operations[0]).to.include({
      kind: "creators", identity: "creators:set", status: "applied",
    });
    expect(item.getCreatorsJSON()).to.deep.equal(incoming);
    expect(item.creatorCalls[0].settings).to.deep.equal({ strict: true });
    expect(events.filter((event) => event.kind === "creators").map((event) => event.status))
      .to.deep.equal(["planned", "applied"]);
  });

  it("同源验证失败时产生失败预览且零写入", async function () {
    const item = makeItem(1);
    const previews = await api.preflightBatch([item], {
      fetch: async () => ({
        itemType: "book",
        url: "https://book.douban.com/subject/999999/",
        title: "另一条目",
      }),
    });
    expect(previews[0].status).to.equal("failed");
    expect(previews[0].message).to.include("同源验证失败");
    expect(item.counters).to.deep.equal({ set: 0, save: 0 });
  });

  it("豆瓣 Translator 返回非 book 类型时由 Planner 阻断，不用本地类型占位", async function () {
    const item = makeItem(1);
    const preview = (await api.preflightBatch([item], {
      fetch: async () => incomingFor(item, { itemType: "journalArticle", publisher: "不应放行" }),
    }))[0];

    expect(preview.status).to.equal("blocked");
    expect(preview.message).to.include("类型不一致");
    expect(preview.fields).to.deep.equal([]);
    expect(item.counters).to.deep.equal({ set: 0, save: 0 });
  });

  it("字段、附件与 notes 逐项应用；一条失败不影响下一条", async function () {
    const failedItem = makeItem(1, { saveFails: true });
    const goodItem = makeItem(2);
    const items = new Map([[failedItem.id, failedItem], [goodItem.id, goodItem]]);
    const attachmentCalls = [];
    const noteCalls = [];
    const selections = [failedItem, goodItem].map((item) => ({
      itemID: item.id,
      itemKey: item.key,
      fields: [{ field: "publisher", local: "", incoming: "新出版社", isConflict: false, defaultChecked: true }],
      attachments: [{ url: `https://example.test/${item.id}.pdf`, title: "PDF", mimeType: "application/pdf" }],
      notes: [{ content: `note-${item.id}`, defaultChecked: true }],
    }));
    const events = [];
    const result = await api.applyBatch(selections, {
      batchId: "batch-test",
      getItem: (id) => items.get(id),
      addAttachment: async (item, attachment) => {
        attachmentCalls.push([item.id, attachment.url]);
        return { key: `ATT${item.id}` };
      },
      createNote: async (item, note) => {
        noteCalls.push([item.id, note.content]);
        return { key: `NOTE${item.id}` };
      },
      onOperationStatus: (event) => events.push(event),
    });
    expect(result.items[0].status).to.equal("partial");
    expect(result.items[1].status).to.equal("applied");
    expect(result.partial).to.equal(1);
    expect(result.applied).to.equal(1);
    expect(goodItem.fields.publisher).to.equal("新出版社");
    expect(attachmentCalls).to.have.length(2);
    expect(noteCalls).to.have.length(2);
    expect(events.some((event) => event.status === "planned")).to.equal(true);
    expect(events.some((event) => event.createdItemKey === "ATT2")).to.equal(true);
    expect(events.some((event) => event.createdItemKey === "NOTE2")).to.equal(true);
  });

  it("附件与 notes 仅调用新增接口，不触碰既有内容", async function () {
    const item = makeItem(1);
    const calls = { attachments: 0, notes: 0 };
    const result = await api.applyBatch([{
      itemID: item.id,
      itemKey: item.key,
      fields: [],
      attachments: [
        { url: "https://example.test/a.pdf", title: "重复候选", mimeType: "application/pdf" },
        { url: "https://example.test/a.pdf", title: "重复候选", mimeType: "application/pdf" },
      ],
      notes: [
        { content: "重复 note", defaultChecked: true },
        { content: "重复 note", defaultChecked: true },
      ],
    }], {
      getItem: () => item,
      addAttachment: async () => { calls.attachments += 1; },
      createNote: async () => { calls.notes += 1; },
    });
    expect(result.items[0].status).to.equal("applied");
    expect(calls).to.deep.equal({ attachments: 2, notes: 2 });
    expect(item.counters).to.deep.equal({ set: 0, save: 0 });
  });

  it("审核后本地字段变化时拒绝覆盖，但仍继续处理该条目的增量内容", async function () {
    const item = makeItem(1, { publisher: "审核时的值" });
    const selection = {
      itemID: item.id,
      itemKey: item.key,
      fields: [{ field: "publisher", local: "审核时的值", incoming: "上游新值", isConflict: true, defaultChecked: false }],
      attachments: [{ url: "https://example.test/a.pdf", title: "PDF", mimeType: "application/pdf" }],
      notes: [],
    };
    item.fields.publisher = "用户稍后修改";
    let attachmentCalls = 0;
    const result = await api.applyBatch([selection], {
      getItem: () => item,
      addAttachment: async () => { attachmentCalls += 1; return { key: "ATT1" }; },
    });
    expect(item.fields.publisher).to.equal("用户稍后修改");
    expect(item.counters.save).to.equal(0);
    expect(attachmentCalls).to.equal(1);
    expect(result.items[0].status).to.equal("partial");
    expect(result.items[0].operations[0].message).to.include("本地字段已变化");
  });

  it("planned 异步落盘期间字段变化时重新读取并拒绝覆盖", async function () {
    const item = makeItem(1, { publisher: "审核时的值" });
    const result = await api.applyBatch([{
      itemID: item.id,
      itemKey: item.key,
      fields: [{ field: "publisher", local: "审核时的值", incoming: "上游新值", isConflict: true, defaultChecked: false }],
      attachments: [],
      notes: [],
    }], {
      getItem: () => item,
      onOperationStatus: async (event) => {
        if (event.kind === "field" && event.status === "planned") {
          await Promise.resolve();
          item.fields.publisher = "用户在日志落盘期间修改";
        }
      },
    });
    expect(item.fields.publisher).to.equal("用户在日志落盘期间修改");
    expect(item.counters).to.deep.equal({ set: 0, save: 0 });
    expect(result.items[0].status).to.equal("failed");
  });

  it("多字段 planned 全部完成后统一重读，早先字段的后续变化也不覆盖", async function () {
    const item = makeItem(1, { publisher: "出版旧值" });
    item.fields.language = "语言旧值";
    const result = await api.applyBatch([{
      itemID: item.id,
      itemKey: item.key,
      fields: [
        { field: "publisher", local: "出版旧值", incoming: "出版新值", isConflict: true, defaultChecked: false },
        { field: "language", local: "语言旧值", incoming: "语言新值", isConflict: true, defaultChecked: false },
      ],
      attachments: [],
      notes: [],
    }], {
      getItem: () => item,
      onOperationStatus: async (event) => {
        if (event.kind === "field" && event.status === "planned" && event.identity === "language") {
          item.fields.publisher = "用户在第二个字段日志期间修改";
        }
      },
    });
    expect(item.fields.publisher).to.equal("用户在第二个字段日志期间修改");
    expect(item.fields.language).to.equal("语言新值");
    expect(result.items[0].status).to.equal("partial");
  });

  it("字段 applied 事件记录 saveTx 后的实际规范值", async function () {
    const item = makeItem(1, {
      publisher: "旧值",
      onSave: (fields) => { fields.publisher = "规范值"; },
    });
    const events = [];
    await api.applyBatch([{
      itemID: item.id,
      itemKey: item.key,
      fields: [{ field: "publisher", local: "旧值", incoming: "待规范值", isConflict: true, defaultChecked: false }],
      attachments: [],
      notes: [],
    }], {
      getItem: () => item,
      onOperationStatus: (event) => events.push(event),
    });
    const applied = events.find((event) => event.kind === "field" && event.status === "applied");
    expect(applied.after).to.equal("规范值");
  });

  it("字段 applied 日志失败时恢复旧值并把操作标为失败", async function () {
    const item = makeItem(1, { publisher: "旧值" });
    const result = await api.applyBatch([{
      itemID: item.id,
      itemKey: item.key,
      fields: [{ field: "publisher", local: "旧值", incoming: "新值", isConflict: true, defaultChecked: false }],
      attachments: [],
      notes: [],
    }], {
      getItem: () => item,
      onOperationStatus: (event) => {
        if (event.kind === "field" && event.status === "applied") throw new Error("journal unavailable");
      },
    });
    expect(item.fields.publisher).to.equal("旧值");
    expect(item.counters.save).to.equal(2, "首次写入后应再保存一次补偿值");
    expect(result.items[0].status).to.equal("failed");
    expect(result.items[0].operations[0].message).to.include("已恢复审核前字段值");
  });

  it("附件与 note 的 applied 日志失败时回收刚创建的子条目", async function () {
    const item = makeItem(1);
    const trashed = [];
    const result = await api.applyBatch([{
      itemID: item.id,
      itemKey: item.key,
      fields: [],
      attachments: [{ url: "https://example.test/a.pdf", title: "PDF", mimeType: "application/pdf" }],
      notes: [{ content: "note", defaultChecked: true }],
    }], {
      getItem: () => item,
      addAttachment: async () => ({ id: 11, key: "ATT1" }),
      createNote: async () => ({ id: 12, key: "NOTE1" }),
      trashCreatedItem: async (created) => { trashed.push(created.id); },
      onOperationStatus: (event) => {
        if (event.status === "applied") throw new Error("journal unavailable");
      },
    });
    expect(trashed).to.deep.equal([11, 12]);
    expect(result.items[0].status).to.equal("failed");
    expect(result.items[0].operations).to.have.length(2);
    expect(result.items[0].operations.every((entry) => entry.status === "failed")).to.equal(true);
  });

  it("applied 日志与补偿都失败时明确报告严重失败", async function () {
    const item = makeItem(1);
    const result = await api.applyBatch([{
      itemID: item.id,
      itemKey: item.key,
      fields: [],
      attachments: [{ url: "https://example.test/a.pdf", title: "PDF", mimeType: "application/pdf" }],
      notes: [],
    }], {
      getItem: () => item,
      addAttachment: async () => ({ id: 11, key: "ATT1" }),
      trashCreatedItem: async () => { throw new Error("trash unavailable"); },
      onOperationStatus: (event) => {
        if (event.status === "applied") throw new Error("journal unavailable");
      },
    });
    expect(result.items[0].operations[0].message).to.include("严重");
    expect(result.items[0].operations[0].message).to.include("补偿也失败");
  });

  it("失败项重试会重新同源预检，且不重复成功字段与附件", async function () {
    const item = makeItem(1);
    const incoming = incomingFor(item, {
      publisher: "新出版社",
      attachments: [{ url: "https://example.test/a.pdf", title: "PDF", mimeType: "application/pdf" }],
      notes: [{ note: "待重试 note" }],
    });
    const preview = (await api.preflightBatch([item], { fetch: async () => incoming }))[0];
    const original = selectionFrom(preview);
    let attachmentCalls = 0;
    let noteCalls = 0;
    const first = await api.applyBatch([original], {
      batchId: "batch-retry",
      getItem: () => item,
      addAttachment: async () => { attachmentCalls += 1; return { key: "ATT1" }; },
      createNote: async () => {
        noteCalls += 1;
        throw new Error("temporary note failure");
      },
    });
    expect(first.items[0].status).to.equal("partial");

    let retryFetches = 0;
    const retried = await api.retryFailedBatch([original], first, {
      getItem: () => item,
      fetch: async () => { retryFetches += 1; return incoming; },
      addAttachment: async () => { attachmentCalls += 1; },
      createNote: async () => { noteCalls += 1; return { key: "NOTE1" }; },
    });
    expect(retryFetches).to.equal(1);
    expect(retried.items).to.have.length(1);
    expect(retried.items[0].operations.map((entry) => entry.kind)).to.deep.equal(["note"]);
    expect(attachmentCalls).to.equal(1, "成功附件不得重复新增");
    expect(item.counters.save).to.equal(1, "成功字段不得重复保存");
    expect(noteCalls).to.equal(2, "只重试上次失败的 note");
  });

  it("Creator 整组失败后只重试同一份已审核名单", async function () {
    const local = [{ firstName: "旧", lastName: "作者", creatorType: "author" }];
    const incomingCreators = [{ firstName: "新", lastName: "作者", creatorType: "author" }];
    const item = makeItem(1, { creators: local });
    const incoming = incomingFor(item, { creators: incomingCreators });
    const preview = (await api.preflightBatch([item], { fetch: async () => incoming }))[0];
    const original = selectionFrom(preview);
    const previous = {
      batchId: "batch-creator-retry",
      total: 1,
      applied: 0,
      partial: 0,
      skipped: 0,
      failed: 1,
      items: [{
        itemID: item.id,
        itemKey: item.key,
        title: item.fields.title,
        status: "failed",
        operations: [{ kind: "creators", identity: "creators:set", status: "failed" }],
      }],
    };

    const retried = await api.retryFailedBatch([original], previous, {
      getItem: () => item,
      fetch: async () => incoming,
    });
    expect(retried.items[0].operations[0]).to.include({
      kind: "creators", identity: "creators:set", status: "applied",
    });
    expect(item.getCreatorsJSON()).to.deep.equal(incomingCreators);
  });

  it("附件身份不依赖勾选数组位置，能重试只勾选的第二项", async function () {
    const item = makeItem(1);
    const attachments = [
      { url: "https://example.test/first.pdf", title: "一", mimeType: "application/pdf" },
      { url: "https://example.test/second.pdf", title: "二", mimeType: "application/pdf" },
    ];
    const incoming = incomingFor(item, { attachments });
    const preview = (await api.preflightBatch([item], { fetch: async () => incoming }))[0];
    const original = {
      ...selectionFrom(preview),
      attachments: [preview.attachments[1]],
    };
    const first = await api.applyBatch([original], {
      getItem: () => item,
      addAttachment: async () => { throw new Error("已勾选的第二个附件失败"); },
    });
    const retriedURLs = [];
    await api.retryFailedBatch([original], first, {
      getItem: () => item,
      fetch: async () => incoming,
      addAttachment: async (_target, attachment) => {
        retriedURLs.push(attachment.url);
        return { key: "ATT2" };
      },
    });
    expect(retriedURLs).to.deep.equal(["https://example.test/second.pdf"]);
  });

  it("字段重试同时校验原审核 local 与 incoming，本地变化时不自动重试", async function () {
    const item = makeItem(1, { publisher: "审核时旧值" });
    const original = {
      itemID: item.id,
      itemKey: item.key,
      fields: [{ field: "publisher", local: "审核时旧值", incoming: "上游新值", isConflict: true, defaultChecked: false }],
      attachments: [],
      notes: [],
    };
    const previous = {
      batchId: "batch-field-retry",
      total: 1,
      applied: 0,
      partial: 0,
      skipped: 0,
      failed: 1,
      items: [{
        itemID: item.id,
        itemKey: item.key,
        title: item.fields.title,
        status: "failed",
        operations: [{ kind: "field", identity: "publisher", status: "failed" }],
      }],
    };
    item.fields.publisher = "人工后续值";
    const retried = await api.retryFailedBatch([original], previous, {
      getItem: () => item,
      fetch: async () => incomingFor(item, { publisher: "上游新值" }),
    });
    expect(retried.total).to.equal(0);
    expect(item.fields.publisher).to.equal("人工后续值");
    expect(item.counters).to.deep.equal({ set: 0, save: 0 });
  });

  it("重试重新预检透传取消合同，取消前后均不触发 resolved/apply 回调", async function () {
    const item = makeItem(1);
    const original = {
      itemID: item.id,
      itemKey: item.key,
      fields: [{ field: "publisher", local: "", incoming: "新值", isConflict: false, defaultChecked: true }],
      attachments: [],
      notes: [],
    };
    const previous = {
      batchId: "batch-cancelled-retry",
      total: 1,
      applied: 0,
      partial: 0,
      skipped: 0,
      failed: 1,
      items: [{
        itemID: item.id,
        itemKey: item.key,
        title: item.fields.title,
        status: "failed",
        operations: [{ kind: "field", identity: "publisher", status: "failed" }],
      }],
    };
    const controller = new AbortController();
    controller.abort();
    const calls = { get: 0, fetch: 0, resolved: 0, operation: 0 };
    const events = [];
    let thrown;
    try {
      await api.retryFailedBatch([original], previous, {
        signal: controller.signal,
        onProgress: (event) => events.push(event),
        getItem: () => { calls.get += 1; return item; },
        fetch: async () => { calls.fetch += 1; return incomingFor(item); },
        onResolvedSelections: () => { calls.resolved += 1; },
        onOperationStatus: () => { calls.operation += 1; },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).to.be.instanceOf(api.BatchPreflightCancelledError);
    expect(calls).to.deep.equal({ get: 0, fetch: 0, resolved: 0, operation: 0 });
    expect(events.map((event) => event.stage)).to.deep.equal(["batch-start", "stopping", "cancelled"]);
  });
});
