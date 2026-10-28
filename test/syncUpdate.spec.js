// 当前批量 Planner 共用的字段差异纯逻辑；不联网、不写 Zotero。
const { assert, expect } = require("chai");

describe("metadata field diff（批量 Planner 共用）", function () {
  let addon;
  before(function () {
    addon = Zotero.zmtaAddon;
    assert.isNotEmpty(addon, "addon 应存在");
    assert.isObject(addon.api, "addon.api 应存在");
  });

  describe("diffFields（纯逻辑）", function () {
    it("相同值不产生差异", function () {
      const item = {
        getField: (f) => (f === "title" ? "中国式家庭" : null),
      };
      const incoming = { title: "中国式家庭" };
      const diffs = addon.api.diffFields(item, incoming);
      expect(diffs.length).to.equal(0);
    });

    it("不同值产生差异", function () {
      const item = {
        getField: (f) => (f === "title" ? "旧标题" : null),
      };
      const incoming = { title: "新标题" };
      const diffs = addon.api.diffFields(item, incoming);
      expect(diffs.length).to.equal(1);
      expect(diffs[0].field).to.equal("title");
      expect(diffs[0].local).to.equal("旧标题");
      expect(diffs[0].incoming).to.equal("新标题");
    });

    it("translator 空值不产生差异", function () {
      const item = {
        getField: (f) => (f === "title" ? "标题" : null),
      };
      const incoming = { title: null, publisher: "某出版社" };
      const diffs = addon.api.diffFields(item, incoming);
      expect(diffs.length).to.equal(1);
      expect(diffs[0].field).to.equal("publisher");
    });
  });
});
