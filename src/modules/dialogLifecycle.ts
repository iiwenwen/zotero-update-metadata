import { PLUGIN_ID } from "../config";

// 只登记本插件的六种DialogHelper窗口，不替代Toolkit的布局/事件接口。
const ROOTS = Object.freeze({
  "zmta-batch-review": ["zmta-batch-confirm", "zmta-batch-cancel"],
  "zmta-batch-preflight": ["zmta-preflight-title", "zmta-preflight-cancel"],
  "zmta-batch-status": ["zmta-batch-status-close"],
  "zmta-undo-scope": ["zmta-undo-confirm", "zmta-undo-cancel"],
  "zmta-workflow-result": ["zmta-result-done", "zmta-result-records"],
  "zmta-execution": ["zmta-execution-count", "zmta-execution-stage"],
});
export type PluginDialogRoot = keyof typeof ROOTS;
interface DialogScope { active: boolean }
let scope: DialogScope = { active: true };
const dialogs = new Set<{ execution: boolean; window(): any; cancel(): void }>();
const OWNER = "__zmtaDialogOwner";
/** unload 之后最多再跨几轮主线程确认窗口消失；有界，避免窗口活着时无限排队。 */
const MAX_RECHECKS = 3;

export function getPluginDialogScope(): DialogScope { return scope; }
export function isPluginDialogScopeActive(captured = scope): boolean { return captured.active && captured === scope; }
export function beginPluginDialogScope(): DialogScope {
  if (!scope.active) scope = { active: true };
  return scope;
}

/** 只恢复明确的原窗口；其余自有界面（尤其执行/子记录）尚开时不抢焦点。 */
export function restorePluginWindowFocus(win: any, captured = scope): boolean {
  if (!win || !isPluginDialogScopeActive(captured)) return false;
  try {
    if (win.closed || typeof win.focus !== "function") return false;
    if ([...dialogs].some(entry => {
      const other = entry.window();
      return other !== win && (!other || !other.closed);
    })) return false;
    win.focus();
    return true;
  } catch (error) {
    Zotero.debug(`[zmta-ui] return focus unavailable: ${error}`);
    return false;
  }
}

/** 先撤销旧UI回调权限，再结算取消；不重置业务忙碌锁，不中断已授权执行。 */
export function shutdownPluginDialogs(): void {
  scope.active = false;
  for (const dialog of [...dialogs]) {
    if (dialog.execution) continue;
    try { dialog.cancel(); } catch (error) { Zotero.debug(`[zmta-ui] dialog cleanup: ${error}`); }
  }
}

/** 主线程下一轮执行；窗口销毁可能晚于 unload 派发，必须跨任务复查。 */
function scheduleMainThread(run: () => void): void {
  try {
    if (typeof Services !== "undefined" && Services?.tm?.dispatchToMainThread) {
      Services.tm.dispatchToMainThread(run);
      return;
    }
  } catch { /* 降级到定时器 */ }
  try {
    if (typeof setTimeout === "function") { setTimeout(run, 0); return; }
  } catch { /* 降级为同步执行 */ }
  // 两者都不可用时只能同步执行：与派发 unload 同 tick，看不到新状态，等于没有兜底。
  // Zotero 作用域里 Services 与 setTimeout 都在，这里只保证不抛错并留下痕迹。
  Zotero.debug("[zmta-ui] 无主线程调度器，窗口复查退化为同步执行");
  run();
}

export function trackPluginDialog(dialog: any, rootID: PluginDialogRoot, cancel: () => void) {
  const captured = scope;
  const bornActive = isPluginDialogScopeActive(captured);
  const execution = rootID === "zmta-execution";
  let released = false;
  let cancelled = false;
  let guarded = false;
  // 死窗口读属性会抛错，一律按已消失处理。
  const windowGone = () => {
    try { return !dialog.window || dialog.window.closed === true; } catch { return true; }
  };
  const release = () => {
    released = true;
    dialogs.delete(entry);
    // 已结算的窗口不再需要兜底监听；窗口可能已销毁，移除失败不影响释放。
    if (guarded) {
      guarded = false;
      try { dialog.window?.removeEventListener?.("unload", settleOnWindowGone, false); }
      catch (error) { Zotero.debug(`[zmta-ui] dialog guard release: ${error}`); }
    }
  };
  // 结算只做一次：取消回调抛错也不能让释放失效。
  const settle = () => {
    if (released) return;
    cancelled = true;
    release();
    try { cancel(); } catch (error) { Zotero.debug(`[zmta-ui] dialog settle: ${error}`); }
  };
  const entry = { execution, window: () => dialog.window, cancel: () => {
    if (released) return;
    // 即使close不触发beforeunload（或已关窗），也明确结算/abort一次。
    try { settle(); } finally { if (!windowGone()) dialog.window?.close?.(); }
  } };
  dialogs.add(entry);
  const active = () => bornActive && !released && (execution || isPluginDialogScopeActive(captured));
  // 窗口真的关掉才结算：about:blank 初始化阶段也会派发 unload，那不是窗口消失。
  // 宿主直接销毁窗口时 unload 先于关闭标记，所以关不掉就排主线程复查；销毁可能跨多轮，复查有界重试。
  let rechecks = 0;
  const recheck = () => {
    if (released) return;
    if (windowGone()) { settle(); return; }
    if (rechecks >= MAX_RECHECKS) { rechecks = 0; return; } // 链条结束，允许之后的 unload 重新开链
    rechecks += 1;
    scheduleMainThread(recheck);
  };
  const settleOnWindowGone = () => {
    if (released || rechecks > 0) return; // 已在复查链上，不重复排队
    if (windowGone()) { settle(); return; }
    recheck();
  };
  const attach = () => {
    // 依赖 Dialog.open() 同步赋值 window；若将来改为异步，这里会把"尚未就绪"误判为已消失。
    if (!active() || windowGone()) {
      entry.cancel();
      // shutdown可能发生于open内部、window赋值之前；返回后仍须关掉迟到的窗口。
      if (cancelled && !windowGone()) dialog.window?.close?.();
      return false;
    }
    if (!guarded) {
      guarded = true;
      try { dialog.window?.addEventListener?.("unload", settleOnWindowGone, false); }
      catch (error) { Zotero.debug(`[zmta-ui] dialog guard: ${error}`); }
    }
    if (dialog.dialogData) dialog.dialogData[OWNER] = { pluginID: PLUGIN_ID, rootID, execution, retireScope: shutdownPluginDialogs };
    const doc = dialog.window?.document;
    doc?.documentElement?.setAttribute?.("data-zmta-dialog-owner", PLUGIN_ID);
    return true;
  };
  return { active, release, attach, cancel: entry.cancel };
}

/** 首次升级兼容：只认唯一根节点+该页固有控件，绝不按标题/about:blank关闭。 */
export function closeLegacyPluginDialogs(windows?: Iterable<any>): number {
  if (!windows) {
    const found: any[] = [];
    if (typeof Services !== "undefined") {
      const enumerator = Services.wm.getEnumerator(null);
      while (enumerator.hasMoreElements()) found.push(enumerator.getNext());
    }
    windows = found;
  }
  let closed = 0;
  for (const win of windows) {
    try {
      if (win.closed) continue;
      const doc = win.document;
      const data = win.arguments?.[0];
      const owner = data?.[OWNER];
      if (owner && owner.pluginID !== PLUGIN_ID) continue;
      const rootID: PluginDialogRoot | undefined = owner && Object.hasOwn(ROOTS, owner.rootID)
        ? owner.rootID : (Object.keys(ROOTS) as PluginDialogRoot[]).find(id => doc?.getElementById?.(id)
          && ROOTS[id].every(child => doc.getElementById(child)));
      if (!rootID || rootID === "zmta-execution") continue;
      if (owner && (owner.pluginID !== PLUGIN_ID || owner.rootID !== rootID)) continue;
      if (owner?.execution) continue;
      if (owner?.retireScope) owner.retireScope();
      // 旧版回调本就幂等，并使用取消/false/null语义；不调用任何确认按钮。
      try { data?.beforeUnloadCallback?.(); } finally { if (!win.closed) win.close(); }
      closed += 1;
    } catch (error) { Zotero.debug(`[zmta-ui] legacy dialog cleanup: ${error}`); }
  }
  return closed;
}
