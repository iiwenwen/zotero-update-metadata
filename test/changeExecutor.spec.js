const { assert, expect } = require("chai");

describe("ChangeExecutor（fake Port，不写真实 Zotero 库）", function () {
  let api;

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  before(function () {
    api = { ...Zotero.zmtaAddon?.api, ...Zotero.zmtaAddon?.testApi };
    assert.isFunction(api?.ChangeExecutor, "测试构建应暴露 ChangeExecutor");
  });

  function itemRef(overrides = {}) {
    return {
      itemID: 1,
      itemKey: "BOOK1",
      libraryID: 1,
      itemType: "book",
      title: "测试图书",
      ...overrides,
    };
  }

  function plan(operations, overrides = {}) {
    return api.createChangePlan({
      planId: "plan-1",
      createdAt: "2026-08-30T00:00:00.000Z",
      items: [{
        item: itemRef(),
        evidence: [{
          providerId: "fake",
          sourceURL: "https://example.test/book/1",
          identifiers: [{ type: "fake-id", value: "1" }],
          fetchedAt: "2026-08-30T00:00:00.000Z",
        }],
        operations,
      }],
      ...overrides,
    });
  }

  function fakePort(options = {}) {
    const item = {
      fields: { title: "旧标题", publisher: "旧出版社", ...(options.fields || {}) },
      creators: clone(options.creators || [
        { creatorType: "author", firstName: "旧", lastName: "作者" },
      ]),
    };
    const calls = [];
    let saves = 0;
    let creatorReads = 0;
    let createdSequence = 0;
    return {
      item,
      calls,
      get saves() { return saves; },
      async getItem(ref) {
        calls.push(["getItem", ref.itemKey]);
        if (options.missing) return null;
        if (options.getItemError) throw options.getItemError;
        return item;
      },
      getField(target, field) {
        calls.push(["getField", field]);
        if (options.onGetField) options.onGetField(target, field, calls);
        return target.fields[field] ?? "";
      },
      setField(target, field, value) {
        calls.push(["setField", field, value]);
        if (options.setFieldError) throw options.setFieldError;
        target.fields[field] = value;
      },
      getCreators(target) {
        creatorReads += 1;
        calls.push(["getCreators"]);
        if (options.onGetCreators) options.onGetCreators(target, calls);
        if (options.getCreatorsError || options.getCreatorsErrorAt === creatorReads) {
          throw options.getCreatorsError || new Error(`get-creators-${creatorReads}-failed`);
        }
        return clone(target.creators);
      },
      setCreators(target, creators) {
        calls.push(["setCreators", clone(creators)]);
        if (options.setCreatorsError) throw options.setCreatorsError;
        target.creators = clone(creators);
      },
      async saveItem() {
        saves += 1;
        calls.push(["saveItem", saves]);
        if (options.saveErrorAt === saves) throw new Error(`save-${saves}-failed`);
        if (options.afterSave) options.afterSave(item, saves);
      },
      async createAttachment(_item, candidate) {
        calls.push(["createAttachment", candidate.title]);
        if (options.attachmentError) throw options.attachmentError;
        createdSequence += 1;
        return { id: 100 + createdSequence, key: `ATT${createdSequence}` };
      },
      async createNote(_item, content) {
        calls.push(["createNote", content]);
        if (options.noteError) throw options.noteError;
        createdSequence += 1;
        return { id: 200 + createdSequence, key: `NOTE${createdSequence}` };
      },
      async trashCreatedItem(created) {
        calls.push(["trashCreatedItem", created.key]);
        if (options.trashError) throw options.trashError;
      },
      getCreatedItemKey(created) {
        return created.key;
      },
      // 本套件的合成创建立即完成，没有异步编辑；显式提供创建证明。
      getCreatedItemCreationFingerprint(created) { return `fixture-created:${created.key}`; },
    };
  }

  it("字段先全部记 planned，再统一复核并按条目只保存一次，applied 使用保存后实际值", async function () {
    const port = fakePort({
      afterSave(item, saves) {
        if (saves === 1) item.fields.title = "宿主规范化标题";
      },
    });
    const events = [];
    const executor = new api.ChangeExecutor(port, async (event) => events.push(event));
    const result = await executor.execute(plan([
      { kind: "field-set", operationId: "field:title", field: "title", before: "旧标题", after: "新标题" },
      { kind: "field-set", operationId: "field:publisher", field: "publisher", before: "旧出版社", after: "新出版社" },
    ]));

    expect(port.saves).to.equal(1);
    expect(events.map((event) => `${event.operation.operationId}:${event.status}`)).to.deep.equal([
      "field:title:planned",
      "field:publisher:planned",
      "field:title:applied",
      "field:publisher:applied",
    ]);
    expect(events[2].actualAfter).to.equal("宿主规范化标题");
    expect(result.items[0].operations.map((entry) => entry.status)).to.deep.equal(["applied", "applied"]);
    expect(result.items[0].status).to.equal("applied");
  });

  it("审核后字段发生变化时只拒绝冲突项，其他字段仍保存", async function () {
    let titleReads = 0;
    const port = fakePort({
      onGetField(item, field) {
        if (field === "title" && ++titleReads === 1) item.fields.title = "用户刚修改";
      },
    });
    const events = [];
    const result = await new api.ChangeExecutor(port, async (event) => events.push(event)).execute(plan([
      { kind: "field-set", operationId: "field:title", field: "title", before: "旧标题", after: "新标题" },
      { kind: "field-set", operationId: "field:publisher", field: "publisher", before: "旧出版社", after: "新出版社" },
    ]));

    expect(port.item.fields.title).to.equal("用户刚修改");
    expect(port.item.fields.publisher).to.equal("新出版社");
    expect(port.saves).to.equal(1);
    expect(result.items[0].operations).to.deep.include({
      operationId: "field:title",
      kind: "field-set",
      status: "failed",
      message: "审核后本地字段已变化，未覆盖",
    });
    expect(result.items[0].status).to.equal("partial");
    expect(events.find((event) => event.operation.operationId === "field:title" && event.status === "failed")).to.exist;
  });

  it("写前 planned 日志失败时不执行该操作，且不阻断后续操作", async function () {
    const port = fakePort();
    const executor = new api.ChangeExecutor(port, async (event) => {
      if (event.operation.operationId === "field:title" && event.status === "planned") {
        throw new Error("planned journal unavailable");
      }
    });
    const result = await executor.execute(plan([
      { kind: "field-set", operationId: "field:title", field: "title", before: "旧标题", after: "新标题" },
      { kind: "note-create", operationId: "note:1:0", content: "新增 Note" },
    ]));

    expect(port.item.fields.title).to.equal("旧标题");
    expect(port.calls).to.deep.include(["createNote", "新增 Note"]);
    expect(result.items[0].status).to.equal("partial");
  });

  it("字段保存失败时恢复内存值并逐项失败，仍继续新增附件", async function () {
    const port = fakePort({ saveErrorAt: 1 });
    const result = await new api.ChangeExecutor(port).execute(plan([
      { kind: "field-set", operationId: "field:title", field: "title", before: "旧标题", after: "新标题" },
      {
        kind: "attachment-create",
        operationId: "attachment:1:0",
        attachment: { url: "https://example.test/a.pdf", title: "PDF", mimeType: "application/pdf" },
      },
    ]));

    expect(port.item.fields.title).to.equal("旧标题");
    expect(result.items[0].operations.map((entry) => entry.status)).to.deep.equal(["failed", "applied"]);
    expect(result.items[0].status).to.equal("partial");
  });

  it("字段 applied 日志失败后统一恢复旧值；补偿失败返回严重错误并保留实际值依据", async function () {
    const normalPort = fakePort();
    const failApplied = async (event) => {
      if (event.operation.operationId === "field:publisher" && event.status === "applied") {
        throw new Error("applied journal unavailable");
      }
    };
    const compensated = await new api.ChangeExecutor(normalPort, failApplied).execute(plan([
      { kind: "field-set", operationId: "field:title", field: "title", before: "旧标题", after: "新标题" },
      { kind: "field-set", operationId: "field:publisher", field: "publisher", before: "旧出版社", after: "新出版社" },
    ]));
    expect(normalPort.item.fields).to.include({ title: "旧标题", publisher: "旧出版社" });
    expect(normalPort.saves).to.equal(2);
    expect(compensated.items[0].operations[0].message).to.include("已恢复审核前字段值");

    const severePort = fakePort({ saveErrorAt: 2 });
    const severeEvents = [];
    const severe = await new api.ChangeExecutor(severePort, async (event) => {
      severeEvents.push(event);
      await failApplied(event);
    }).execute(plan([
      { kind: "field-set", operationId: "field:title", field: "title", before: "旧标题", after: "新标题" },
      { kind: "field-set", operationId: "field:publisher", field: "publisher", before: "旧出版社", after: "新出版社" },
    ]));
    expect(severe.items[0].operations[0].message).to.include("[compensation-failed]");
    expect(severeEvents.find((event) => event.status === "failed")?.actualAfter).to.equal("新标题");
  });

  it("Creator 以一个完整有序列表写入，保存后实际列表进入 applied 事件", async function () {
    const before = [
      { creatorType: "author", firstName: "旧", lastName: "作者" },
    ];
    const after = [
      { creatorType: "author", firstName: "第一", lastName: "作者" },
      { creatorType: "translator", name: "翻译机构" },
    ];
    const port = fakePort({ creators: before });
    const events = [];
    const result = await new api.ChangeExecutor(port, async (event) => events.push(event)).execute(plan([
      { kind: "creators-set", operationId: "creators:1", before, after },
    ]));

    expect(port.item.creators).to.deep.equal(after);
    expect(port.saves).to.equal(1);
    expect(port.calls.filter((call) => call[0] === "setCreators")).to.have.length(1);
    expect(events.map((event) => event.status)).to.deep.equal(["planned", "applied"]);
    expect(events[1].actualAfter).to.deep.equal(after);
    expect(result.items[0].operations[0]).to.include({
      kind: "creators-set",
      status: "applied",
    });
  });

  it("没有 Creator 操作时不读取或写入 Creator", async function () {
    const port = fakePort();
    const result = await new api.ChangeExecutor(port).execute(plan([]));

    expect(result.items[0].status).to.equal("skipped");
    expect(port.calls).to.deep.equal([]);
  });

  it("Creator 顺序或角色在审核后变化即冲突，零写入且不影响同条目字段", async function () {
    const before = [
      { creatorType: "author", firstName: "甲", lastName: "作者" },
      { creatorType: "translator", firstName: "乙", lastName: "译者" },
    ];
    let reads = 0;
    const port = fakePort({
      creators: before,
      onGetCreators(item) {
        if (++reads === 1) item.creators = [before[1], before[0]];
      },
    });
    const result = await new api.ChangeExecutor(port).execute(plan([
      {
        kind: "creators-set",
        operationId: "creators:1",
        before,
        after: [{ creatorType: "author", firstName: "新", lastName: "作者" }],
      },
      { kind: "field-set", operationId: "field:title", field: "title", before: "旧标题", after: "新标题" },
    ]));

    expect(port.calls.filter((call) => call[0] === "setCreators")).to.have.length(0);
    expect(port.item.fields.title).to.equal("新标题");
    expect(result.items[0].operations[0].message).to.equal("审核后本地 Creator 列表已变化，未覆盖");
    expect(result.items[0].status).to.equal("partial");
  });

  it("Creator 保存失败只恢复内存 before；applied 日志失败则持久补偿", async function () {
    const before = [{ creatorType: "author", firstName: "旧", lastName: "作者" }];
    const after = [{ creatorType: "editor", firstName: "新", lastName: "编辑" }];
    const saveFailedPort = fakePort({ creators: before, saveErrorAt: 1 });
    const saveFailed = await new api.ChangeExecutor(saveFailedPort).execute(plan([
      { kind: "creators-set", operationId: "creators:1", before, after },
    ]));
    expect(saveFailedPort.item.creators).to.deep.equal(before);
    expect(saveFailedPort.saves).to.equal(1);
    expect(saveFailed.items[0].operations[0].message).to.include("写入失败");

    const journalFailedPort = fakePort({ creators: before });
    const journalFailed = await new api.ChangeExecutor(journalFailedPort, async (event) => {
      if (event.status === "applied") throw new Error("journal unavailable");
    }).execute(plan([
      { kind: "creators-set", operationId: "creators:1", before, after },
    ]));
    expect(journalFailedPort.item.creators).to.deep.equal(before);
    expect(journalFailedPort.saves).to.equal(2);
    expect(journalFailed.items[0].operations[0].message).to.include("已恢复审核前 Creator 列表");

    const rereadFailedPort = fakePort({ creators: before, getCreatorsErrorAt: 2 });
    const rereadFailed = await new api.ChangeExecutor(rereadFailedPort).execute(plan([
      { kind: "creators-set", operationId: "creators:1", before, after },
    ]));
    expect(rereadFailedPort.item.creators).to.deep.equal(after);
    expect(rereadFailedPort.saves).to.equal(1);
    expect(rereadFailed.items[0].operations[0].message).to.include("保存后重读失败");
    expect(rereadFailed.items[0].operations[0].message).to.include("compensation-failed");
  });

  it("Creator 补偿失败标记严重错误；同一条目拒绝两个 Creator 操作", async function () {
    const before = [{ creatorType: "author", firstName: "旧", lastName: "作者" }];
    const after = [{ creatorType: "author", firstName: "新", lastName: "作者" }];
    const severePort = fakePort({ creators: before, saveErrorAt: 2 });
    const severe = await new api.ChangeExecutor(severePort, async (event) => {
      if (event.status === "applied") throw new Error("journal unavailable");
    }).execute(plan([
      { kind: "creators-set", operationId: "creators:1", before, after },
    ]));
    expect(severe.items[0].operations[0].message).to.include("[compensation-failed]");

    let thrown;
    try {
      await new api.ChangeExecutor(fakePort()).execute(plan([
        { kind: "creators-set", operationId: "creators:1", before, after },
        { kind: "creators-set", operationId: "creators:2", before, after },
      ]));
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.code).to.equal("invalid-plan");
    expect(thrown?.message).to.include("只能包含一个 Creator");
  });

  it("附件与 Note 只创建；applied 日志失败时回收新建子项，回收失败标记严重错误", async function () {
    const port = fakePort();
    const result = await new api.ChangeExecutor(port, async (event) => {
      if (event.operation.operationId === "attachment:1:0" && event.status === "applied") {
        throw new Error("attachment journal unavailable");
      }
    }).execute(plan([
      {
        kind: "attachment-create",
        operationId: "attachment:1:0",
        attachment: { url: "https://example.test/a.pdf", title: "PDF", mimeType: "application/pdf" },
      },
      { kind: "note-create", operationId: "note:1:0", content: "新增 Note" },
    ]));
    expect(port.calls).to.deep.include(["trashCreatedItem", "ATT1"]);
    expect(result.items[0].operations.map((entry) => entry.status)).to.deep.equal(["failed", "applied"]);

    const severePort = fakePort({ trashError: new Error("trash failed") });
    const severe = await new api.ChangeExecutor(severePort, async (event) => {
      if (event.status === "applied") throw new Error("journal failed");
    }).execute(plan([{ kind: "note-create", operationId: "note:1:0", content: "新增 Note" }]));
    expect(severe.items[0].operations[0].message).to.include("[compensation-failed]");
    expect(severe.items[0].operations[0].message).to.include("NOTE1");
  });

  it("条目缺失时当前条目失败，但不阻断计划中的后续条目", async function () {
    const first = itemRef();
    const second = itemRef({ itemID: 2, itemKey: "BOOK2", title: "第二本" });
    const items = new Map([[second.itemKey, { fields: { title: "旧标题" } }]]);
    const port = fakePort();
    port.getItem = async (ref) => items.get(ref.itemKey) || null;
    const multiPlan = api.createChangePlan({
      planId: "plan-multi",
      createdAt: "2026-08-30T00:00:00.000Z",
      items: [first, second].map((item) => ({
        item,
        evidence: [{
          providerId: "fake",
          sourceURL: `https://example.test/book/${item.itemKey}`,
          identifiers: [{ type: "fake-id", value: item.itemKey }],
          fetchedAt: "2026-08-30T00:00:00.000Z",
        }],
        operations: [{ kind: "field-set", operationId: `field:title:${item.itemKey}`, field: "title", before: "旧标题", after: "新标题" }],
      })),
    });

    const result = await new api.ChangeExecutor(port).execute(multiPlan);
    expect(result.items.map((entry) => entry.status)).to.deep.equal(["failed", "applied"]);
  });

  it("有写入操作但来源证据为空时 fail-closed", async function () {
    const invalid = api.createChangePlan({
      planId: "plan-no-evidence",
      createdAt: "2026-08-30T00:00:00.000Z",
      items: [{
        item: itemRef(),
        evidence: [],
        operations: [{ kind: "field-set", operationId: "field:title", field: "title", before: "旧标题", after: "新标题" }],
      }],
    });
    let thrown;
    try {
      await new api.ChangeExecutor(fakePort()).execute(invalid);
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.code).to.equal("invalid-plan");
    expect(thrown?.message).to.include("来源证据");
  });
});
