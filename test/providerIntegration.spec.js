const { assert, expect } = require("chai");

describe("Provider → Planner → Executor 集成（fake 来源）", function () {
  let api;

  before(function () {
    api = { ...Zotero.zmtaAddon?.api, ...Zotero.zmtaAddon?.testApi };
    assert.isFunction(api?.preflightBatch);
    assert.isFunction(api?.applyBatch);
  });

  it("新增来源只产出 CandidateEnvelope，不需要修改写入层", async function () {
    const fields = { title: "旧标题", url: "https://example.test/books/1", language: "" };
    const item = {
      id: 1,
      key: "BOOK1",
      libraryID: 1,
      itemType: "book",
      isNote: () => false,
      isAttachment: () => false,
      getField: (field) => fields[field] ?? "",
      setField: (field, value) => { fields[field] = value; },
      saveTx: async () => {},
    };
    const provider = {
      id: "fixture",
      capabilities: {
        itemTypes: ["book"],
        identifierTypes: ["fixture-id"],
        fields: true,
        attachments: "create-only",
        notes: "create-only",
      },
      applies: () => true,
      resolveIdentifiers: () => [{ type: "fixture-id", value: "1" }],
      fetch: async () => ({ language: "zh-CN" }),
      transform: (source, request) => ({
        providerId: "fixture",
        item: {
          itemID: request.item.itemID,
          itemKey: request.item.itemKey,
          libraryID: request.item.libraryID,
          itemType: request.item.itemType,
          title: request.item.title,
        },
        evidence: {
          providerId: "fixture",
          sourceURL: "https://example.test/books/1",
          identifiers: request.identifiers,
          fetchedAt: "2026-08-30T00:00:00.000Z",
        },
        itemType: "book",
        fields: [{ field: "language", value: source.language }],
        attachments: [],
        notes: [],
      }),
      verify: () => {},
      classifyError: (error) => error,
    };

    const preview = (await api.preflightBatch([item], { provider }))[0];
    expect(preview.status).to.equal("ready");
    expect(preview.candidate.providerId).to.equal("fixture");
    expect(preview.fields[0]).to.include({ field: "language", incoming: "zh-CN" });

    const result = await api.applyBatch([{
      itemID: item.id,
      itemKey: item.key,
      fields: preview.fields,
      attachments: [],
      notes: [],
      candidate: preview.candidate,
    }], { getItem: () => item });
    expect(result.items[0].status).to.equal("applied");
    expect(fields.language).to.equal("zh-CN");
  });
});
