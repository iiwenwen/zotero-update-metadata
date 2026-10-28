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
import { normalizeDOI } from "./modules/update/resolution";
import { createZToolkit } from "./utils/ztoolkit";
import { refreshMainWindowLocalization, registerItemPane, unloadItemPaneWindow, unregisterItemPane } from "./modules/itemPane";
import { initializeMetadataPreferences, METADATA_PREFS_PANE_ID, resetMetadataPreferences, unloadMetadataPreferences } from "./modules/itemPanePreferences";
import { getWorkflowActivity } from "./modules/workflowActivity";

const MENU_ID = "zmtaUpdateMenu";
// 每个主窗口保留自己的注册键；窗口卸载不得注销其他窗口的菜单。
const registeredMenuKeys = new Map<any, string>();

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  // 注册设置界面（Zotero.PreferencePanes.register，Zotero 7+ 官方方式）
  await registerPrefsPane();
  await initializeBatchRuntimeState(Zotero.getMainWindow());

  // 主动遍历已存在的主窗口注册菜单（template 做法：主窗口已存在时 onMainWindowLoad 可能不触发）
  await Promise.all(Zotero.getMainWindows().map((win: any) => onMainWindowLoad(win)));

  // @ts-expect-error - addon 全局由 index.ts 设置
  addon.data.initialized = true;
}

async function onMainWindowLoad(win: any): Promise<void> {
  // @ts-expect-error - addon 全局由 index.ts 设置
  if (!addon.data.ztoolkit) addon.data.ztoolkit = createZToolkit();
  registerMenu(win);
  registerItemPane(win);
}

async function onMainWindowUnload(win: any): Promise<void> {
  unregisterMenu(win);
  unloadItemPaneWindow(win);
}

function onShutdown(): void {
  unloadMetadataPreferences();
  unregisterItemPane();
  unregisterMenu();
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
      } catch (error) {
        Zotero.debug(`[zmta] 恢复设置失败：${error}`);
        Zotero.alert(data.window, "Zotero 元数据更新", "无法恢复默认设置，请重新打开设置后再试。");
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
      pluginID: "zmta-update-metadata@local",
      id: METADATA_PREFS_PANE_ID,
      src: rootURI + "content/preferences.xhtml",
      label: String((Zotero as any).locale || "zh-CN").startsWith("zh") ? "Zotero 元数据更新" : "Zotero Metadata Update",
    });
    prefsPaneRegistered = true;
    Zotero.debug("[zmta] 设置界面已注册");
  } catch (e) {
    Zotero.debug(`[zmta] 设置界面注册失败: ${e}`);
  }
}

// 菜单注册（当前手写 Zotero 原生 MenuManager；后续按使用源改用 toolkit MenuManager）
// 菜单项用 l10nID（Zotero 原生 MenuManager 只认 l10nID 不认 label），需 insertFTLIfNeeded + ftl 文件
function registerMenu(mainWin: any): void {
  if (!mainWin) {
    Zotero.debug("[zmta] 无主窗口，跳过菜单注册");
    return;
  }
  // 同一主窗口热升级后刷新插件资源，已有同名link本身不会刷新缓存。
  refreshMainWindowLocalization(mainWin);
  const menuManager = (Zotero as any).MenuManager;
  if (!menuManager?.registerMenu) {
    Zotero.debug("[zmta] MenuManager 不可用，跳过菜单注册");
    return;
  }
  // 只注销当前窗口的旧注册（幂等），不影响其他主窗口。
  unregisterMenu(mainWin);
  try {
    const registeredMenuKey = menuManager.registerMenu({
      menuID: MENU_ID,
      pluginID: "zmta-update-metadata@local",
      target: "main/library/item",
      menus: buildBatchMenuEntries(mainWin),
    });
    if (registeredMenuKey) registeredMenuKeys.set(mainWin, registeredMenuKey);
    Zotero.debug("[zmta] 菜单已注册 (MenuManager)");
  } catch (e) {
    Zotero.debug(`[zmta] 菜单注册失败: ${e}`);
  }
}

export function resolveBatchMenuItems(context: any, mainWin: any): any[] {
  return context?.items?.length
    ? context.items
    : (mainWin?.ZoteroPane?.getSelectedItems?.() ?? []);
}

function isRegularItem(item: any): boolean {
  if (!item) return false;
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

export function canReviewBatchItems(items: any[]): boolean {
  return items.length > 0
    && items.length <= MAX_BATCH_ITEMS
    && items.every(isRegularItem);
}

export function canUseDOIRoute(items: any[]): boolean {
  if (items.length !== 1 || !isRegularItem(items[0])) return false;
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
      l10nID: "zmta-douban-metadata-menu-label",
      onShowing: (_event: any, context: any = {}) => {
        const items = resolveBatchMenuItems(context, mainWin);
        const capabilities = getBatchRuntimeCapabilities();
        setMenuEnabled(
          context,
          canReviewBatchItems(items)
            || (capabilities.loaded
              && !capabilities.journalError
              && (capabilities.hasRetryableItems
                || capabilities.hasUndoableBatch
                || capabilities.hasInspectableBatches)),
        );
      },
      menus: [
        {
          menuType: "menuitem",
          l10nID: "zmta-review-update-menu-label",
          onShowing: (_event: any, context: any = {}) => {
            setMenuEnabled(context, getWorkflowActivity() === "idle"
              && canReviewBatchItems(resolveBatchMenuItems(context, mainWin)));
          },
          onCommand: (_event: any, context: any = {}) => {
            const items = resolveBatchMenuItems(context, mainWin);
            if (!canReviewBatchItems(items)) {
              Zotero.alert(
                mainWin,
                "Zotero 元数据更新",
                `请选择 1–${MAX_BATCH_ITEMS} 个普通书目条目`,
              );
              return;
            }
            // @ts-expect-error - addon 全局
            void runBatchWorkflow(items, addon.data.ztoolkit, mainWin);
          },
        },
        {
          menuType: "menuitem",
          l10nID: "zmta-use-doi-menu-label",
          onShowing: (_event: any, context: any = {}) => {
            setMenuEnabled(context, getWorkflowActivity() === "idle"
              && canUseDOIRoute(resolveBatchMenuItems(context, mainWin)));
          },
          onCommand: (_event: any, context: any = {}) => {
            const items = resolveBatchMenuItems(context, mainWin);
            if (!canUseDOIRoute(items)) {
              Zotero.alert(mainWin, "Zotero 元数据更新", "请选择一个具有有效 DOI 的普通书目条目");
              return;
            }
            // 用户主动换源：只生成 DOI Search 候选，不保留或混合原 Web 候选。
            // @ts-expect-error - addon 全局
            void runDOIBatchWorkflow(items, addon.data.ztoolkit, mainWin);
          },
        },
        {
          menuType: "menuitem",
          l10nID: "zmta-inspect-batches-menu-label",
          onShowing: (_event: any, context: any = {}) => {
            const capabilities = getBatchRuntimeCapabilities();
            setMenuEnabled(
              context,
              capabilities.loaded
                && !capabilities.journalError
                && capabilities.hasInspectableBatches,
            );
          },
          onCommand: () => { void inspectBatchStatus(mainWin, addon.data.ztoolkit); },
        },
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
          onCommand: () => { void retryLastFailedBatch(mainWin, addon.data.ztoolkit); },
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
          onCommand: () => { void rollbackLatestBatch(mainWin); },
        },
      ],
    },
  ];
}

function unregisterMenu(mainWin?: any): void {
  const menuManager = (Zotero as any).MenuManager;
  const entries = mainWin
    ? [[mainWin, registeredMenuKeys.get(mainWin)] as const]
    : [...registeredMenuKeys.entries()];
  for (const [win, registeredMenuKey] of entries) {
    try {
      if (registeredMenuKey) menuManager?.unregisterMenu?.(registeredMenuKey);
    } catch {
      /* 忽略 */
    } finally {
      registeredMenuKeys.delete(win);
    }
  }
}

export default {
  onStartup,
  onMainWindowLoad,
  onMainWindowUnload,
  onShutdown,
  onPrefsEvent,
};
