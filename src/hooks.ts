import { PLUGIN_ID, PLUGIN_NAME } from "./config";
// 生命周期 hooks（参考 template src/hooks.ts）
// 注意：toolkit 5.2.0 有 MenuManager（见官方文档 windingwind.github.io/zotero-plugin-toolkit/）。
// 当前菜单用手写 Zotero 原生 MenuManager，后续应按使用源改用 toolkit MenuManager（待修正）。
import {
  getBatchRuntimeCapabilities,
  initializeBatchRuntimeState,
  inspectBatchStatus,
  rollbackLatestBatch,
  retryLastFailedBatch,
  runBatchWorkflow,
  runDOIBatchWorkflow,
} from "./modules/batchRuntime";
import { MAX_BATCH_ITEMS } from "./modules/batchTypes";
import { normalizeDOI, normalizeHTTPURL } from "./modules/update/resolution";
import { createZToolkit } from "./utils/ztoolkit";
import { refreshMainWindowLocalization, registerItemPane, unloadItemPaneWindow, unregisterItemPane } from "./modules/itemPane";
import { initializeMetadataPreferences, METADATA_PREFS_PANE_ID, resetMetadataPreferences, unloadMetadataPreferences } from "./modules/itemPanePreferences";
import { getWorkflowActivity } from "./modules/workflowActivity";
import { ftlMessageId } from "./modules/dialogCopy";
import { localized } from "./utils/locale";
import { beginPluginDialogScope, closeLegacyPluginDialogs, isPluginDialogScopeActive, restorePluginWindowFocus, shutdownPluginDialogs } from "./modules/dialogLifecycle";

const MENU_ID = "zmtaUpdateMenu";
// Zotero MenuManager 的注册为插件级全局资源，窗口关闭不能注销。
const registeredMenuKeys = new Map<string, string>();
const menuIconStyles = new Map<any, any>();

async function onStartup() {
  const dialogScope = beginPluginDialogScope();
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);
  if (!isPluginDialogScopeActive(dialogScope)) return;
  const legacyClosed = closeLegacyPluginDialogs();

  // 注册设置界面（Zotero.PreferencePanes.register，Zotero 7+ 官方方式）
  await registerPrefsPane();
  if (!isPluginDialogScopeActive(dialogScope)) return;
  await initializeBatchRuntimeState(Zotero.getMainWindow());
  if (!isPluginDialogScopeActive(dialogScope)) return;

  // 主动遍历已存在的主窗口注册菜单（template 做法：主窗口已存在时 onMainWindowLoad 可能不触发）
  await Promise.all(Zotero.getMainWindows().map((win: any) => onMainWindowLoad(win)));

  // @ts-expect-error - addon 全局由 index.ts 设置
  addon.data.initialized = isPluginDialogScopeActive(dialogScope);
  if (legacyClosed > 0) restorePluginWindowFocus(Zotero.getMainWindow(), dialogScope);
}

async function onMainWindowLoad(win: any): Promise<void> {
  if (!isPluginDialogScopeActive()) return;
  // @ts-expect-error - addon 全局由 index.ts 设置
  if (!addon.data.ztoolkit) addon.data.ztoolkit = createZToolkit();
  registerMenu(win);
  registerItemPane(win);
}

async function onMainWindowUnload(win: any): Promise<void> {
  removeMenuIconStyle(win);
  unloadItemPaneWindow(win);
}

function onShutdown(): void {
  shutdownPluginDialogs();
  unloadMetadataPreferences();
  unregisterItemPane();
  unregisterMenu();
  for (const win of menuIconStyles.keys()) removeMenuIconStyle(win);
  // @ts-expect-error - addon 全局
  addon.data.ztoolkit?.unregisterAll?.();
}

// 偏好设置界面事件（template onPrefsEvent）
function onPrefsEvent(type: string, data: { [key: string]: any }): void {
  switch (type) {
    case "load":
      // 持久化仍由宿主preference绑定，严格同步非法值的显示。
      initializeMetadataPreferences(data.window);
      break;
    case "reset":
      try {
        resetMetadataPreferences();
        data.window?.document?.getElementById("zmta-pref-status")?.setAttribute("data-l10n-id", ftlMessageId("pref-defaults-restored"));
      } catch (error) {
        Zotero.debug(`[zmta] 恢复设置失败：${error}`);
        Zotero.alert(data.window, localized(PLUGIN_NAME.zh, PLUGIN_NAME.en), "没能恢复默认设置，请重新打开设置后再试。");
      }
      break;
    default:
      return;
  }
}

// 注册设置界面（Zotero.PreferencePanes.register，Zotero 7+ 官方方式）
let prefsPaneRegistered = false;
async function registerPrefsPane(): Promise<void> {
  if (prefsPaneRegistered) return;
  try {
    // src 用 rootURI + content/preferences.xhtml（旧项目验证过的路径，不用 chrome://）
    // @ts-expect-error - addon 全局
    const rootURI = addon.data.rootURI;
    if (!rootURI) {
      Zotero.debug("[zmta] 设置界面注册跳过：无 rootURI");
      return;
    }
    await Zotero.PreferencePanes.register({
      pluginID: PLUGIN_ID,
      id: METADATA_PREFS_PANE_ID,
      src: rootURI + "content/preferences.xhtml",
      label: localized(PLUGIN_NAME.zh, PLUGIN_NAME.en),
    });
    prefsPaneRegistered = true;
    Zotero.debug("[zmta] 设置界面已注册");
  } catch (e) {
    Zotero.debug(`[zmta] 设置界面注册失败: ${e}`);
  }
}

// 菜单注册（当前手写 Zotero 原生 MenuManager；后续按使用源改用 toolkit MenuManager）
// 菜单项用 l10nID（Zotero 原生 MenuManager 只认 l10nID 不认 label），需 insertFTLIfNeeded + ftl 文件
/** Zotero macOS 的条目右键样式隐藏图标，仅恢复本插件父菜单。 */
export function installMenuIconStyle(win: any): void {
  if (menuIconStyles.has(win) || !win?.document?.createElementNS) return;
  const style = win.document.createElementNS("http://www.w3.org/1999/xhtml", "style");
  style.id = "zmta-menu-brand-icon-style";
  style.textContent = `
    #zotero-itemmenu menu[data-l10n-id="zmta-douban-metadata-menu-label"] {
      list-style-image: var(--custom-menu-icon-light) !important;
    }
    #zotero-itemmenu menu[data-l10n-id="zmta-douban-metadata-menu-label"] > .menu-icon {
      display: flex !important;
      width: 16px;
      height: 16px;
    }
  `;
  win.document.documentElement.appendChild(style);
  menuIconStyles.set(win, style);
}

export function removeMenuIconStyle(win: any): void {
  menuIconStyles.get(win)?.remove();
  menuIconStyles.delete(win);
}

function registerMenu(mainWin: any): void {
  if (!mainWin) {
    Zotero.debug("[zmta] 无主窗口，跳过菜单注册");
    return;
  }
  // 同一主窗口热升级后刷新插件资源，已有同名link本身不会刷新缓存。
  refreshMainWindowLocalization(mainWin);
  installMenuIconStyle(mainWin);
  const menuManager = (Zotero as any).MenuManager;
  if (!menuManager?.registerMenu) {
    Zotero.debug("[zmta] MenuManager 不可用，跳过菜单注册");
    return;
  }
  const registrations = [
    { menuID: MENU_ID, pluginID: PLUGIN_ID, target: "main/library/item", menus: buildBatchMenuEntries(mainWin) },
    { menuID: "zmtaBatchStatusTools", pluginID: PLUGIN_ID, target: "main/menubar/tools", menus: buildToolsMenuEntries(mainWin) },
  ];
  for (const registration of registrations) {
    if (registeredMenuKeys.has(registration.menuID)) continue;
    try {
      const key = menuManager.registerMenu(registration);
      if (key) registeredMenuKeys.set(registration.menuID, key);
    } catch (error) {
      Zotero.debug(`[zmta] 菜单注册失败 (${registration.target})：${error}`);
    }
  }
}

function menuWindow(context: any, fallback: any): any {
  return context?.menuElem?.ownerGlobal || fallback;
}

export function resolveBatchMenuItems(context: any, mainWin: any): any[] {
  return context?.items?.length
    ? context.items
    : (mainWin?.ZoteroPane?.getSelectedItems?.() ?? []);
}

function isRegularItem(item: any): boolean {
  if (!item || item.deleted || item.isFeedItem === true) return false;
  try {
    if (typeof item.isRegularItem === "function") return Boolean(item.isRegularItem());
    return !item.isNote?.()
      && !item.isAttachment?.()
      && !item.isAnnotation?.()
      && !item.isFeedItem?.();
  } catch {
    return false;
  }
}

export function canReviewBatchItems(items: any[], mainWin?: any): boolean {
  if (items.length === 0 || items.length > MAX_BATCH_ITEMS || !items.every(isRegularItem)) return false;
  try {
    if (mainWin?.ZoteroPane?.canEdit?.() === false) return false;
    if (items.length !== 1) return items.some((item) => item.isEditable?.() !== false);
    const item = items[0];
    if (item.isEditable?.() === false) return false;
    return Boolean(normalizeHTTPURL(item.getField?.("url")) || normalizeDOI(item.getField?.("DOI")));
  } catch { return false; }
}

export function canUseDOIRoute(items: any[], mainWin?: any): boolean {
  if (items.length !== 1 || !canReviewBatchItems(items, mainWin)) return false;
  try {
    return normalizeDOI(items[0].getField?.("DOI")) !== null;
  } catch {
    return false;
  }
}

function setMenuEnabled(context: any, enabled: boolean): void {
  context?.setEnabled?.(enabled);
  const element = context?.menuElem;
  if (!element) return;
  if (enabled) element.removeAttribute?.("disabled");
  else element.setAttribute?.("disabled", "true");
}

/** 注册函数与测试共用同一份描述，避免 l10nID/handler 测试成为占位断言。 */
export function buildBatchMenuEntries(mainWin: any): any[] {
  return [
    {
      menuType: "submenu",
      // @ts-expect-error - addon由bootstrap入口挂载
      icon: addon.data.rootURI + "content/icons/favicon-16.svg",
      l10nID: "zmta-douban-metadata-menu-label",
      onShowing: (_event: any, context: any = {}) => {
        // XUL 的 image 属性会传给真实 .menu-icon，兼容原生图标加载。
        // @ts-expect-error - addon由bootstrap入口挂载
        context.menuElem?.setAttribute?.("image", addon.data.rootURI + "content/icons/favicon-16.svg");
        const win = menuWindow(context, mainWin);
        const items = resolveBatchMenuItems(context, win);
        setMenuEnabled(context, canReviewBatchItems(items, win));
      },
      menus: [
        {
          menuType: "menuitem",
          l10nID: "zmta-review-update-menu-label",
          onShowing: (_event: any, context: any = {}) => {
            const win = menuWindow(context, mainWin);
            setMenuEnabled(context, getWorkflowActivity() === "idle"
              && canReviewBatchItems(resolveBatchMenuItems(context, win), win));
          },
          onCommand: (_event: any, context: any = {}) => {
            const win = menuWindow(context, mainWin);
            const items = resolveBatchMenuItems(context, win);
            if (!canReviewBatchItems(items, win)) {
              Zotero.alert(
                win,
                localized(PLUGIN_NAME.zh, PLUGIN_NAME.en),
                localized(
                  `请选择 1–${MAX_BATCH_ITEMS} 个条目；单条审核需要可编辑的条目和有效的网址或 DOI。`,
                  `Select 1–${MAX_BATCH_ITEMS} regular bibliographic items. A single item must be editable and have a valid URL or DOI.`,
                ),
              );
              return;
            }
            // @ts-expect-error - addon 全局
            void runBatchWorkflow(items, addon.data.ztoolkit, win);
          },
        },
        {
          menuType: "menuitem",
          l10nID: "zmta-use-doi-menu-label",
          onShowing: (_event: any, context: any = {}) => {
            const win = menuWindow(context, mainWin);
            setMenuEnabled(context, getWorkflowActivity() === "idle"
              && canUseDOIRoute(resolveBatchMenuItems(context, win), win));
          },
          onCommand: (_event: any, context: any = {}) => {
            const win = menuWindow(context, mainWin);
            const items = resolveBatchMenuItems(context, win);
            if (!canUseDOIRoute(items, win)) {
              Zotero.alert(win, localized(PLUGIN_NAME.zh, PLUGIN_NAME.en), localized(
                "请选择一个可编辑、并填写了有效 DOI 的条目。",
                "Select one editable bibliographic item with a valid DOI.",
              ));
              return;
            }
            // 用户主动换源：只生成 DOI Search 候选，不保留或混合原 Web 候选。
            // @ts-expect-error - addon 全局
            void runDOIBatchWorkflow(items, addon.data.ztoolkit, win);
          },
        },
      ],
    },
  ];
}

function buildTaskMenuEntries(mainWin: any): any[] {
  return [
        {
          menuType: "menuitem",
          l10nID: "zmta-retry-failed-menu-label",
          onShowing: (_event: any, context: any = {}) => {
            const capabilities = getBatchRuntimeCapabilities();
            setMenuEnabled(
              context,
              getWorkflowActivity() === "idle"
                && capabilities.loaded
                && !capabilities.journalError
                && capabilities.hasRetryableItems,
            );
          },
          onCommand: (_event: any, context: any = {}) => { Zotero.debug("[zmta-ui] tools:retry command"); void retryLastFailedBatch(menuWindow(context, mainWin), addon.data.ztoolkit); },
        },
        {
          menuType: "menuitem",
          l10nID: "zmta-undo-batch-menu-label",
          onShowing: (_event: any, context: any = {}) => {
            const capabilities = getBatchRuntimeCapabilities();
            setMenuEnabled(
              context,
              getWorkflowActivity() === "idle"
                && capabilities.loaded
                && !capabilities.journalError
                && capabilities.incompleteCount === 0
                && capabilities.hasUndoableBatch,
            );
          },
          onCommand: (_event: any, context: any = {}) => { Zotero.debug("[zmta-ui] tools:undo command"); void rollbackLatestBatch(menuWindow(context, mainWin), addon.data.ztoolkit); },
        },
  ];
}

/** 批次状态是全局只读入口，空记录和日志错误也应可见。 */
export function buildToolsMenuEntries(mainWin: any): any[] {
  return [{ menuType: "submenu", l10nID: "zmta-douban-metadata-menu-label",
    // @ts-expect-error - addon由bootstrap入口挂载
    icon: addon.data.rootURI + "content/icons/favicon-16.svg",
    menus: [{ menuType: "menuitem", l10nID: "zmta-inspect-batches-menu-label",
      // @ts-expect-error - addon由bootstrap入口挂载
      onCommand: (_event: any, context: any = {}) => { Zotero.debug("[zmta-ui] tools:history command"); void inspectBatchStatus(menuWindow(context, mainWin), addon.data.ztoolkit); },
    }, ...buildTaskMenuEntries(mainWin)] }];
}

function unregisterMenu(): void {
  const menuManager = (Zotero as any).MenuManager;
  for (const key of registeredMenuKeys.values()) {
    try { menuManager?.unregisterMenu?.(key); } catch { /* 继续释放其他菜单 */ }
  }
  registeredMenuKeys.clear();
}

export default {
  onStartup,
  onMainWindowLoad,
  onMainWindowUnload,
  onShutdown,
  onPrefsEvent,
};
