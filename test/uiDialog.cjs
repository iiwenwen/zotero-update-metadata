// 离线DOM/事件夹具；不模拟显示、焦点或原生键盘实现。
const all = node => [node, ...(node?.children || []).flatMap(all)];
class Dialog {
  static instances = [];
  constructor() {
    Dialog.instances.push(this);
    this.buttons = {};
    this.closed = false;
    this.closeCalls = 0;
    this.nodes = new Map();
    this.mediaListeners = new Set();
    const doc = this.document = {
      getElementById: id => this.nodes.get(id),
      documentElement: { classList: { add() {} } },
      createElementNS: (_ns, tag) => this.element(tag),
    };
    this.media = { matches: false, addEventListener: (_type, fn) => this.mediaListeners.add(fn), removeEventListener: (_type, fn) => this.mediaListeners.delete(fn) };
    this.events = new Map();
    this.window = { document: doc, matchMedia: () => this.media, closed: false,
      addEventListener: (name, fn) => this.events.set(name, fn), removeEventListener: name => this.events.delete(name),
      close: () => { this.closeCalls++; this.closed = true; this.window.closed = true; this.data?.beforeUnloadCallback?.(); },
      focus: () => { this.focused = true; },
    };
  }
  element(tag, props = {}, attributes = {}) {
    const events = new Map();
    const node = { tag, children: [], style: {}, ownerDocument: this.document, ...props,
      getAttribute: name => attributes[name], setAttribute: (name, value) => { attributes[name] = value; },
      appendChild: child => { node.children.push(child); if (child.id) this.nodes.set(child.id, child); },
      addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name),
      emit: name => events.get(name)?.({ currentTarget: node }),
      remove: () => { node.removed = true; if (node.id) this.nodes.delete(node.id); },
    };
    return node;
  }
  addCell(_r, _c, layout) {
    this.layout = layout;
    all(layout).forEach(node => { if (node.id) this.nodes.set(node.id, this.element(node.tag, { ...node.properties, style: { ...node.styles } }, { ...node.attributes })); });
    return this;
  }
  addButton(label, id, options) {
    this.buttons[id] = { label, ...options };
    this.nodes.set(id, this.element('button', { textContent: label, disabled: false }));
    return this;
  }
  click(id) {
    if (this.nodes.get(id)?.disabled) return;
    this.buttons[id].callback?.();
    if (!this.buttons[id].noClose) this.window.close();
  }
  setDialogData(data) { this.data = data; this.dialogData = data; this.window.arguments = [data]; return this; }
  open() { this.data?.loadCallback?.(); return this; }
}
module.exports = { Dialog, all };
