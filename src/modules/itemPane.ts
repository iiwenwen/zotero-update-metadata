import { PLUGIN_ID } from "../config";
import { inspectBatchStatus, runBatchWorkflow } from "./batchRuntime";
import { normalizeDOI } from "./update/resolution";
import { getWorkflowActivity, subscribeWorkflowActivity } from "./workflowActivity";
import { isItemPaneShown, METADATA_PREFS_PANE_ID } from "./itemPanePreferences";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const MAIN_WINDOW_FTL = "zmta-mainWindow.ftl";
let localizedWindows = new WeakSet<object>();

/** 热升级复用旧主窗口时，同名link不会使DocumentL10n重新读资源。 */
export function refreshMainWindowLocalization(win: any): void {
  if (!win) return;
  try {
    win.MozXULElement?.insertFTLIfNeeded?.(MAIN_WINDOW_FTL);
    if (localizedWindows.has(win)) return;
    const l10n = win.document?.l10n;
    if (!l10n?.removeResourceIds || !l10n?.addResourceIds) return;
    // 仅重置本插件资源；不替换document.l10n或移除宿主／其他插件资源。
    l10n.removeResourceIds([MAIN_WINDOW_FTL]);
    l10n.addResourceIds([MAIN_WINDOW_FTL]);
    localizedWindows.add(win);
  } catch (error) {
    Zotero.debug(`[zmta] 主窗口本地化资源刷新失败：${error}`);
  }
}
type Eligibility = "none" | "multiple" | "unsupported" | "readonly" | "missing-source" | "ready" | "unavailable";
interface ItemRef { libraryID: number; itemID: number; itemKey: string }
interface PaneState {
  eligibility: Eligibility;
  itemRef: ItemRef | null;
  item?: any;
  sourceHint: "both" | "url" | "doi" | "none";
}

function itemRef(item: any): ItemRef | null {
  if (!Number.isInteger(item?.id) || item.id <= 0
    || !Number.isInteger(item?.libraryID) || item.libraryID <= 0 || !item?.key) return null;
  return { libraryID: item.libraryID, itemID: item.id, itemKey: String(item.key) };
}

function sameItem(first: ItemRef | null, second: ItemRef | null): boolean {
  return Boolean(first && second && first.libraryID === second.libraryID
    && first.itemID === second.itemID && first.itemKey === second.itemKey);
}

/** 只读宿主当前选择和权限，不探测Translator，不获取候选。 */
export function getItemPaneState(win: any, paneItem: any, editable: boolean, tabType: string): PaneState {
  const empty = (eligibility: Eligibility): PaneState => ({ eligibility, itemRef: null, sourceHint: "none" });
  try {
    if (!win || win.closed || tabType !== "library"
      || (win.Zotero_Tabs?.selectedType && win.Zotero_Tabs.selectedType !== "library")) return empty("unavailable");
    const pane = win.ZoteroPane;
    const items = pane?.getSelectedItems?.();
    if (!Array.isArray(items)) return empty("unavailable");
    if (items.length === 0) return empty("none");
    if (items.length !== 1) return empty("multiple");
    const item = items[0];
    if (item?.isRegularItem?.() !== true || item.isFeedItem === true
      || item.isNote?.() || item.isAttachment?.() || item.isAnnotation?.()) return empty("unsupported");
    const ref = itemRef(item);
    if (!sameItem(ref, itemRef(paneItem)) || item.deleted) return empty("unavailable");
    const url = String(item.getField?.("url") || "").trim();
    const doi = normalizeDOI(item.getField?.("DOI"));
    const sourceHint = url && doi ? "both" : url ? "url" : doi ? "doi" : "none";
    const writable = editable === true && pane.canEdit?.() === true && item.isEditable?.() === true;
    return { eligibility: !writable ? "readonly" : sourceHint === "none" ? "missing-source" : "ready", itemRef: ref, item, sourceHint };
  } catch {
    return empty("unavailable");
  }
}

interface PaneContext {
  ownerWindow: any;
  body: any;
  props: any;
  refresh?: () => Promise<void>;
  displayedRef: ItemRef | null;
  destroyed: boolean;
  view?: { status: any; source: any; review: any; root: any };
  removeListeners: (() => void)[];
}

const defaultActions = {
  runBatchWorkflow,
  inspectBatchStatus,
  getWorkflowActivity,
  subscribeWorkflowActivity,
  // @ts-expect-error - addon由bootstrap入口挂载
  getToolkit: () => addon.data.ztoolkit,
  openPreferences: () => Zotero.Utilities.Internal.openPreferences(METADATA_PREFS_PANE_ID),
};

/** 一个控制器对应一次插件生命周期；注入动作仅供无宿主机制验证。 */
export class ItemPaneController {
  private registeredKey: string | null = null;
  private windows = new Set<any>();
  private contexts = new Map<any, PaneContext>();
  private prefObserver: symbol | null = null;
  private unsubscribeActivity: (() => void) | null = null;

  constructor(private actions = defaultActions) {}

  register(win: any): void {
    if (!win) return;
    this.windows.add(win);
    refreshMainWindowLocalization(win);
    if (this.registeredKey) {
      // 新窗口的section可能早于插件onMainWindowLoad创建，补接已有容器。
      for (const context of this.contexts.values()) {
        if (context.ownerWindow === win) this.refresh(context);
      }
      return;
    }
    const manager = (Zotero as any).ItemPaneManager;
    if (!manager?.registerSection || !manager?.unregisterSection) return;
    try {
      // @ts-expect-error - addon由bootstrap入口挂载
      const icon = addon.data.rootURI + "content/icons/favicon.png";
      const key = manager.registerSection({
        paneID: "metadata-update",
        pluginID: PLUGIN_ID,
        header: { l10nID: "zmta-item-pane-header", icon },
        sidenav: { l10nID: "zmta-item-pane-sidenav", icon },
        onInit: (props: any) => this.initialize(props),
        onItemChange: (props: any) => {
          const context = this.contexts.get(props.body);
          if (!context || context.destroyed) return;
          context.props = props;
          this.updateVisibility(context);
        },
        onRender: (props: any) => this.render(props),
        onDestroy: (props: any) => this.destroy(this.contexts.get(props.body)),
      });
      if (!key) return;
      this.registeredKey = key;
      this.prefObserver = Zotero.Prefs.registerObserver(
        "extensions.zmta.showItemPane", () => this.refreshAll(), true,
      );
      this.unsubscribeActivity = this.actions.subscribeWorkflowActivity(() => this.refreshAll());
    } catch (error) {
      Zotero.debug(`[zmta] 条目侧栏注册失败，保留菜单入口：${error}`);
      this.shutdown();
    }
  }

  unloadWindow(win: any): void {
    this.windows.delete(win);
    for (const context of [...this.contexts.values()]) {
      if (context.ownerWindow === win) this.destroy(context);
    }
  }

  shutdown(): void {
    for (const context of [...this.contexts.values()]) this.destroy(context);
    if (this.prefObserver !== null) {
      try { Zotero.Prefs.unregisterObserver(this.prefObserver); } catch { /* 继续释放 */ }
      this.prefObserver = null;
    }
    try { this.unsubscribeActivity?.(); } catch { /* 继续释放 */ }
    this.unsubscribeActivity = null;
    const key = this.registeredKey;
    this.registeredKey = null;
    if (key) {
      try { (Zotero as any).ItemPaneManager?.unregisterSection?.(key); } catch { /* 宿主也会按pluginID释放 */ }
    }
    this.windows.clear();
  }

  private initialize(props: any): void {
    const ownerWindow = props.doc?.defaultView;
    if (!ownerWindow || ownerWindow.closed) return;
    this.destroy(this.contexts.get(props.body));
    this.contexts.set(props.body, {
      body: props.body, ownerWindow, props, refresh: props.refresh,
      displayedRef: null, destroyed: false, removeListeners: [],
    });
    // onInit不渲染；宿主赋予item后由onItemChange决定可见性。
  }

  private isAlive(context: PaneContext): boolean {
    return !context.destroyed && !context.ownerWindow?.closed
      && this.contexts.get(context.body) === context;
  }

  private updateVisibility(context: PaneContext): boolean {
    const state = getItemPaneState(context.ownerWindow, context.props.item,
      context.props.editable, context.props.tabType);
    const visible = this.isAlive(context) && this.windows.has(context.ownerWindow)
      && isItemPaneShown() && context.props.tabType === "library"
      && state.eligibility !== "none" && state.eligibility !== "multiple";
    context.props.setEnabled?.(visible);
    return visible;
  }

  private refresh(context: PaneContext): void {
    if (!this.isAlive(context)) return;
    // hidden容器的refresh不会恢复显示；必须先调用宿主setEnabled。
    if (!this.updateVisibility(context)) return;
    try {
      void Promise.resolve(context.refresh?.()).catch((error) => {
        Zotero.debug(`[zmta] 条目侧栏刷新失败：${error}`);
      });
    } catch (error) {
      Zotero.debug(`[zmta] 条目侧栏刷新失败：${error}`);
    }
  }

  private refreshAll(): void {
    for (const context of this.contexts.values()) this.refresh(context);
  }

  private localize(element: any, id: string): void {
    element.setAttribute("data-l10n-id", id);
  }

  private render(props: any): void {
    const context = this.contexts.get(props.body);
    if (!context || !this.isAlive(context)) return;
    context.props = props;
    if (!this.updateVisibility(context)) return;
    const state = getItemPaneState(context.ownerWindow, props.item, props.editable, props.tabType);
    context.displayedRef = state.itemRef;
    const view = context.view ?? this.createView(context, props.doc);
    view.source.hidden = state.itemRef === null;
    this.localize(view.source, `zmta-item-pane-source-${state.sourceHint}`);
    const busy = this.actions.getWorkflowActivity() !== "idle";
    this.localize(view.status, `zmta-item-pane-${state.eligibility === "ready" && busy ? "busy" : state.eligibility}`);
    view.review.disabled = busy || state.eligibility !== "ready";
    // 动态HTML节点与宿主header一同翻译，不能只测试data-l10n-id存在。
    const fragment = context.body.closest?.("collapsible-section") ?? context.body;
    try {
      void Promise.resolve(props.doc.l10n?.translateFragment?.(fragment)).catch((error) => {
        Zotero.debug(`[zmta] 条目侧栏本地化失败：${error}`);
      });
    } catch (error) {
      Zotero.debug(`[zmta] 条目侧栏本地化失败：${error}`);
    }
  }

  private createView(context: PaneContext, doc: any): NonNullable<PaneContext["view"]> {
    const create = (tag: string) => doc.createElementNS(HTML_NS, tag);
    const root = create("div");
    root.style.cssText = "display:flex;flex-direction:column;gap:8px;min-width:0;padding:8px;overflow-wrap:anywhere;";
    const source = create("p");
    const status = create("p");
    source.style.cssText = status.style.cssText = "margin:0;line-height:1.5;";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const review = create("button");
    const inspect = create("button");
    const settings = create("button");
    for (const [button, id, action] of [
      [review, "zmta-item-pane-review", () => this.review(context)],
      [inspect, "zmta-item-pane-inspect", () => this.inspect(context)],
      [settings, "zmta-item-pane-settings", () => this.settings(context)],
    ] as const) {
      button.type = "button";
      button.style.cssText = "font:inherit;white-space:normal;max-width:100%;min-width:0;padding:5px 8px;";
      this.localize(button, id);
      const listener = () => { void action(); };
      button.addEventListener("click", listener);
      context.removeListeners.push(() => button.removeEventListener("click", listener));
    }
    root.append(source, status, review, inspect, settings);
    context.body.append(root);
    context.view = { root, status, source, review };
    return context.view;
  }

  private async review(context: PaneContext): Promise<void> {
    if (!this.isAlive(context) || !isItemPaneShown()) return;
    const state = getItemPaneState(context.ownerWindow, context.props.item,
      context.props.editable, context.props.tabType);
    // 显示A后切到B但尚未重绘的点击也必须拒绝，不能用新选择替换旧闭包。
    if (state.eligibility !== "ready" || !sameItem(context.displayedRef, state.itemRef)
      || this.actions.getWorkflowActivity() !== "idle") {
      this.refresh(context);
      return;
    }
    const clickedRef = state.itemRef;
    try {
      await this.actions.runBatchWorkflow([state.item], this.actions.getToolkit(), context.ownerWindow);
    } catch (error) {
      Zotero.debug(`[zmta] 单条审核入口失败：${error}`);
      await this.showError(context, "zmta-item-pane-review-error");
    } finally {
      // 宿主onDestroy／窗口卸载会清空props；先判存活，再读取上下文。
      if (this.isAlive(context)) {
        const current = getItemPaneState(context.ownerWindow, context.props.item,
          context.props.editable, context.props.tabType);
        if (sameItem(clickedRef, current.itemRef)
          && sameItem(clickedRef, context.displayedRef)) this.refresh(context);
      }
    }
  }

  private async inspect(context: PaneContext): Promise<void> {
    if (!this.isAlive(context) || !isItemPaneShown()) return;
    try {
      // 空批次和损坏日志也由既有只读入口说明，不伪造历史或撤销当前项。
      await this.actions.inspectBatchStatus(context.ownerWindow, this.actions.getToolkit());
    } catch (error) {
      Zotero.debug(`[zmta] 查看批次入口失败：${error}`);
      await this.showError(context, "zmta-item-pane-inspect-error");
    }
  }

  private async settings(context: PaneContext): Promise<void> {
    if (!this.isAlive(context)) return;
    try { this.actions.openPreferences(); } catch (error) {
      Zotero.debug(`[zmta] 打开设置失败：${error}`);
      await this.showError(context, "zmta-item-pane-settings-error");
    }
  }

  private async showError(context: PaneContext, id: string): Promise<void> {
    let message = "Unable to open this action. Please try the item context menu or Zotero Settings.";
    try { message = await context.props.doc.l10n.formatValue(id) || message; } catch { /* 保留可理解反馈 */ }
    if (this.isAlive(context)) Zotero.alert(context.ownerWindow, "Zotero Metadata Update", message);
  }

  private destroy(context?: PaneContext): void {
    if (!context || context.destroyed) return;
    context.destroyed = true;
    for (const remove of context.removeListeners) remove();
    context.removeListeners = [];
    context.view?.root.remove();
    context.view = undefined;
    context.props = null;
    context.refresh = undefined;
    context.displayedRef = null;
    this.contexts.delete(context.body);
  }
}

const controller = new ItemPaneController();
export function registerItemPane(win: any): void { controller.register(win); }
export function unloadItemPaneWindow(win: any): void { controller.unloadWindow(win); }
export function unregisterItemPane(): void {
  controller.shutdown();
  localizedWindows = new WeakSet();
}
