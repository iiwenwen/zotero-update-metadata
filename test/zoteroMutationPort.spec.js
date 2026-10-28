const { assert, expect } = require("chai");

describe("DefaultZoteroMutationPort（fake host）", function () {
  let api;

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  before(function () {
    api = Zotero.zmtaAddon?.testApi;
    assert.isFunction(api?.DefaultZoteroMutationPort, "测试构建应暴露 DefaultZoteroMutationPort");
  });

  function ref(overrides = {}) {
    return {
      itemID: 7,
      itemKey: "BOOK7",
      libraryID: 2,
      itemType: "book",
      title: "书",
      ...overrides,
    };
  }

  function fakeHost(overrides = {}) {
    const calls = [];
    const item = {
      id: 7,
      key: "BOOK7",
      libraryID: 2,
      itemType: "book",
      fields: { title: "旧标题" },
      creators: [{ creatorType: "author", firstName: "旧", lastName: "作者" }],
      getField(field) { return this.fields[field] ?? ""; },
      setField(field, value) { this.fields[field] = value; },
      getCreatorsJSON() { calls.push(["getCreatorsJSON"]); return clone(this.creators); },
      setCreators(creators, options) {
        calls.push(["setCreators", clone(creators), options]);
        this.creators = clone(creators);
      },
      async saveTx() { calls.push(["saveTx"]); },
    };
    return {
      calls,
      item,
      async getItem(itemID) { calls.push(["getItem", itemID]); return overrides.item ?? item; },
      async importAttachment(options) { calls.push(["importAttachment", options]); return { id: 9, key: "ATT9" }; },
      createItem(kind) {
        calls.push(["createItem", kind]);
        return {
          id: 10,
          key: "NOTE10",
          content: "",
          isNote() { return true; },
          isAttachment() { return false; },
          toJSON() { return { itemType: "note", note: this.content }; },
          setNote(content) { this.content = content; calls.push(["setNote", content]); },
          async saveTx() { calls.push(["note.saveTx"]); },
        };
      },
      async trashItem(itemID) { calls.push(["trashItem", itemID]); },
      userLibraryID: 1,
    };
  }

  it("校验 itemID、itemKey 与 libraryID，身份不一致时拒绝返回条目", async function () {
    const host = fakeHost();
    const port = new api.DefaultZoteroMutationPort(host);
    expect(await port.getItem(ref())).to.equal(host.item);

    const mismatch = fakeHost({ item: { ...host.item, key: "OTHER" } });
    let thrown;
    try {
      await new api.DefaultZoteroMutationPort(mismatch).getItem(ref());
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.code).to.equal("item-mismatch");
  });

  it("字段读写与保存只映射到条目公开 API", async function () {
    const host = fakeHost();
    const port = new api.DefaultZoteroMutationPort(host);
    port.setField(host.item, "title", "新标题");
    expect(port.getField(host.item, "title")).to.equal("新标题");
    await port.saveItem(host.item);
    expect(host.calls).to.deep.include(["saveTx"]);
  });

  it("Creator 读写映射到 Zotero JSON API，并固定启用 strict", function () {
    const host = fakeHost();
    const port = new api.DefaultZoteroMutationPort(host);
    const incoming = [
      { creatorType: "author", firstName: "第一", lastName: "作者" },
      { creatorType: "translator", name: "翻译机构" },
    ];

    expect(port.getCreators(host.item)).to.deep.equal(host.item.creators);
    port.setCreators(host.item, incoming);

    expect(host.item.creators).to.deep.equal(incoming);
    expect(host.calls).to.deep.include(["getCreatorsJSON"]);
    expect(host.calls).to.deep.include(["setCreators", incoming, { strict: true }]);
  });

  it("附件和 Note 只新增，并可按新建项 id 移入回收站", async function () {
    const host = fakeHost();
    const port = new api.DefaultZoteroMutationPort(host);
    const attachment = await port.createAttachment(host.item, {
      url: "https://example.test/a.pdf",
      title: "PDF",
      mimeType: "application/pdf",
    });
    const note = await port.createNote(host.item, "新增 Note");
    await port.trashCreatedItem(note, port.getCreatedItemFingerprint(note));

    expect(host.calls.find((call) => call[0] === "importAttachment")[1]).to.deep.equal({
      url: "https://example.test/a.pdf",
      contentType: "application/pdf",
      title: "PDF",
      parentItemID: 7,
      libraryID: 2,
    });
    expect(host.calls).to.deep.include(["createItem", "note"]);
    expect(host.calls).to.deep.include(["setNote", "新增 Note"]);
    expect(host.calls).to.deep.include(["trashItem", 10]);
    expect(port.getCreatedItemKey(attachment)).to.equal("ATT9");
  });

  it("附件缺少必要字段或新建项无 id 时 fail-closed", async function () {
    const host = fakeHost();
    const port = new api.DefaultZoteroMutationPort(host);
    let attachmentError;
    try {
      await port.createAttachment(host.item, { title: "缺 URL" });
    } catch (error) {
      attachmentError = error;
    }
    expect(attachmentError?.code).to.equal("write-failed");

    let trashError;
    try {
      await port.trashCreatedItem({ key: "NOID" });
    } catch (error) {
      trashError = error;
    }
    expect(trashError?.code).to.equal("compensation-failed");
    assert.notInclude(host.calls.map((call) => call[0]), "trashItem");
  });
});
