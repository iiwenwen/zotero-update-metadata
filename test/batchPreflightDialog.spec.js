// 纯布局、状态归约与 fake Dialog/DOM 测试；由主 Agent 在 addon.api 接入后运行。
const { expect } = require("chai");
const { loadDialogCopy, renderCopy } = require("./helpers/copy.cjs");

describe("batchPreflightDialog", function () {
  let api;

  let copy;
  const preflightLayout = (total) => renderCopy(api.buildBatchPreflightDialogLayout(total, copy), copy);

  before(function () {
    api = Zotero.zmtaAddon.api;
    ({ copy } = loadDialogCopy());
  });

  it("布局使用原生进度并继承系统主题", function () {
    const built = preflightLayout(50);
    expect(built.id).to.equal("zmta-batch-preflight");
    expect(built.styles).to.include({ minHeight: "0", flex: "1", overflow: "auto" });
    expect(built.children[0].children[0].properties.textContent).to.equal("已完成 0 / 50");
    expect(built.children[0].children[3].properties.textContent).to.equal("—");
    expect(built.children[0].children[5].properties.textContent).to.equal("正在准备");
    expect(built.children[1].properties.textContent).to.include("color-scheme: light dark");
  });

  it("纯状态归约只显示用户可理解的阶段，取消后保持正在停止", function () {
    const initial = { completed: 0, total: 1, title: "—", stageId: "dlg-preflight-preparing", stopping: false };
    const running = api.reduceBatchPreflightViewState(initial, {
      stage: "route-start", completed: 0, total: 1, title: "测试条目", routeId: "doi.search",
    });
    expect(running).to.deep.equal({
      completed: 0, total: 1, title: "测试条目", stageId: "dlg-preflight-stage-route", stopping: false,
    });
    expect(copy.text(running.stageId)).to.equal("正在查找最新信息");
    const stopping = api.reduceBatchPreflightViewState({ ...running, stopping: true }, {
      stage: "item-complete", completed: 1, total: 1, title: "测试条目", status: "ready",
    });
    expect(stopping.completed).to.equal(1);
    expect(copy.text(stopping.stageId)).to.equal("正在停止");
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
    const handle = api.openBatchPreflightDialog({ Dialog: FakeDialog }, 2, copy);
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

    const cancelled = api.openBatchPreflightDialog({ Dialog: FakeDialog }, 1, copy);
    expect(instance.buttons["zmta-preflight-cancel"].noClose).to.equal(true);
    instance.buttons["zmta-preflight-cancel"].callback();
    expect(cancelled.signal.aborted).to.equal(true);
    expect(closeCalls).to.equal(0);

    const closedByUser = api.openBatchPreflightDialog({ Dialog: FakeDialog }, 1, copy);
    instance.dialogData.beforeUnloadCallback();
    instance.dialogData.beforeUnloadCallback();
    expect(closedByUser.signal.aborted).to.equal(true);

    const completed = api.openBatchPreflightDialog({ Dialog: FakeDialog }, 0, copy);
    completed.close();
    completed.close();
    expect(completed.signal.aborted).to.equal(false);
    expect(closeCalls).to.equal(1);
  });
});
