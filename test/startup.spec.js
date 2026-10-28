// scaffold test：插件加载测试（照 template test/startup.test.ts）
const { assert } = require("chai");

describe("startup", function () {
  it("should have plugin instance defined", function () {
    assert.isNotEmpty(Zotero.zmtaAddon, "Zotero.zmtaAddon 应已定义");
  });

  it("should be initialized", function () {
    assert.isTrue(Zotero.zmtaAddon.data.initialized, "插件应初始化完成");
  });
});
