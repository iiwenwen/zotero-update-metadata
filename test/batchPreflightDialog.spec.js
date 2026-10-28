// 纯布局、状态归约与 fake Dialog/DOM 测试；由主 Agent 在 addon.api 接入后运行。
const { expect } = require("chai");

describe("batchPreflightDialog", function () {
  let api;

  before(function () {
    api = Zotero.zmtaAddon.api;
  });

  it("布局显示确定的初始进度并包含深浅主题", function () {
    const layout = api.buildBatchPreflightDialogLayout(50);
    expect(layout.id).to.equal("zmta-batch-preflight");
    expect(layout.children[0].children[0].properties.textContent).to.equal("已完成 0 / 50");
    expect(layout.children[0].children[2].properties.textContent).to.equal("—");
    expect(layout.children[0].children[4].properties.textContent).to.equal("正在准备");
    expect(layout.children[1].properties.textContent).to.include("prefers-color-scheme: light");
  });

  it("纯状态归约只显示用户可理解的阶段，取消后保持正在停止", function () {
    const initial = { completed: 0, total: 1, title: "—", stage: "正在准备", stopping: false };
    const running = api.reduceBatchPreflightViewState(initial, {
      stage: "route-start", completed: 0, total: 1, title: "测试条目", routeId: "doi.search",
    });
    expect(running).to.deep.equal({
      completed: 0, total: 1, title: "测试条目", stage: "正在查询上游", stopping: false,
    });
    const stopping = api.reduceBatchPreflightViewState({ ...running, stopping: true }, {
      stage: "item-complete", completed: 1, total: 1, title: "测试条目", status: "ready",
    });
    expect(stopping.completed).to.equal(1);
    expect(stopping.stage).to.equal("正在停止");
  });

  it("handle 更新 fake DOM，取消发 signal 且重复取消幂等", function () {
    const elements = new Map();
    const element = (id) => {
      if (!elements.has(id)) elements.set(id, { textContent: "", disabled: false });
      return elements.get(id);
    };
    let abortEvents = 0;
    class FakeDialog {
      constructor() {
        this.buttons = {};
        this.window = { document: { getElementById: element }, close: () => this.dialogData.beforeUnloadCallback() };
      }
      addCell(_row, _column, layout, flex) { this.layout = layout; this.flex = flex; return this; }
      addButton(_label, id, options) { this.buttons[id] = options; return this; }
      setDialogData(data) { this.dialogData = data; return this; }
      open() {}
    }
    const handle = api.openBatchPreflightDialog({ Dialog: FakeDialog }, 2);
    handle.signal.addEventListener("abort", () => { abortEvents += 1; });
    handle.update({ stage: "item-start", completed: 0, total: 2, title: "第一条" });
    expect(element("zmta-preflight-progress").textContent).to.equal("已完成 0 / 2");
    expect(element("zmta-preflight-title").textContent).to.equal("第一条");
    handle.requestCancel();
    handle.requestCancel();
    expect(handle.signal.aborted).to.equal(true);
    expect(abortEvents).to.equal(1);
    expect(element("zmta-preflight-stage").textContent).to.equal("正在停止");
    expect(element("zmta-preflight-cancel").disabled).to.equal(true);
  });

  it("取消按钮不立即关窗，窗口关闭等同取消，close 均幂等", function () {
    let instance;
    let closeCalls = 0;
    class FakeDialog {
      constructor() {
        instance = this;
        this.buttons = {};
        this.window = {
          document: { getElementById: () => ({}) },
          close: () => { closeCalls += 1; this.dialogData.beforeUnloadCallback(); },
        };
      }
      addCell() { return this; }
      addButton(_label, id, options) { this.buttons[id] = options; return this; }
      setDialogData(data) { this.dialogData = data; return this; }
      open() {}
    }

    const cancelled = api.openBatchPreflightDialog({ Dialog: FakeDialog }, 1);
    expect(instance.buttons["zmta-preflight-cancel"].noClose).to.equal(true);
    instance.buttons["zmta-preflight-cancel"].callback();
    expect(cancelled.signal.aborted).to.equal(true);
    expect(closeCalls).to.equal(0);

    const closedByUser = api.openBatchPreflightDialog({ Dialog: FakeDialog }, 1);
    instance.dialogData.beforeUnloadCallback();
    instance.dialogData.beforeUnloadCallback();
    expect(closedByUser.signal.aborted).to.equal(true);

    const completed = api.openBatchPreflightDialog({ Dialog: FakeDialog }, 0);
    completed.close();
    completed.close();
    expect(completed.signal.aborted).to.equal(false);
    expect(closeCalls).to.equal(1);
  });
});
