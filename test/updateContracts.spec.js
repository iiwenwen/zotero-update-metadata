const { assert, expect } = require("chai");

describe("update contracts（来源与写入共享合同）", function () {
  let api;

  before(function () {
    api = Zotero.zmtaAddon?.api;
    assert.isObject(api, "addon.api 应存在");
  });

  it("只接受当前四类标准写入操作", function () {
    expect(api.UPDATE_OPERATION_KINDS).to.deep.equal([
      "field-set",
      "creators-set",
      "attachment-create",
      "note-create",
    ]);
    assert.isTrue(api.isChangeOperation({
      kind: "field-set",
      operationId: "field:publisher",
      field: "publisher",
      before: "旧值",
      after: "新值",
    }));
    assert.isTrue(api.isChangeOperation({
      kind: "creators-set",
      operationId: "creators",
      before: [{ firstName: "旧", lastName: "作者", creatorType: "author" }],
      after: [{ name: "新机构", creatorType: "author" }],
    }));
    assert.isTrue(api.isChangeOperation({
      kind: "attachment-create",
      operationId: "attachment:abc:0",
      attachment: { url: "https://example.test/a.pdf", title: "PDF", mimeType: "application/pdf" },
    }));
    assert.isTrue(api.isChangeOperation({
      kind: "note-create",
      operationId: "note:abc:0",
      content: "note",
    }));
    assert.isFalse(api.isChangeOperation({ kind: "field", identity: "publisher" }));
    assert.isFalse(api.isChangeOperation({ kind: "delete", operationId: "danger" }));
  });

  it("创建不可变 ChangePlan，调用方后续修改不会污染执行计划", function () {
    const input = {
      planId: "plan-1",
      createdAt: "2026-08-30T00:00:00.000Z",
      items: [{
        item: { itemID: 1, itemKey: "BOOK1", libraryID: 1, itemType: "book", title: "书" },
        evidence: [{
          providerId: "douban",
          sourceURL: "https://book.douban.com/subject/1/",
          identifiers: [{ type: "douban-subject", value: "1" }],
          fetchedAt: "2026-08-30T00:00:00.000Z",
        }],
        operations: [{
          kind: "field-set",
          operationId: "field:publisher",
          field: "publisher",
          before: "旧值",
          after: "新值",
        }],
      }],
    };
    const plan = api.createChangePlan(input);
    input.items[0].operations[0].after = "被调用方篡改";

    expect(plan.items[0].operations[0].after).to.equal("新值");
    assert.isTrue(Object.isFrozen(plan));
    assert.isTrue(Object.isFrozen(plan.items));
    assert.isTrue(Object.isFrozen(plan.items[0].operations[0]));
  });

  it("标准操作到旧 journal kind 的映射必须显式且完整", function () {
    expect(api.toJournalOperationKind("field-set")).to.equal("field");
    expect(api.toJournalOperationKind("creators-set")).to.equal("creators");
    expect(api.toJournalOperationKind("attachment-create")).to.equal("attachment");
    expect(api.toJournalOperationKind("note-create")).to.equal("note");
  });
});
