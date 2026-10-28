const { assert, expect } = require("chai");

describe("P0 产品可靠性共享合同", function () {
  let api;

  before(function () {
    api = Zotero.zmtaAddon?.api;
    assert.isObject(api, "addon.api 应存在");
  });

  it("冻结预检进度阶段，UI 与核心不得发明第二套状态", function () {
    expect(api.PREFLIGHT_PROGRESS_STAGES).to.deep.equal([
      "batch-start",
      "item-start",
      "route-start",
      "item-complete",
      "stopping",
      "batch-complete",
      "cancelled",
    ]);
    assert.isTrue(Object.isFrozen(api.PREFLIGHT_PROGRESS_STAGES));
  });

  it("协作取消使用可识别终态并保留已完成数量", function () {
    const error = new api.BatchPreflightCancelledError(2, 5);
    // addon 与测试运行器处于不同 JS compartment，不能用 instanceof Error 判定。
    expect(error.name).to.equal("BatchPreflightCancelledError");
    expect(error).to.include({ name: "BatchPreflightCancelledError", completed: 2, total: 5 });
    expect(error.message).to.include("2/5");
  });
});
