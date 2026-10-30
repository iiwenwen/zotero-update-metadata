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

export function trackPluginDialog(dialog: any, rootID: PluginDialogRoot, cancel: () => void) {
  const captured = scope;
  const bornActive = isPluginDialogScopeActive(captured);
  const execution = rootID === "zmta-execution";
  let released = false;
  let cancelled = false;
  const release = () => { released = true; dialogs.delete(entry); };
  const entry = { execution, window: () => dialog.window, cancel: () => {
    if (released) return;
    cancelled = true;
    release();
    // 即使close不触发beforeunload（或已关窗），也明确结算/abort一次。
    try { cancel(); } finally { if (!dialog.window?.closed) dialog.window?.close?.(); }
  } };
  dialogs.add(entry);
  const active = () => bornActive && !released && (execution || isPluginDialogScopeActive(captured));
  const attach = () => {
    if (!active() || dialog.window?.closed) {
      entry.cancel();
      // shutdown可能发生于open内部、window赋值之前；返回后仍须关掉迟到的窗口。
      if (cancelled && !dialog.window?.closed) dialog.window?.close?.();
      return false;
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
