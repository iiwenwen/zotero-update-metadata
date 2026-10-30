// 原生偏好API fake host：不写真实Zotero偏好或资料库。
const { expect } = require("chai");

describe("三项普通设置离线机制", function () {
  let api;
  let original;
  let user;
  let cleared;
  let observers;
  const defaults = { showItemPane: true, defaultSelectAttachments: false, defaultSelectNotes: false };
  const prefix = "extensions.zmta.";

  before(function () {
    api = Zotero.zmtaAddon?.uiTestApi;
    if (!api) this.skip();
  });
  beforeEach(function () {
    original = globalThis.Zotero;
    user = new Map(); cleared = []; observers = new Map();
    globalThis.Zotero = { Prefs: {
      get(key, global) {
        expect(global).to.equal(true);
        return user.has(key) ? user.get(key) : defaults[key.slice(prefix.length)];
      },
      clear(key, global) { expect(global).to.equal(true); cleared.push(key); user.delete(key); },
      registerObserver(key, listener, global) {
        expect(global).to.equal(true);
        const token = Symbol(key); observers.set(token, { key, listener }); return token;
      },
      unregisterObserver(token) { observers.delete(token); },
    } };
  });
  afterEach(function () { api.unloadMetadataPreferences(); globalThis.Zotero = original; });

  it("侧栏未设置默认开启，非法值和读取失败均关闭", function () {
    expect(api.isItemPaneShown()).to.equal(true);
    for (const value of [false, "false", "true", 1, null, {}, []]) {
      user.set(prefix + "showItemPane", value);
      expect(api.isItemPaneShown()).to.equal(false);
    }
    user.set(prefix + "showItemPane", true); expect(api.isItemPaneShown()).to.equal(true);
    Zotero.Prefs.get = () => undefined; expect(api.isItemPaneShown()).to.equal(true);
    Zotero.Prefs.get = () => { throw new Error("pref unavailable"); }; expect(api.isItemPaneShown()).to.equal(false);
  });

  it("恢复默认只清除三项用户值，保留旧技术偏好及其他状态", function () {
    user.set(prefix + "showTechnicalDetails", true);
    user.set(prefix + "journalMarker", "keep");
    for (const [key, value] of Object.entries(defaults)) user.set(prefix + key, !value);
    api.resetMetadataPreferences();
    expect(cleared).to.deep.equal(Object.keys(defaults).map((key) => prefix + key));
    expect(user.get(prefix + "showTechnicalDetails")).to.equal(true);
    expect(user.get(prefix + "journalMarker")).to.equal("keep");
    for (const [key, value] of Object.entries(defaults)) expect(Zotero.Prefs.get(prefix + key, true)).to.equal(value);
  });

  it("恢复默认后原位提示成功，并留在设置页", function () {
    const attributes = {};
    const win = { document: { getElementById: id => id === "zmta-pref-status" ? { setAttribute: (key, value) => { attributes[key] = value; } } : null } };
    api.hooks.onPrefsEvent("reset", { window: win });
    // 构建给 FTL 消息 id 加插件前缀；运行时写入的 id 必须与构建产物一致，否则设置页显示原文 id。
    expect(attributes["data-l10n-id"]).to.equal("zmta-pref-defaults-restored");
    expect(cleared).to.have.lengthOf(3);
  });
  it("设置窗口各自释放观察者，插件统一清理剩余控件", function () {
    function makeWindow() {
      const listeners = new Set();
      const controls = Object.fromEntries(Object.keys(defaults).map((key) => [
        `zotero-prefpane-zmta-${key}`, {
          listeners: new Set(),
          addEventListener(_type, handler) { this.listeners.add(handler); },
          removeEventListener(_type, handler) { this.listeners.delete(handler); },
        },
      ]));
      return {
        listeners, controls, document: { getElementById: (id) => controls[id] },
        addEventListener(_type, handler) { listeners.add(handler); },
        removeEventListener(_type, handler) { listeners.delete(handler); },
      };
    }
    const first = makeWindow(); const second = makeWindow();
    api.initializeMetadataPreferences(first); api.initializeMetadataPreferences(second);
    expect(observers.size).to.equal(6);
    for (const listener of [...first.listeners]) listener();
    expect(observers.size).to.equal(3); expect(first.listeners.size).to.equal(0);
    for (const control of Object.values(first.controls)) expect(control.listeners.size).to.equal(0);
    expect(second.listeners.size).to.equal(1);
    api.unloadMetadataPreferences();
    expect(observers.size).to.equal(0); expect(second.listeners.size).to.equal(0);
    for (const control of Object.values(second.controls)) expect(control.listeners.size).to.equal(0);
  });

  it("原生同步事件严格显示布尔值，重复load不重复监听且不写回虚构迁移", function () {
    const controls = {};
    for (const key of Object.keys(defaults)) {
      controls[`zotero-prefpane-zmta-${key}`] = {
        listeners: [], checked: null,
        addEventListener(type, handler) { expect(type).to.equal("syncfrompreference"); this.listeners.push(handler); },
        removeEventListener(type, handler) { expect(type).to.equal("syncfrompreference"); this.listeners = this.listeners.filter((listener) => listener !== handler); },
      };
    }
    const windowListeners = new Set();
    const win = {
      document: { getElementById: (id) => controls[id] },
      addEventListener(type, listener) { expect(type).to.equal("unload"); windowListeners.add(listener); },
      removeEventListener(type, listener) { expect(type).to.equal("unload"); windowListeners.delete(listener); },
    };
    api.initializeMetadataPreferences(win); api.initializeMetadataPreferences(win);
    expect(observers.size).to.equal(3); expect(windowListeners.size).to.equal(1);
    for (const [key, value] of Object.entries(defaults)) {
      const control = controls[`zotero-prefpane-zmta-${key}`];
      expect(control.checked).to.equal(value); expect(control.listeners).to.have.lengthOf(1);
      user.set(prefix + key, "false"); control.checked = true; control.listeners[0]();
      expect(control.checked).to.equal(false);
      user.set(prefix + key, true); control.listeners[0](); expect(control.checked).to.equal(true);
    }
    expect(cleared).to.deep.equal([]);
    // 原生_syncFromPref会跳过“!!value没变”的事件；偏好观察仍必须生效。
    const note = controls["zotero-prefpane-zmta-defaultSelectNotes"];
    note.checked = true;
    user.set(prefix + "defaultSelectNotes", "false");
    for (const observer of observers.values()) if (observer.key === prefix + "defaultSelectNotes") observer.listener();
    expect(note.checked).to.equal(false);
    for (const listener of [...windowListeners]) listener();
    expect(windowListeners.size).to.equal(0); expect(observers.size).to.equal(0);
    for (const control of Object.values(controls)) expect(control.listeners).to.have.lengthOf(0);
  });
});
