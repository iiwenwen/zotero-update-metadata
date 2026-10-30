const PLUGIN_ID = require("../addon/manifest.json").applications.zotero.id;
// 无GUI机制测试；通过UI专用离线fixture运行，不接管真实Zotero。
const { expect } = require("chai");

describe("原生条目侧栏离线机制", function () {
  let api;
  let originalZotero;
  let originalAddon;
  let host;
  let prefs;
  let observer;
  let registrations;
  let unregistrations;
  let activity;
  let activityListener;
  let unsubscribed;
  let runs;
  let controller;
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const ref = (id = 1, data = {}) => ({
    id, libraryID: 1, key: `KEY${id}`,
    isRegularItem: () => true, isEditable: () => true,
    getField: (key) => key === "url" ? "https://example.org/article" : "",
    ...data,
  });

  class Element {
    constructor(tag) { this.tagName = tag; this.style = {}; this.attributes = {}; this.listeners = {}; this.children = []; this.textContent = ""; }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    closest(tag) { let node = this; while (node) { if (node.tagName === tag) return node; node = node.parentNode; } return null; }
    addEventListener(name, handler) { (this.listeners[name] ||= new Set()).add(handler); }
    removeEventListener(name, handler) { this.listeners[name]?.delete(handler); }
    append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((node) => node !== this); }
    fire(name) { for (const handler of this.listeners[name] || []) handler(); }
  }

  function windowFor(item = ref()) {
    return {
      closed: false, selected: item ? [item] : [], editable: true,
      MozXULElement: { insertFTLIfNeeded() {} },
      ZoteroPane: {
        getSelectedItems() { return this.owner.selected; },
        canEdit() { return this.owner.editable; },
      },
    };
  }

  function mount(win, item = win.selected[0], overrides = {}) {
    win.ZoteroPane.owner = win;
    const options = registrations[0];
    const body = new Element("div");
    const section = new Element("collapsible-section");
    section.setAttribute("data-l10n-id", options.header.l10nID);
    section.append(body);
    const doc = {
      defaultView: win,
      createXULElement(tag) {
        const node = new Element(tag); node.namespaceURI = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul"; return node;
      },
      createElementNS(namespace, tag) {
        expect(namespace).to.equal("http://www.w3.org/1999/xhtml");
        return new Element(tag);
      },
      l10n: { formatValue: async (id) => id },
    };
    const pane = { visible: true, refreshCount: 0 };
    const current = { body, doc, item, editable: true, tabType: "library", ...overrides };
    const props = () => ({
      ...current,
      setEnabled: (value) => { pane.visible = value; },
      refresh: async () => { pane.refreshCount += 1; if (pane.visible) options.onRender(props()); },
    });
    options.onInit(props());
    options.onItemChange(props());
    if (pane.visible) options.onRender(props());
    return {
      ...pane,
      get visible() { return pane.visible; },
      get refreshCount() { return pane.refreshCount; },
      body, section,
      change(next, render = true) {
        current.item = next;
        options.onItemChange(props());
        if (render && pane.visible) options.onRender(props());
      },
      render() { options.onRender(props()); },
      destroy() { options.onDestroy(props()); },
      node(id) { return body.children[0]?.children.find((node) => node.attributes["data-l10n-id"] === id); },
    };
  }

  before(function () {
    api = Zotero.zmtaAddon?.uiTestApi;
    if (!api) this.skip();
  });

  beforeEach(function () {
    originalZotero = globalThis.Zotero;
    originalAddon = globalThis.addon;
    prefs = new Map(); observer = null; registrations = []; unregistrations = [];
    activity = "idle"; activityListener = null; unsubscribed = 0;
    runs = [];
    host = {
      debug() {}, alert() {},
      Prefs: {
        get: (key) => prefs.get(key),
        registerObserver(key, callback, global) {
          expect(key).to.equal("extensions.zmta.showItemPane");
          expect(global).to.equal(true);
          observer = callback;
          return Symbol.for("ui-pref-observer");
        },
        unregisterObserver(key) { expect(key).to.equal(Symbol.for("ui-pref-observer")); observer = null; },
      },
      ItemPaneManager: {
        registerSection(options) { registrations.push(options); return "host-returned-key"; },
        unregisterSection(key) { unregistrations.push(key); },
      },
    };
    globalThis.Zotero = host;
    globalThis.addon = { data: { rootURI: "file:///plugin/" } };
    controller = new api.ItemPaneController({
      getWorkflowActivity: () => activity,
      subscribeWorkflowActivity(listener) { activityListener = listener; return () => { unsubscribed += 1; activityListener = null; }; },
      getToolkit: () => "same-toolkit",
      runBatchWorkflow: async (...args) => { runs.push(args); },
    });
  });

  afterEach(function () {
    controller.shutdown();
    globalThis.Zotero = originalZotero;
    globalThis.addon = originalAddon;
  });

  it("插件级注册一次、注入本地化，使用宿主返回键统一注销", function () {
    const first = windowFor(); const second = windowFor();
    controller.register(first); controller.register(first); controller.register(second);
    expect(registrations).to.have.lengthOf(1);
    const options = registrations[0];
    expect(options.pluginID).to.equal(PLUGIN_ID);
    expect(options.header.l10nID).to.equal("zmta-item-pane-header");
    expect(options.sidenav.l10nID).to.equal("zmta-item-pane-sidenav");
    expect(options.header.icon).to.equal("file:///plugin/content/icons/favicon-16.svg");
    expect(options.sidenav.icon).to.equal("file:///plugin/content/icons/favicon-20.svg");
    expect(options.header.darkIcon).to.equal(undefined);
    expect(options.sidenav.darkIcon).to.equal(undefined);
    controller.unloadWindow(first);
    expect(unregistrations).to.deep.equal([]);
    controller.shutdown(); controller.shutdown();
    expect(unregistrations).to.deep.equal(["host-returned-key"]);
    expect(observer).to.equal(null);
    expect(unsubscribed).to.equal(1);
  });

  it("热升级保留旧FTL链接时刷新插件资源，并翻译header与动态HTML文案", async function () {
    const win = windowFor();
    const latest = new Map([
      ["zmta-item-pane-header", "元数据更新"],
      ["zmta-item-pane-source-url", "URL 已填写"],
      ["zmta-item-pane-ready", "来源将在审核时获取"],
      ["zmta-item-pane-review", "审核此条目的更新"],
    ]);
    let cached = new Map(); // 旧0.3窗口没有本次新增键
    const removed = []; const added = []; const translated = [];
    const resources = new Set(["zotero.ftl", "other-plugin.ftl", "zmta-mainWindow.ftl"]);
    const l10n = {
      formatValue: async (id) => cached.get(id),
      translateFragment: async (fragment) => {
        translated.push(fragment);
        const visit = (element) => {
          const value = cached.get(element.getAttribute("data-l10n-id"));
          if (value) {
            if (element.tagName === "collapsible-section" || element.namespaceURI?.includes("there.is.only.xul")) element.setAttribute("label", value);
            else element.textContent = value;
          }
          element.children.forEach(visit);
        };
        visit(fragment);
      },
    };
    win.document = {
      defaultView: win, l10n,
      createXULElement: (tag) => { const node = new Element(tag); node.namespaceURI = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul"; return node; },
      createElementNS: (_namespace, tag) => new Element(tag),
    };
    // 模拟原生insertFTLIfNeeded：已有同名link，直接返回，不刷新旧缓存。
    win.MozXULElement.insertFTLIfNeeded = () => {};
    controller.register(win);
    const pane = mount(win, win.selected[0], { doc: win.document });
    await flush();
    expect(pane.section.getAttribute("label")).to.equal(null);
    expect(pane.node("zmta-item-pane-review").textContent).to.equal("");
    // DocumentL10n公开接口可用时，仅重置自己的资源，再显式翻译片段。
    l10n.removeResourceIds = (ids) => { removed.push(ids); ids.forEach((id) => resources.delete(id)); cached = new Map(); };
    l10n.addResourceIds = (ids) => { added.push(ids); ids.forEach((id) => resources.add(id)); cached = new Map(latest); };
    api.refreshMainWindowLocalization(win);
    pane.render(); await flush();
    expect(removed).to.deep.equal([["zmta-mainWindow.ftl", "zmta-dialogs.ftl"]]);
    expect(added).to.deep.equal([["zmta-mainWindow.ftl", "zmta-dialogs.ftl"]]);
    expect(pane.section.getAttribute("label")).to.equal("元数据更新");
    expect(pane.node("zmta-item-pane-review").getAttribute("label")).to.equal(latest.get("zmta-item-pane-review"));
    for (const id of ["source-url", "ready"]) {
      expect(pane.node(`zmta-item-pane-${id}`).textContent).to.equal(latest.get(`zmta-item-pane-${id}`));
    }
    expect(translated.every((fragment) => fragment === pane.section)).to.equal(true);
    expect(resources.has("zotero.ftl") && resources.has("other-plugin.ftl")).to.equal(true);
    controller.register(win); await flush();
    expect(removed).to.have.lengthOf(1); expect(added).to.have.lengthOf(1);
  });

  it("新窗口section先初始化、插件窗口回调后到时补接已有容器", async function () {
    const first = windowFor(); const second = windowFor(ref(2));
    controller.register(first);
    const firstPane = mount(first);
    // 全局section已存在，宿主新窗口渲染可先于插件onMainWindowLoad。
    const abandoned = mount(second); abandoned.destroy();
    const secondPane = mount(second);
    controller.register(second);
    await flush();
    expect(registrations).to.have.lengthOf(1);
    expect(abandoned.body.children).to.have.lengthOf(0);
    expect(secondPane.body.children).to.have.lengthOf(1);
    secondPane.node("zmta-item-pane-review").fire("command"); await flush();
    expect(runs[0][0]).to.deep.equal(second.selected);
    controller.unloadWindow(first);
    expect(unregistrations).to.deep.equal([]);
    activityListener("idle");
    expect(secondPane.node("zmta-item-pane-review").disabled).to.equal(false);
    expect(firstPane.body.children).to.have.lengthOf(0);
  });

  it("API缺失或注册失败不抛出、不留下偏好／忙碌监听", function () {
    host.ItemPaneManager = null;
    controller.register(windowFor());
    expect(observer).to.equal(null); expect(activityListener).to.equal(null);
    host.ItemPaneManager = { registerSection: () => false, unregisterSection() {} };
    controller.register(windowFor());
    expect(observer).to.equal(null); expect(activityListener).to.equal(null);
  });

  it("本地选择、来源和权限分型，不获取任何来源", function () {
    const item = ref(); const win = windowFor(item); win.ZoteroPane.owner = win;
    const state = (paneItem = item, editable = true, tabType = "library") => api.getItemPaneState(win, paneItem, editable, tabType);
    expect(state().eligibility).to.equal("ready");
    expect(state().sourceHint).to.equal("url");
    win.selected = []; expect(state().eligibility).to.equal("none");
    win.selected = [item, ref(2)]; expect(state().eligibility).to.equal("multiple");
    win.selected = [ref(1, { isRegularItem: () => false })]; expect(state().eligibility).to.equal("unsupported");
    win.selected = [ref(1, { isFeedItem: true })]; expect(state().eligibility).to.equal("unsupported");
    win.selected = [item]; win.editable = false; expect(state().eligibility).to.equal("readonly");
    win.editable = true; expect(state(item, false).eligibility).to.equal("readonly");
    win.selected = [ref(1, { isEditable: () => false })]; expect(state().eligibility).to.equal("readonly");
    win.selected = [ref(1, { getField: () => "" })]; expect(state().eligibility).to.equal("missing-source");
    win.selected = [ref(1, { getField: (key) => key === "url" ? "not-a-web-address" : "" })];
    expect(state().eligibility).to.equal("invalid-source");
    win.selected = [ref(1, { getField: (key) => key === "DOI" ? "https://doi.org/10.1234/abc" : "" })];
    expect(state().sourceHint).to.equal("doi");
    win.selected = [item]; expect(state(ref(2)).eligibility).to.equal("unavailable");
    expect(state(item, true, "reader").eligibility).to.equal("unavailable");
    win.Zotero_Tabs = { selectedType: "reader" };
    expect(state().eligibility).to.equal("unavailable");
    expect(runs).to.have.lengthOf(0);
  });

  it("开关即时隐藏／恢复现有容器，不注销section或触发审核", async function () {
    const win = windowFor(); controller.register(win); const pane = mount(win);
    const button = pane.node("zmta-item-pane-review");
    expect(button.disabled).to.equal(false);
    prefs.set("extensions.zmta.showItemPane", false); observer();
    expect(pane.visible).to.equal(false);
    button.fire("command"); await flush(); expect(runs).to.have.lengthOf(0);
    prefs.set("extensions.zmta.showItemPane", true); observer();
    expect(pane.visible).to.equal(true); expect(pane.refreshCount).to.equal(1);
    expect(pane.node("zmta-item-pane-review")).to.equal(button);
    expect(unregistrations).to.deep.equal([]);
    prefs.set("extensions.zmta.showItemPane", "false"); observer();
    expect(pane.visible).to.equal(false);
  });

  it("无选／多选接受宿主空态，Reader不启用插件区", function () {
    const win = windowFor(null); controller.register(win); const pane = mount(win);
    expect(pane.visible).to.equal(false);
    win.selected = [ref(), ref(2)]; pane.change(win.selected[0]); expect(pane.visible).to.equal(false);
    win.selected = [ref()];
    const readerPane = mount(win, win.selected[0], { tabType: "reader" });
    expect(readerPane.visible).to.equal(false);
    expect(runs).to.have.lengthOf(0);
  });

  it("只读和缺来源时按钮禁用，强制触发事件也不调用审核", async function () {
    const item = ref(1, { getField: () => "" }); const win = windowFor(item);
    controller.register(win); const pane = mount(win);
    const button = pane.node("zmta-item-pane-review");
    expect(button.disabled).to.equal(true); button.fire("command"); await flush();
    expect(runs).to.have.lengthOf(0);
    win.selected = [ref()]; win.editable = false; pane.change(win.selected[0]);
    expect(button.disabled).to.equal(true); button.fire("command"); await flush();
    expect(runs).to.have.lengthOf(0);
  });

  it("侧栏只提供当前条目的审核入口", async function () {
    const item = ref(); const win = windowFor(item);
    controller.register(win); const pane = mount(win);
    pane.node("zmta-item-pane-review").fire("command"); await flush();
    expect(runs).to.deep.equal([[[item], "same-toolkit", win]]);
    expect(pane.node("zmta-item-pane-inspect")).to.equal(undefined);
    expect(pane.node("zmta-item-pane-settings")).to.equal(undefined);
    expect(runs).to.have.lengthOf(1);
  });

  it("点击时重新检查权限、选择和pane身份，不能沿用旧渲染的A更新B", async function () {
    const first = ref(); const second = ref(2); const win = windowFor(first);
    controller.register(win); const pane = mount(win);
    const button = pane.node("zmta-item-pane-review");
    win.selected = [second]; button.fire("command"); await flush();
    expect(runs).to.have.lengthOf(0);
    win.selected = [first]; pane.change(first);
    win.selected = [second]; pane.change(second, false);
    button.fire("command"); await flush(); expect(runs).to.have.lengthOf(0);
    button.fire("command"); await flush(); expect(runs[0][0]).to.deep.equal([second]);
    win.editable = false;
    button.fire("command"); await flush(); expect(runs).to.have.lengthOf(1);
  });

  it("共同忙碌订阅禁用审核，不建立第二把锁", async function () {
    const win = windowFor(); controller.register(win); const pane = mount(win);
    const button = pane.node("zmta-item-pane-review");
    activity = "reviewing"; activityListener(activity);
    expect(button.disabled).to.equal(true);
    expect(pane.node("zmta-item-pane-busy")).to.exist;
    button.fire("command"); await flush(); expect(runs).to.have.lengthOf(0);
    activity = "idle"; activityListener(activity);
    expect(button.disabled).to.equal(false);
  });

  it("A审核进行中切换B，A完成不刷新B或展示A结果", async function () {
    let finish;
    const pending = new Promise((resolve) => { finish = resolve; });
    controller.actions.runBatchWorkflow = (...args) => { runs.push(args); return pending; };
    const first = ref(); const second = ref(2); const win = windowFor(first);
    controller.register(win); const pane = mount(win);
    pane.node("zmta-item-pane-review").fire("command");
    win.selected = [second]; pane.change(second);
    const count = pane.refreshCount;
    finish({ applied: 1 }); await flush();
    expect(runs[0][0]).to.deep.equal([first]);
    expect(pane.refreshCount).to.equal(count);
    expect(pane.node("zmta-item-pane-ready")).to.exist;
  });

  it("单窗口卸载清理自己的事件和引用，其余窗口仍能刷新和审核", async function () {
    const first = windowFor(); const second = windowFor(ref(2));
    controller.register(first); controller.register(second);
    const firstPane = mount(first); const secondPane = mount(second);
    const stale = firstPane.node("zmta-item-pane-review");
    controller.unloadWindow(first);
    expect(stale.listeners.command.size).to.equal(0);
    stale.fire("command"); await flush(); expect(runs).to.have.lengthOf(0);
    expect(unregistrations).to.deep.equal([]);
    activityListener("idle");
    expect(firstPane.refreshCount).to.equal(0); expect(secondPane.refreshCount).to.equal(1);
    secondPane.node("zmta-item-pane-review").fire("command"); await flush(); expect(runs).to.have.lengthOf(1);
  });

  it("销毁／关闭窗口后不刷新、不接收动作，也不更新进行中结果", async function () {
    let finish;
    controller.actions.runBatchWorkflow = () => new Promise((resolve) => { finish = resolve; });
    const win = windowFor(); controller.register(win); const pane = mount(win);
    const button = pane.node("zmta-item-pane-review");
    // 直接等待生产动作Promise：原先仅fire+flush会漏掉异步清理阶段的rejection。
    const completion = controller.review(controller.contexts.get(pane.body));
    pane.destroy(); pane.destroy();
    finish(null); await completion; await flush();
    activityListener("idle");
    expect(pane.refreshCount).to.equal(0);
    expect(button.listeners.command.size).to.equal(0);
    expect(pane.body.children).to.have.lengthOf(0);
  });

  it("窗口卸载先释放上下文，未结束审核随后完成仍正常收口", async function () {
    let finish;
    controller.actions.runBatchWorkflow = () => new Promise((resolve) => { finish = resolve; });
    const win = windowFor(); controller.register(win); const pane = mount(win);
    const button = pane.node("zmta-item-pane-review");
    const completion = controller.review(controller.contexts.get(pane.body));
    controller.unloadWindow(win); win.closed = true;
    finish(null); await completion;
    expect(pane.refreshCount).to.equal(0);
    expect(button.listeners.command.size).to.equal(0);
    expect(unregistrations).to.deep.equal([]);
  });

  it("插件停用后未结束审核失败不再读已销毁props或弹出错误窗口", async function () {
    let fail;
    const alerts = [];
    host.alert = (...args) => alerts.push(args);
    controller.actions.runBatchWorkflow = () => new Promise((_resolve, reject) => { fail = reject; });
    const win = windowFor(); controller.register(win); const pane = mount(win);
    const completion = controller.review(controller.contexts.get(pane.body));
    controller.shutdown();
    fail(new Error("owner closed")); await completion;
    expect(alerts).to.deep.equal([]);
    expect(pane.refreshCount).to.equal(0);
    expect(unregistrations).to.deep.equal(["host-returned-key"]);
  });

  it("菜单与侧栏读取A线同一生产占用状态，占用释放后同步恢复", async function () {
    controller.actions.getWorkflowActivity = api.getWorkflowActivity;
    controller.actions.subscribeWorkflowActivity = api.subscribeWorkflowActivity;
    const win = windowFor(); controller.register(win); const pane = mount(win);
    const menu = api.buildBatchMenuEntries(win)[0].menus[0];
    let enabled;
    const release = api.tryAcquireWorkflowActivity("reviewing");
    try {
      menu.onShowing(null, { setEnabled: (value) => { enabled = value; } });
      expect(enabled).to.equal(false);
      expect(pane.node("zmta-item-pane-review").disabled).to.equal(true);
      pane.node("zmta-item-pane-review").fire("command"); await flush(); expect(runs).to.have.lengthOf(0);
    } finally { release(); }
    menu.onShowing(null, { setEnabled: (value) => { enabled = value; } });
    expect(enabled).to.equal(true);
    expect(pane.node("zmta-item-pane-review").disabled).to.equal(false);
  });

  it("右键判断拒绝删除、feed 和只读项，全局菜单使用事件所属窗口", function () {
    const valid = ref(); const readonly = ref(2, { isEditable: () => false });
    const first = windowFor(); first.ZoteroPane.owner = first;
    const second = windowFor(valid); second.ZoteroPane.owner = second;
    expect(api.canReviewBatchItems([{ ...valid, deleted: true }], second)).to.equal(false);
    expect(api.canReviewBatchItems([{ ...valid, isFeedItem: true }], second)).to.equal(false);
    expect(api.canReviewBatchItems([readonly, readonly], second)).to.equal(false);
    expect(api.canReviewBatchItems([valid, readonly], second)).to.equal(true);
    second.editable = false;
    expect(api.canReviewBatchItems([valid, readonly], second)).to.equal(false);
    second.editable = true;
    first.selected = [];
    const [parent] = api.buildBatchMenuEntries(first);
    let enabled = false;
    parent.menus[0].onShowing(null, { menuElem: { ownerGlobal: second }, setEnabled: (value) => { enabled = value; } });
    expect(enabled).to.equal(true);
    const global = api.buildToolsMenuEntries(second)[0].menus[0];
    expect(global.l10nID).to.equal("zmta-inspect-batches-menu-label");
    expect(global.onCommand).to.be.a("function");
  });

  it("英文菜单入口校验与侧栏条件一致，拒绝后不开始审核", function () {
    host.locale = "en-US";
    const alerts = [];
    host.alert = (_win, title, message) => alerts.push({ title, message });
    const win = windowFor(null); win.ZoteroPane.owner = win;
    const [parent] = api.buildBatchMenuEntries(win);
    parent.menus[0].onCommand(null, {});
    parent.menus[1].onCommand(null, {});
    expect(alerts).to.have.lengthOf(2);
    expect(alerts[0].message).to.include("valid URL or DOI");
    expect(alerts[1].message).to.include("valid DOI");
    expect(alerts.every(({ title, message }) => title === "Metadata Update" && !/[\u4e00-\u9fff]/.test(message))).to.equal(true);
    expect(runs).to.have.lengthOf(0);
  });

  it("macOS隐藏规则仅为本插件父菜单覆盖，逐窗口幂等安装与清理", function () {
    const styles = [];
    const win = { document: {
      createElementNS: (_ns, tag) => new Element(tag),
      documentElement: { appendChild: style => styles.push(style) },
    } };
    api.installMenuIconStyle(win); api.installMenuIconStyle(win);
    expect(styles).to.have.lengthOf(1);
    expect(styles[0].textContent).to.include('#zotero-itemmenu menu[data-l10n-id="zmta-douban-metadata-menu-label"] > .menu-icon');
    expect(styles[0].textContent).to.include('display: flex !important');
    let removed = false; styles[0].remove = () => { removed = true; };
    api.removeMenuIconStyle(win); expect(removed).to.equal(true);
    api.installMenuIconStyle(win); expect(styles).to.have.lengthOf(2);
    api.removeMenuIconStyle(win);
  });

  it("生产hooks在API缺失时保留菜单，每窗口卸载不影响另一窗口", async function () {
    const registeredMenus = []; const removedMenus = [];
    host.ItemPaneManager = null;
    host.MenuManager = {
      registerMenu(options) { registeredMenus.push(options); return `menu-${registeredMenus.length}`; },
      unregisterMenu(key) { removedMenus.push(key); },
    };
    globalThis.addon.data.ztoolkit = {};
    const first = windowFor(); const second = windowFor(ref(2));
    try {
      await api.hooks.onMainWindowLoad(first); await api.hooks.onMainWindowLoad(second);
      expect(registeredMenus).to.have.lengthOf(2);
      expect(registeredMenus[0].menus[0].menus).to.have.lengthOf(2);
      expect(registeredMenus[1].target).to.equal("main/menubar/tools");
      await api.hooks.onMainWindowUnload(first);
      expect(removedMenus).to.deep.equal([]);
    } finally { api.hooks.onShutdown(); api.beginPluginDialogScope(); }
    expect(removedMenus).to.deep.equal(["menu-1", "menu-2"]);
  });

  it("入口异常提供普通失败提示，不依赖旧技术偏好", async function () {
    const alerts = [];
    host.alert = (...args) => alerts.push(args);
    controller.actions.runBatchWorkflow = async () => { throw new Error("window unavailable"); };
    const win = windowFor(); controller.register(win); const pane = mount(win);
    pane.node("zmta-item-pane-review").fire("command"); await flush();
    expect(alerts).to.have.lengthOf(1);
    expect(alerts[0][2]).to.equal("zmta-item-pane-review-error");
    expect(pane.node("zmta-item-pane-review").disabled).to.equal(false);
  });
});
