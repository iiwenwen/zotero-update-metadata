const { expect } = require("chai");
const { loadDialogCopy, renderCopy } = require("./helpers/copy.cjs");

describe("safeDefaults（审核初选与窗口快照）", function () {
  let api;
  let copy;
  const dialogLayout = (previews, options) => renderCopy(api.buildBatchDialogLayout(previews, copy, options), copy);
  before(function () {
    api = Zotero.zmtaAddon?.uiTestApi;
    if (!api) this.skip();
    ({ copy } = loadDialogCopy());
  });

  function preview() {
    return [{
      itemID: 1, itemKey: "SAFE1", libraryID: 1, title: "测试", status: "ready",
      fields: [
        { field: "publisher", local: "", incoming: "补缺", defaultChecked: true },
        { field: "title", local: "人工标题", incoming: "替换", defaultChecked: true },
      ],
      creators: { local: [{ name: "人工作者", creatorType: "author" }], incoming: [{ name: "上游作者", creatorType: "author" }], defaultChecked: false },
      attachments: [{ title: "a.pdf" }, { title: "b.pdf" }],
      notes: [{ content: "n1", defaultChecked: true }, { content: "n2", defaultChecked: false }],
      candidate: { digest: "不修改候选" }, candidateDigest: "不重算",
    }];
  }

  function nodes(layout) {
    const records = new Map();
    const walk = (node) => {
      if (node.id) records.set(node.id, { ...node.properties, setAttribute() {} });
      (node.children || []).forEach(walk);
    };
    walk(layout);
    records.set("zmta-batch-confirm", { disabled: false });
    return records;
  }

  function find(layout, id) {
    if (layout.id === id) return layout;
    for (const child of layout.children || []) {
      const found = find(child, id);
      if (found) return found;
    }
  }

  for (const attachments of [false, true]) for (const notes of [false, true]) {
    it(`附件=${attachments}／笔记=${notes}：完整候选、初选、计数和收集一致`, function () {
      const data = preview();
      const before = JSON.stringify(data);
      const layout = dialogLayout(data, { selectionDefaults: { attachments, notes } });
      const records = nodes(layout);
      const doc = { getElementById: (id) => records.get(id) };
      expect(records.get("zmta-batch-field-0-0").checked).to.equal(true);
      expect(records.get("zmta-batch-field-0-1").checked).to.equal(false);
      expect(records.get("zmta-batch-creators-0").checked).to.equal(false);
      for (let i = 0; i < 2; i += 1) {
        expect(records.get(`zmta-batch-attachment-0-${i}`).checked).to.equal(attachments);
        expect(records.get(`zmta-batch-note-0-${i}`).checked).to.equal(notes);
      }
      expect(records.get("zmta-batch-attachment-count-0").textContent).to.equal(`已选 ${attachments ? 2 : 0} / 2 项`);
      expect(records.get("zmta-batch-note-count-0").textContent).to.equal(`已选 ${notes ? 2 : 0} / 2 项`);
      const total = 1 + (attachments ? 2 : 0) + (notes ? 2 : 0);
      expect(records.get("zmta-batch-selection-summary").textContent).to.equal(`已选择 1 个条目 · ${total} 项更新`);
      expect(records.has("zmta-batch-item-meta-0")).to.equal(false); // 单条不挂导航
      const selected = api.collectBatchSelections(data, doc)[0];
      expect(selected.attachments).to.have.length(attachments ? 2 : 0);
      expect(selected.notes).to.have.length(notes ? 2 : 0);
      expect(selected.candidate).to.equal(data[0].candidate);
      expect(JSON.stringify(data)).to.equal(before);

      for (const node of records.values()) if ("checked" in node) node.checked = false;
      const change = find(layout, "zmta-batch-field-0-0").listeners[0].listener;
      change({ currentTarget: { ownerDocument: doc } });
      expect(records.get("zmta-batch-confirm").disabled).to.equal(true);
      expect(records.get("zmta-batch-selection-summary").textContent).to.equal("已选择 0 个条目 · 0 项更新");
      records.get("zmta-batch-attachment-0-1").checked = true;
      records.get("zmta-batch-note-0-0").checked = true;
      change({ currentTarget: { ownerDocument: doc } });
      expect(records.get("zmta-batch-attachment-count-0").textContent).to.equal("已选 1 / 2 项");
      expect(records.get("zmta-batch-note-count-0").textContent).to.equal("已选 1 / 2 项");
      expect(records.get("zmta-batch-selection-summary").textContent).to.equal("已选择 1 个条目 · 2 项更新");
      expect(api.collectBatchSelections(data, doc)[0].attachments[0]).to.equal(data[0].attachments[1]);
    });
  }

  it("未设置、非法类型和读取失败均不预选；只接受布尔 true", function () {
    const original = Zotero.Prefs.get;
    try {
      for (const value of [undefined, null, false, "false", "true", 1, 0, {}, []]) {
        Zotero.Prefs.get = () => value;
        expect(api.getReviewSelectionDefaults()).to.deep.equal({ attachments: false, notes: false });
      }
      Zotero.Prefs.get = (key) => {
        if (key.endsWith("defaultSelectAttachments")) throw new Error("读取失败");
        return true;
      };
      expect(api.getReviewSelectionDefaults()).to.deep.equal({ attachments: false, notes: true });
      Zotero.Prefs.get = () => true;
      const snapshot = api.getReviewSelectionDefaults();
      expect(snapshot).to.deep.equal({ attachments: true, notes: true });
      expect(Object.isFrozen(snapshot)).to.equal(true);
    } finally { Zotero.Prefs.get = original; }
  });

  it("每窗口只读一次私有快照，开窗及手选后变更偏好只影响下个窗口", async function () {
    const original = Zotero.Prefs.get;
    const reads = [];
    let value = false;
    const opened = [];
    class Dialog {
      constructor() { value = !value; }
      addButton(label, id, options) { (this.buttons ||= {})[id] = { label, ...options }; }
      addCell(_row, _column, layout) {
        this.layout = layout;
        this.records = nodes(layout);
        this.window = { document: { getElementById: (id) => this.records.get(id) } };
      }
      setDialogData(data) { this.dialogData = data; }
      open() { opened.push(this); }
    }
    Zotero.Prefs.get = (key) => { reads.push(key); return value; };
    const pending = [];
    try {
      pending.push(api.showBatchConfirmDialog(preview(), { Dialog }, copy));
      const first = opened[0];
      expect(first.records.get("zmta-batch-attachment-0-0").checked).to.equal(false);
      first.records.get("zmta-batch-note-0-0").checked = true;
      pending.push(api.showBatchConfirmDialog(preview(), { Dialog }, copy));
      expect(opened[1].records.get("zmta-batch-attachment-0-0").checked).to.equal(true);
      expect(first.records.get("zmta-batch-attachment-0-0").checked).to.equal(false);
      expect(first.records.get("zmta-batch-note-0-0").checked).to.equal(true);
      for (const key of ["defaultSelectAttachments", "defaultSelectNotes"]) {
        expect(reads.filter((read) => read.endsWith(key))).to.have.length(2);
      }
    } finally {
      opened.forEach((dialog) => dialog.dialogData.beforeUnloadCallback());
      expect(await Promise.all(pending)).to.deep.equal([null, null]);
      Zotero.Prefs.get = original;
    }
  });

  it("窗口构造异常与确认缺文档均取消，不将默认选项作为授权", async function () {
    class ThrowingDialog { constructor() { throw new Error("不能开窗"); } }
    expect(await api.showBatchConfirmDialog(preview(), { Dialog: ThrowingDialog }, copy)).to.equal(null);
    class MissingDocumentDialog {
      addButton(label, id, options) { (this.buttons ||= {})[id] = { label, ...options }; }
      addCell(_r, _c, layout) { this.layout = layout; }
      setDialogData(data) { this.dialogData = data; }
      open() {
        this.buttons["zmta-batch-confirm"].callback();
        this.dialogData.beforeUnloadCallback();
      }
    }
    expect(await api.showBatchConfirmDialog(preview(), { Dialog: MissingDocumentDialog }, copy)).to.equal(null);
  });
});
