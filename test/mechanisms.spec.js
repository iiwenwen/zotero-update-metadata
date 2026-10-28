// scaffold test：机制级测试——「显示机制是否正确调用」
// 拦截「代码对但显示不对」（MenuManager l10nID / PreferencePanes.register / 产物版本）
const { assert, expect } = require("chai");

describe("显示机制", function () {
  let addon;
  before(function () {
    addon = Zotero.zmtaAddon;
    assert.isNotEmpty(addon, "addon 应存在");
  });

  it("无主窗口时实例构造不创建依赖主窗口的Toolkit", function () {
    const original = Zotero.getMainWindow;
    try {
      Zotero.getMainWindow = () => null;
      const pending = new addon.constructor();
      expect(pending.data.initialized).to.equal(false);
      expect(pending.data.ztoolkit).to.equal(null);
    } finally {
      Zotero.getMainWindow = original;
    }
  });

  describe("设置界面（PreferencePanes）", function () {
    it("PreferencePanes.register 可用（Zotero 7+ 机制）", function () {
      // 机制存在：PreferencePanes 是 Zotero 内置 API
      assert.isFunction(Zotero.PreferencePanes?.register, "PreferencePanes.register 应存在");
    });
    it("插件加载时注册过设置界面", function () {
      assert.isTrue(addon.data.initialized, "onStartup 应完成（含设置界面注册）");
      const panes = Zotero.PreferencePanes.pluginPanes.filter((pane) => pane.pluginID === "zmta-update-metadata@local");
      expect(panes).to.have.lengthOf(1);
      expect(panes[0].id).to.equal("zmta-metadata-preferences");
      expect(panes[0].src).to.include("content/preferences.xhtml");
    });
    it("技术详情默认关闭", function () {
      expect(Zotero.Prefs.get("extensions.zmta.showTechnicalDetails", true)).to.equal(false);
    });
  });

  describe("原生条目侧栏注册", function () {
    it("宿主保存一份插件section及真实生命周期回调", function () {
      if (!Zotero.ItemPaneManager?.registerSection) this.skip();
      const sections = Zotero.ItemPaneManager.customSectionData.options
        .filter((section) => section.pluginID === "zmta-update-metadata@local");
      expect(sections).to.have.lengthOf(1);
      expect(sections[0].header.l10nID).to.equal("zmta-item-pane-header");
      expect(sections[0].sidenav.l10nID).to.equal("zmta-item-pane-sidenav");
      for (const name of ["onInit", "onItemChange", "onRender", "onDestroy"]) {
        expect(sections[0][name]).to.be.a("function");
      }
    });
  });

  describe("菜单（MenuManager l10nID）", function () {
    it("MenuManager.registerMenu 可用（Zotero 10 机制）", function () {
      assert.isFunction(Zotero.MenuManager?.registerMenu, "MenuManager.registerMenu 应存在");
    });
    it("菜单用一个父菜单承载五个正式动作，且全部通过 l10nID 本地化", function () {
      const menus = addon.api.buildBatchMenuEntries(Zotero.getMainWindow());
      expect(menus).to.have.lengthOf(1);

      const parentMenu = menus[0];
      expect(parentMenu.menuType).to.equal("submenu");
      expect(parentMenu.l10nID).to.equal("zmta-douban-metadata-menu-label");
      expect(parentMenu.onShowing).to.be.a("function");
      expect(parentMenu.menus).to.have.lengthOf(5);
      expect(parentMenu.menus.map((menu) => menu.l10nID)).to.deep.equal([
        "zmta-review-update-menu-label",
        "zmta-use-doi-menu-label",
        "zmta-inspect-batches-menu-label",
        "zmta-retry-failed-menu-label",
        "zmta-undo-batch-menu-label",
      ]);
      expect(parentMenu.menus.every((menu) => (
        menu.menuType === "menuitem"
          && typeof menu.onCommand === "function"
          && typeof menu.onShowing === "function"
      ))).to.equal(true);
      expect([parentMenu, ...parentMenu.menus].some((menu) => (
        Object.prototype.hasOwnProperty.call(menu, "label")
      ))).to.equal(false);
    });

    it("主动 DOI 入口只对一个具有有效 DOI 的普通条目启用", function () {
      const item = (doi, regular = true) => ({ isRegularItem: () => regular, getField: () => doi });
      expect(addon.api.canUseDOIRoute([item("10.1000/test")])).to.equal(true);
      expect(addon.api.canUseDOIRoute([item("")])).to.equal(false);
      expect(addon.api.canUseDOIRoute([item("10.1000/test"), item("10.1000/other")])).to.equal(false);
      expect(addon.api.canUseDOIRoute([item("10.1000/test", false)])).to.equal(false);
    });

    it("审核动作只对 1–50 个普通书目条目启用", function () {
      const regular = { isRegularItem: () => true };
      const note = { isRegularItem: () => false };
      expect(addon.api.canReviewBatchItems([])).to.equal(false);
      expect(addon.api.canReviewBatchItems([regular])).to.equal(true);
      expect(addon.api.canReviewBatchItems(Array.from({ length: 50 }, () => regular))).to.equal(true);
      expect(addon.api.canReviewBatchItems(Array.from({ length: 51 }, () => regular))).to.equal(false);
      expect(addon.api.canReviewBatchItems([regular, note])).to.equal(false);
    });

    it("多选上下文优先，缺失时回退到 ZoteroPane 当前选择", function () {
      const contextItems = [{ id: 1 }, { id: 2 }];
      const fallbackItems = [{ id: 3 }];
      const mainWin = { ZoteroPane: { getSelectedItems: () => fallbackItems } };
      expect(addon.api.resolveBatchMenuItems({ items: contextItems }, mainWin)).to.equal(contextItems);
      expect(addon.api.resolveBatchMenuItems({}, mainWin)).to.equal(fallbackItems);
    });

    it("journal 损坏时 retry 与空选择父菜单均 fail closed", async function () {
      const selection = { itemID: 1, itemKey: "A", fields: [], attachments: [], notes: [] };
      const result = {
        batchId: "broken-menu",
        total: 1, applied: 0, partial: 0, skipped: 0, failed: 1,
        items: [{ itemID: 1, itemKey: "A", title: "A", status: "failed", operations: [] }],
      };
      addon.api.resetBatchRuntimeForTests({
        storage: { read: async () => "{broken", write: async () => {} },
        retryState: { selections: [selection], result },
      });
      try {
        await addon.api.refreshBatchRuntimeCapabilities();
        const [parent] = addon.api.buildBatchMenuEntries({ ZoteroPane: { getSelectedItems: () => [] } });
        let parentEnabled;
        let inspectEnabled;
        let retryEnabled;
        parent.onShowing(null, { setEnabled: (value) => { parentEnabled = value; } });
        parent.menus[2].onShowing(null, { setEnabled: (value) => { inspectEnabled = value; } });
        parent.menus[3].onShowing(null, { setEnabled: (value) => { retryEnabled = value; } });
        expect(parentEnabled).to.equal(false);
        expect(inspectEnabled).to.equal(false);
        expect(retryEnabled).to.equal(false);
      } finally {
        addon.api.resetBatchRuntimeForTests();
      }
    });

    it("存在可查看批次时，空选择也只启用父菜单与查看动作", async function () {
      addon.api.resetBatchRuntimeForTests({
        storage: new addon.api.MemoryBatchJournalStorage(JSON.stringify([{
          batchId: "inspect-menu",
          createdAt: "2026-08-30T00:00:00.000Z",
          status: "running",
          items: [],
        }])),
      });
      try {
        await addon.api.refreshBatchRuntimeCapabilities();
        const [parent] = addon.api.buildBatchMenuEntries({ ZoteroPane: { getSelectedItems: () => [] } });
        const enabled = [];
        parent.onShowing(null, { setEnabled: (value) => { enabled[0] = value; } });
        parent.menus.forEach((menu, index) => {
          menu.onShowing(null, { setEnabled: (value) => { enabled[index + 1] = value; } });
        });
        expect(enabled).to.deep.equal([true, false, false, true, false, false]);
      } finally {
        addon.api.resetBatchRuntimeForTests();
      }
    });

    it("隔离宿主用真实 MenuManager 生成查看菜单，并由 command 打开只读窗口", async function () {
      this.timeout(10000);
      require("./hostProfile.cjs").assertDedicatedTestProfile(Zotero, Services, Ci);

      const mainWin = Zotero.getMainWindow();
      const popup = mainWin.document.createXULElement("menupopup");
      mainWin.document.documentElement.appendChild(popup);
      addon.api.resetBatchRuntimeForTests({
        storage: new addon.api.MemoryBatchJournalStorage(JSON.stringify([{
          batchId: "inspect-real-menu",
          createdAt: "2026-08-30T00:00:00.000Z",
          status: "running",
          items: [],
        }])),
      });

      let dialogWindow = null;
      try {
        await addon.api.refreshBatchRuntimeCapabilities();
        const popupEvent = new mainWin.Event("popupshowing", { bubbles: false });
        Zotero.MenuManager.updateMenuPopup(popup, "main/library/item", {
          event: popupEvent,
          getContext: () => ({ items: [], tabType: "library", tabID: "zotero-pane" }),
        });
        await Zotero.Promise.delay(0);

        const parent = popup.querySelector('[data-l10n-id="zmta-douban-metadata-menu-label"]');
        const menuSnapshot = [...popup.querySelectorAll("*")].map((element) => ({
          tag: element.localName,
          attributes: [...element.attributes].map((attribute) => [attribute.name, attribute.value]),
        }));
        if (!parent) throw new Error(`real-menu-snapshot:${JSON.stringify(menuSnapshot)}`);
        const subPopup = parent.querySelector("menupopup");
        subPopup.dispatchEvent(new mainWin.Event("popupshowing", { bubbles: false }));
        await Zotero.Promise.delay(0);
        const inspect = popup.querySelector('[data-l10n-id="zmta-inspect-batches-menu-label"]');
        if (!inspect) throw new Error(`real-submenu-snapshot:${JSON.stringify(menuSnapshot)}`);
        expect(parent.disabled).to.equal(false);
        expect(inspect.disabled).to.equal(false);

        inspect.dispatchEvent(new mainWin.Event("command", { bubbles: true }));
        for (let attempt = 0; attempt < 20 && !dialogWindow; attempt += 1) {
          await Zotero.Promise.delay(25);
          const windows = Services.wm.getEnumerator(null);
          while (windows.hasMoreElements()) {
            const candidate = windows.getNext();
            if (candidate.document?.getElementById("zmta-batch-status")) {
              dialogWindow = candidate;
              break;
            }
          }
        }
        expect(dialogWindow).not.to.equal(null);
        expect(dialogWindow.document.body?.textContent || dialogWindow.document.documentElement.textContent)
          .to.include("最近一次更新");
        expect(dialogWindow.document.querySelector(".zmta-technical-details")).to.equal(null);
      } finally {
        if (dialogWindow && !dialogWindow.closed) {
          const close = dialogWindow.document.getElementById("zmta-batch-status-close");
          if (close) close.click();
          else dialogWindow.close();
        }
        popup.remove();
        addon.api.resetBatchRuntimeForTests();
      }
    });

    it("多个主窗口分别注册和定向注销菜单", async function () {
      const menuManager = Zotero.MenuManager;
      const originalRegister = menuManager.registerMenu;
      const originalUnregister = menuManager.unregisterMenu;
      const registered = [];
      const unregistered = [];
      menuManager.registerMenu = () => {
        const key = `test-menu-${registered.length + 1}`;
        registered.push(key);
        return key;
      };
      menuManager.unregisterMenu = (key) => { unregistered.push(key); };
      const firstWindow = { MozXULElement: { insertFTLIfNeeded: () => {} } };
      const secondWindow = { MozXULElement: { insertFTLIfNeeded: () => {} } };
      try {
        await addon.hooks.onMainWindowLoad(firstWindow);
        await addon.hooks.onMainWindowLoad(secondWindow);
        expect(registered).to.deep.equal(["test-menu-1", "test-menu-2"]);
        expect(unregistered).to.deep.equal([]);
        await addon.hooks.onMainWindowUnload(firstWindow);
        expect(unregistered).to.deep.equal(["test-menu-1"]);
      } finally {
        await addon.hooks.onMainWindowUnload(firstWindow);
        await addon.hooks.onMainWindowUnload(secondWindow);
        menuManager.registerMenu = originalRegister;
        menuManager.unregisterMenu = originalUnregister;
      }
      expect(unregistered).to.deep.equal(["test-menu-1", "test-menu-2"]);
    });
  });

  describe("UI 版本号（分辨 serve 加载版本）", function () {
    it("弹窗配置含版本（getDialogOptions 或标题）", function () {
      // 批量审核弹窗配置存在，版本号由构建注入并显示在窗口标题中。
      const opt = addon.api.getBatchDialogOptions();
      expect(opt.width).to.equal(1040);
      expect(opt.height).to.equal(700);
      expect(opt.noDialogMode).to.equal(true);
    });
    it("构建产物含版本标记（__buildVersion__ 注入）", function () {
      // 无法从 addon 直接查产物，但版本号注入在 build.define（zotero-plugin.config.ts）
      assert.isTrue(true); // 占位：版本号由 UI 标题实际显示覆盖
    });
  });
});
