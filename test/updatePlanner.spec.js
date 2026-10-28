const { assert, expect } = require("chai");

describe("update Planner（候选 → 审核数据 → ChangePlan）", function () {
  let api;

  before(function () {
    api = Zotero.zmtaAddon?.api;
    assert.isFunction(api?.snapshotProviderItem);
    assert.isFunction(api?.candidateToBatchPreview);
    assert.isFunction(api?.selectionsToChangePlan);
  });

  function item(creators = []) {
    const fields = { title: "本地书名", publisher: "本地出版社", language: "", url: "https://example.test/book/1" };
    return {
      id: 1,
      key: "BOOK1",
      libraryID: 1,
      itemType: "book",
      getField: (field) => fields[field] ?? "",
      getCreatorsJSON: () => creators,
    };
  }

  function candidate() {
    return {
      providerId: "fake",
      item: { itemID: 1, itemKey: "BOOK1", libraryID: 1, itemType: "book", title: "本地书名" },
      evidence: {
        providerId: "fake",
        sourceURL: "https://example.test/book/1",
        identifiers: [{ type: "fake", value: "1" }],
        fetchedAt: "2026-08-30T00:00:00.000Z",
      },
      itemType: "book",
      fields: [
        { field: "title", value: "本地书名" },
        { field: "publisher", value: "上游出版社" },
        { field: "language", value: "zh-CN" },
        { field: "extra", value: "不进入审核" },
      ],
      attachments: [{ operationId: "attachment:a:0", url: "https://example.test/a.pdf", title: "PDF", mimeType: "application/pdf" }],
      notes: [{ operationId: "note:n:0", content: "新增 Note" }],
    };
  }

  function validator(overrides = {}) {
    return (field) => overrides[field] || "valid";
  }

  it("快照只提供来源读取所需字段，不暴露写入方法", function () {
    const snapshot = api.snapshotProviderItem(item([
      { creatorType: "author", firstName: "本地", lastName: "作者" },
    ]));
    expect(snapshot).to.include({ itemID: 1, itemKey: "BOOK1", itemType: "book", title: "本地书名" });
    expect(snapshot.fields.url).to.equal("https://example.test/book/1");
    expect(snapshot.fields.creators).to.deep.equal([
      { creatorType: "author", firstName: "本地", lastName: "作者" },
    ]);
    expect(snapshot).not.to.have.property("setField");
    expect(snapshot).not.to.have.property("saveTx");
  });

  it("Planner 排除 extra、区分缺失/冲突并透传增量候选身份", function () {
    const preview = api.candidateToBatchPreview(item(), candidate());
    expect(preview.fields.map((entry) => entry.field)).to.deep.equal(["publisher", "language"]);
    expect(preview.fields[0]).to.include({ isConflict: true, defaultChecked: false });
    expect(preview.fields[1]).to.include({ isConflict: false, defaultChecked: true });
    expect(preview.attachments[0].batchOperationId).to.equal("attachment:a:0");
    expect(preview.notes[0].batchOperationId).to.equal("note:n:0");
    expect(preview.candidate.evidence.providerId).to.equal("fake");
  });

  it("Translator 候选类型不一致时整条阻断且不进入字段验证", function () {
    const incoming = candidate();
    incoming.itemType = "journalArticle";
    incoming.item.itemType = "journalArticle";
    let validated = false;
    const preview = api.candidateToBatchPreview(item(), incoming, () => {
      validated = true;
      return "valid";
    });

    expect(validated).to.equal(false);
    expect(preview.status).to.equal("blocked");
    expect(preview.fields).to.deep.equal([]);
    expect(preview.attachments).to.deep.equal([]);
    expect(preview.notes).to.deep.equal([]);
  });

  it("只把用户选择转为不可变 ChangePlan，并保留来源证据", function () {
    const preview = api.candidateToBatchPreview(item(), candidate(), validator());
    const selection = {
      itemID: preview.itemID,
      itemKey: preview.itemKey,
      fields: [preview.fields[1]],
      attachments: preview.attachments,
      notes: preview.notes,
      candidate: preview.candidate,
    };
    const plan = api.selectionsToChangePlan("batch-1", [selection], "2026-08-30T01:00:00.000Z");
    expect(plan.items[0].evidence[0].providerId).to.equal("fake");
    expect(plan.items[0].operations.map((entry) => entry.kind)).to.deep.equal([
      "field-set",
      "attachment-create",
      "note-create",
    ]);
    expect(plan.items[0].operations.map((entry) => entry.operationId)).to.deep.equal([
      "field:language",
      "attachment:a:0",
      "note:n:0",
    ]);
    assert.isTrue(Object.isFrozen(plan.items[0].operations));
  });

  it("Creator 列表按完整有序整体生成一个审核项和一个操作", function () {
    const localCreators = [
      { creatorType: "author", firstName: "旧", lastName: "作者" },
      { creatorType: "translator", name: "旧翻译组" },
    ];
    const incomingCreators = [
      { creatorType: "author", firstName: "新", lastName: "作者" },
      { creatorType: "author", name: "示例研究会" },
      { creatorType: "editor", firstName: "四", lastName: "李" },
      { creatorType: "translator", firstName: "新", lastName: "作者" },
    ];
    const incoming = candidate();
    incoming.fields = [];
    incoming.attachments = [];
    incoming.notes = [];
    incoming.creators = incomingCreators;

    const preview = api.candidateToBatchPreview(item(localCreators), incoming, validator());
    expect(preview.status).to.equal("ready");
    expect(preview.creators).to.deep.equal({
      local: localCreators,
      incoming: incomingCreators,
      isConflict: true,
      defaultChecked: false,
    });

    const plan = api.selectionsToChangePlan("batch-creators", [{
      itemID: preview.itemID,
      itemKey: preview.itemKey,
      fields: [],
      creators: preview.creators,
      attachments: [],
      notes: [],
      candidate: preview.candidate,
    }]);
    expect(plan.items[0].operations).to.deep.equal([{
      kind: "creators-set",
      operationId: "creators:set",
      before: localCreators,
      after: incomingCreators,
    }]);
    assert.isTrue(Object.isFrozen(plan.items[0].operations[0].after));
  });

  it("Creator 顺序变化算一个差异；相同列表、空候选均不生成差异或清空操作", function () {
    const localCreators = [
      { creatorType: "author", firstName: "一", lastName: "甲" },
      { creatorType: "author", firstName: "二", lastName: "乙" },
    ];
    const reordered = candidate();
    reordered.fields = [];
    reordered.attachments = [];
    reordered.notes = [];
    reordered.creators = [...localCreators].reverse();
    expect(api.candidateToBatchPreview(item(localCreators), reordered, validator()).creators.incoming)
      .to.deep.equal([...localCreators].reverse());

    const same = candidate();
    same.fields = [];
    same.attachments = [];
    same.notes = [];
    same.creators = localCreators;
    const samePreview = api.candidateToBatchPreview(item(localCreators), same, validator());
    expect(samePreview.status).to.equal("skipped");
    expect(samePreview).not.to.have.property("creators");

    const empty = candidate();
    empty.fields = [];
    empty.attachments = [];
    empty.notes = [];
    empty.creators = [];
    const emptyPreview = api.candidateToBatchPreview(item(localCreators), empty, validator());
    expect(emptyPreview.status).to.equal("skipped");
    expect(emptyPreview).not.to.have.property("creators");
  });

  it("本地 Creator 为空时默认选中；畸形结构或非法角色阻断整条候选", function () {
    const incoming = candidate();
    incoming.fields = [];
    incoming.attachments = [];
    incoming.notes = [];
    incoming.creators = [{ creatorType: "author", name: "机构作者" }];
    const preview = api.candidateToBatchPreview(item([]), incoming, validator());
    expect(preview.creators).to.include({ isConflict: false, defaultChecked: true });

    for (const creators of [
      [{ creatorType: "author" }],
      [{ creatorType: "not-a-zotero-role", name: "机构" }],
      [{ creatorType: "author", name: "机构", lastName: "混合模式" }],
    ]) {
      const invalid = candidate();
      invalid.creators = creators;
      const blocked = api.candidateToBatchPreview(item([]), invalid, validator());
      expect(blocked.status).to.equal("blocked");
      expect(blocked.message).to.include("Creator");
      expect(blocked.fields).to.deep.equal([]);
    }
  });

  it("需身份确认的候选未确认时拒绝计划，确认后把依据写入证据", function () {
    const incoming = candidate();
    incoming.identityReview = {
      required: true,
      matchedFields: ["title", "publisher"],
      summary: "组合证据",
    };
    const preview = api.candidateToBatchPreview(item(), incoming, validator());
    const selection = {
      itemID: preview.itemID,
      itemKey: preview.itemKey,
      fields: preview.fields,
      attachments: [],
      notes: [],
      candidate: preview.candidate,
    };
    expect(() => api.selectionsToChangePlan("unconfirmed", [selection])).to.throw("身份尚未由用户确认");
    selection.identityConfirmed = true;
    const plan = api.selectionsToChangePlan("confirmed", [selection]);
    expect(plan.items[0].evidence[0].identityConfirmation).to.deep.equal({
      method: "user-confirmed",
      matchedFields: ["title", "publisher"],
    });
  });

  it("排除未知字段且不生成字段写入操作", function () {
    const incoming = candidate();
    incoming.fields = [{ field: "futureField", value: "上游值" }];
    incoming.attachments = [];
    incoming.notes = [];
    const preview = api.candidateToBatchPreview(item(), incoming, validator({
      futureField: "unknown-field",
    }));

    expect(preview.status).to.equal("skipped");
    expect(preview.fields).to.deep.equal([]);
    expect(preview.excludedFields).to.deep.equal([{
      field: "futureField",
      reason: "unknown-field",
      message: "未知字段“futureField”，已排除",
    }]);
    const plan = api.selectionsToChangePlan("batch-unknown", [{
      itemID: preview.itemID,
      itemKey: preview.itemKey,
      fields: preview.fields,
      attachments: preview.attachments,
      notes: preview.notes,
      candidate: preview.candidate,
    }]);
    expect(plan.items[0].operations).to.deep.equal([]);
  });

  it("排除当前类型不支持的字段，其他候选仍可审核和生成操作", function () {
    const incoming = candidate();
    incoming.fields.push({ field: "proceedingsTitle", value: "会议录" });
    const preview = api.candidateToBatchPreview(item(), incoming, validator({
      proceedingsTitle: "invalid-for-item-type",
    }));

    expect(preview.status).to.equal("ready");
    expect(preview.fields.map((entry) => entry.field)).to.deep.equal(["publisher", "language"]);
    expect(preview.excludedFields[0]).to.include({
      field: "proceedingsTitle",
      reason: "invalid-for-item-type",
    });
    expect(preview.attachments).to.have.length(1);
    expect(preview.notes).to.have.length(1);
    const plan = api.selectionsToChangePlan("batch-invalid-for-type", [{
      itemID: preview.itemID,
      itemKey: preview.itemKey,
      fields: preview.fields,
      attachments: preview.attachments,
      notes: preview.notes,
      candidate: preview.candidate,
    }]);
    expect(plan.items[0].operations.map((entry) => entry.operationId)).not.to.include("field:proceedingsTitle");
  });

  it("validator 异常时 fail closed，附件和 Note 不受影响", function () {
    const incoming = candidate();
    incoming.fields = [
      { field: "publisher", value: "上游出版社" },
      { field: "language", value: "zh-CN" },
    ];
    const preview = api.candidateToBatchPreview(item(), incoming, (field) => {
      if (field === "publisher") throw new Error("validator unavailable");
      return "valid";
    });

    expect(preview.fields.map((entry) => entry.field)).to.deep.equal(["language"]);
    expect(preview.excludedFields[0]).to.include({
      field: "publisher",
      reason: "validation-error",
    });
    expect(preview.attachments).to.have.length(1);
    expect(preview.notes).to.have.length(1);
    const plan = api.selectionsToChangePlan("batch-validator-error", [{
      itemID: preview.itemID,
      itemKey: preview.itemKey,
      fields: preview.fields,
      attachments: [],
      notes: [],
      candidate: preview.candidate,
    }]);
    expect(plan.items[0].operations.map((entry) => entry.operationId)).to.deep.equal(["field:language"]);
  });

  it("extra 保持既定排除策略，不形成非法字段警告", function () {
    const incoming = candidate();
    incoming.fields = [{ field: "extra", value: "不进入审核" }];
    incoming.attachments = [];
    incoming.notes = [];
    let validated = false;
    const preview = api.candidateToBatchPreview(item(), incoming, () => {
      validated = true;
      return "unknown-field";
    });

    expect(validated).to.equal(false);
    expect(preview.fields).to.deep.equal([]);
    expect(preview).not.to.have.property("excludedFields");
  });

  it("有写入操作但没有来源证据时拒绝生成计划", function () {
    expect(() => api.selectionsToChangePlan("batch-no-evidence", [{
      itemID: 1,
      itemKey: "BOOK1",
      fields: [{ field: "language", local: "", incoming: "zh-CN", isConflict: false, defaultChecked: true }],
      attachments: [],
      notes: [],
    }])).to.throw("缺少来源证据");
  });
});
