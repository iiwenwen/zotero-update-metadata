import { isPluginDialogScopeActive, trackPluginDialog } from "./dialogLifecycle";
import { DIALOG_STYLES, markDialogWindow } from "./dialogStyles";
import { fillCopy, type DialogCopy, type MessageId } from "./dialogCopy";
import type { BatchJournalRecord, BatchRollbackResult, BatchRunResult, BatchItemResult } from "./batchTypes";
import { metadataFieldLabel, metadataRecordTime } from "./metadataDisplay";

export interface ExecutionProgress { completed: number; total: number; title?: string; stageId?: MessageId }
export interface ExecutionDialog { update(state: ExecutionProgress): void; close(): void }

const copy = (text: string, tag = "p"): any => ({ tag, namespace: "html", properties: { textContent: text } });
const STYLE = DIALOG_STYLES + `
.zmta-workflow { padding:20px; color:CanvasText; background:Canvas; line-height:1.6; min-width:0; }
.zmta-workflow p,.zmta-workflow h2 { margin:0 0 12px; overflow-wrap:anywhere; }
.zmta-workflow h2 { font-size:1.3em; }
.zmta-workflow > details { padding:12px 0; border-bottom:1px solid GrayText; }
`;
function root(id: string, children: any[]): any {
  return { tag: "div", namespace: "html", id, classList: ["zmta-workflow"], styles: { gridColumn: "1 / -1" }, children: [...children, { tag: "style", namespace: "html", properties: { textContent: STYLE } }] };
}

/** 开窗时一次性解析的静态文案。 */
export const EXECUTION_COPY_IDS: readonly MessageId[] = Object.freeze([
  "dlg-exec-title-update", "dlg-exec-title-undo", "dlg-exec-preparing", "dlg-exec-processing",
  "dlg-exec-close-blocked", "dlg-exec-note", "dlg-exec-meter-update", "dlg-exec-meter-undo",
  "dlg-exec-stage-attachment", "dlg-exec-stage-note", "dlg-exec-stage-field", "dlg-exec-stage-item-done",
  "dlg-exec-progress", "dlg-exec-open-failed",
]);

/** 过程显示只观察执行，不拥有取消写入的权限。 */
export function openExecutionDialog(toolkit: any, total: number, copyMessages: DialogCopy, undo = false): ExecutionDialog {
  if (!isPluginDialogScopeActive()) return { update() {}, close() {} };
  if (!toolkit?.Dialog) throw new Error(copyMessages.text("dlg-exec-open-failed"));
  const dialog = new toolkit.Dialog(1, 1);
  let closed = false;
  const owned = trackPluginDialog(dialog, "zmta-execution", () => {});
  let latest: ExecutionProgress = { completed: 0, total, stageId: "dlg-exec-preparing" };
  const render = () => {
    try {
      const doc = dialog.window?.document;
      const meter = doc?.getElementById("zmta-execution-meter");
      if (meter) { meter.max = Math.max(1, latest.total); meter.value = Math.min(latest.total, Math.max(0, latest.completed)); }
      const title = doc?.getElementById("zmta-execution-title");
      const stage = doc?.getElementById("zmta-execution-stage");
      fillCopy(doc, copyMessages, [{ elementID: "zmta-execution-count", id: "dlg-exec-progress", args: { done: latest.completed, total: latest.total } }]);
      if (title) title.textContent = latest.title || copyMessages.text("dlg-exec-preparing");
      if (stage) stage.textContent = copyMessages.text(latest.stageId || "dlg-exec-processing");
    } catch { /* 窗口失效不能改变已授权的执行 */ }
  };
  const preventClose = (event: any) => {
    if (closed || (event.type === "keydown" && event.key !== "Escape")) return;
    event.preventDefault();
    latest = { ...latest, stageId: "dlg-exec-close-blocked" };
    render();
  };
  dialog.addCell(0, 0, root("zmta-execution", [
    copy(copyMessages.text(undo ? "dlg-exec-title-undo" : "dlg-exec-title-update"), "h2"),
    { ...copy(""), id: "zmta-execution-count", attributes: { "aria-live": "polite" } },
    { tag: "progress", namespace: "html", id: "zmta-execution-meter", attributes: { "aria-label": copyMessages.text(undo ? "dlg-exec-meter-undo" : "dlg-exec-meter-update") }, properties: { max: Math.max(1, total), value: 0 } },
    { ...copy(copyMessages.text("dlg-exec-preparing")), id: "zmta-execution-title" },
    { ...copy(copyMessages.text("dlg-exec-preparing")), id: "zmta-execution-stage", attributes: { role: "status" } },
    copy(copyMessages.text("dlg-exec-note")),
  ]), true);
  dialog.setDialogData({ loadCallback: () => {
    if (!owned.attach()) return;
    markDialogWindow(dialog);
    dialog.window?.addEventListener?.("close", preventClose, true);
    dialog.window?.addEventListener?.("keydown", preventClose, true);
    render();
  }, beforeUnloadCallback: () => { closed = true; owned.release(); dialog.window?.removeEventListener?.("close", preventClose, true); dialog.window?.removeEventListener?.("keydown", preventClose, true); } });
  try {
    dialog.open(copyMessages.text(undo ? "dlg-exec-title-undo" : "dlg-exec-title-update"), { width: 520, height: 300, centerscreen: true, resizable: true, noDialogMode: true });
    owned.attach();
  } catch (error) {
    // 同其他自有窗：open 抛错时结算，避免残留占位条目影响聚焦恢复。
    owned.cancel();
    throw error;
  }
  return {
    update(state) { if (!closed) { latest = { ...state }; render(); } },
    close() {
      if (closed) return;
      closed = true;
      owned.release();
      dialog.window?.removeEventListener?.("close", preventClose, true);
      dialog.window?.removeEventListener?.("keydown", preventClose, true);
      dialog.window?.close?.();
    },
  };
}

export const UNDO_COPY_IDS: readonly MessageId[] = Object.freeze([
  "dlg-undo-title", "dlg-undo-window-title", "dlg-undo-restore-url", "dlg-undo-restore-creators",
  "dlg-undo-remove-attachment", "dlg-undo-remove-note", "dlg-undo-verify-creators", "dlg-undo-verify-created",
  "dlg-undo-note", "dlg-undo-cancel", "dlg-undo-confirm", "dlg-common-unnamed-item", "dlg-common-not-filled",
  "dlg-undo-time", "dlg-undo-restore-field", "dlg-undo-verify-field",
]);

/** 每条将被改动的记录行都用稳定 id，挂载后按参数填入，避免把句子拼在代码里。 */
export function buildUndoScope(batch: BatchJournalRecord, copyMessages: DialogCopy): { layout: any; fills: any[] } {
  const fills: any[] = [];
  const notFilled = copyMessages.text("dlg-common-not-filled");
  const line = (id: MessageId, args: Record<string, unknown>) => {
    const elementID = `zmta-undo-line-${fills.length}`;
    fills.push({ elementID, id, args });
    return { ...copy(""), id: elementID };
  };
  const rows = batch.items.filter(item => item.fields.some(f => f.status === "applied" || f.recoveryRequired)
    || item.creators?.status === "applied" || item.creators?.recoveryRequired || item.createdItems.some(c => c.status === "applied" || c.recoveryRequired))
    .map(item => ({ tag: "details", namespace: "html", properties: { open: true }, children: [
      copy(item.title || copyMessages.text("dlg-common-unnamed-item"), "summary"),
      ...item.fields.filter(f => f.status === "applied" || f.recoveryRequired).map(f =>
        f.afterUnknown || f.status !== "applied"
          ? line("dlg-undo-verify-field", { field: metadataFieldLabel(f.field) })
          : f.field.toLowerCase() === "url" ? copy(copyMessages.text("dlg-undo-restore-url"))
          : line("dlg-undo-restore-field", { field: metadataFieldLabel(f.field), after: String(f.after || notFilled), before: String(f.before || notFilled) })),
      ...(item.creators?.status === "applied" || item.creators?.recoveryRequired
        ? [copy(copyMessages.text(item.creators.afterUnknown || item.creators.status !== "applied"
          ? "dlg-undo-verify-creators" : "dlg-undo-restore-creators"))] : []),
      ...item.createdItems.filter(c => c.status === "applied" || c.recoveryRequired).map(c =>
        copy(copyMessages.text(c.status !== "applied" ? "dlg-undo-verify-created"
          : c.kind === "attachment" ? "dlg-undo-remove-attachment" : "dlg-undo-remove-note"))),
    ] }));
  const layout = root("zmta-undo-scope", [
    copy(copyMessages.text("dlg-undo-title"), "h2"),
    line("dlg-undo-time", { time: metadataRecordTime(batch.completedAt || batch.createdAt) }),
    ...rows,
    copy(copyMessages.text("dlg-undo-note")),
  ]);
  return { layout, fills };
}

export function showUndoConfirmation(batch: BatchJournalRecord, toolkit: any, copyMessages: DialogCopy): Promise<boolean> {
  if (!toolkit?.Dialog) return Promise.resolve(false);
  return new Promise(resolve => {
    const dialog = new toolkit.Dialog(1, 1);
    let settled = false;
    let owned: ReturnType<typeof trackPluginDialog>;
    const finish = (accepted: boolean, close = true) => {
      if (settled) return;
      const ownedScopeActive = owned?.active() === true;
      settled = true; owned?.release(); resolve(accepted && ownedScopeActive);
      if (close) dialog.window?.close?.();
    };
    owned = trackPluginDialog(dialog, "zmta-undo-scope", () => finish(false, false));
    if (!owned.active()) { owned.cancel(); return; }
    const { layout, fills } = buildUndoScope(batch, copyMessages);
    dialog.addCell(0, 0, layout, true);
    dialog.addButton(copyMessages.text("dlg-undo-cancel"), "zmta-undo-cancel", { noClose: true, callback: () => finish(false) });
    dialog.addButton(copyMessages.text("dlg-undo-confirm"), "zmta-undo-confirm", { noClose: true, callback: () => finish(true) });
    dialog.setDialogData({
      loadCallback: () => {
        if (!owned.attach()) return;
        markDialogWindow(dialog);
        fillCopy(dialog.window?.document, copyMessages, fills);
        dialog.window?.addEventListener?.("keydown", (event: any) => { if (event.key === "Escape") { event.preventDefault(); finish(false); } });
      },
      beforeUnloadCallback: () => finish(false, false),
    });
    dialog.open(copyMessages.text("dlg-undo-window-title"), { width: 680, height: 540, centerscreen: true, resizable: true, noDialogMode: true });
    owned.attach();
  });
}

const ITEM_STATE_IDS: Record<string, MessageId> = {
  applied: "dlg-result-state-applied", partial: "dlg-result-state-partial", failed: "dlg-result-state-failed",
  skipped: "dlg-result-state-skipped", "rolled-back": "dlg-result-state-rolled-back",
  "rollback-conflict": "dlg-result-state-rollback-conflict",
};
const OPERATION_STATE_IDS: Record<string, MessageId> = {
  applied: "dlg-result-op-applied", "rolled-back": "dlg-result-op-rolled-back",
  "rollback-conflict": "dlg-result-op-conflict", failed: "dlg-result-op-failed",
};
const OPERATION_LABEL_IDS: Record<string, MessageId> = {
  creators: "dlg-result-label-creators", attachment: "dlg-result-label-attachment", note: "dlg-result-label-note",
};

function operationCopy(operation: BatchItemResult["operations"][number], copyMessages: DialogCopy) {
  const label = operation.kind === "field"
    ? metadataFieldLabel(operation.identity)
    : copyMessages.text(OPERATION_LABEL_IDS[operation.kind]);
  const added = operation.status === "applied" && (operation.kind === "attachment" || operation.kind === "note");
  return { label, state: copyMessages.text(added ? "dlg-result-op-added" : OPERATION_STATE_IDS[operation.status] || "dlg-result-op-failed") };
}

export const RESULT_COPY_IDS: readonly MessageId[] = Object.freeze([
  "dlg-result-title-update", "dlg-result-title-undo", "dlg-result-title-retry", "dlg-result-state-unknown",
  "dlg-result-records", "dlg-result-retry", "dlg-result-done",
  "dlg-result-op-added",
  ...Object.values(ITEM_STATE_IDS), ...Object.values(OPERATION_STATE_IDS), ...Object.values(OPERATION_LABEL_IDS),
  "dlg-result-item", "dlg-result-operation", "dlg-result-operation-message", "dlg-result-summary-update", "dlg-result-summary-undo",
]);

export function buildWorkflowResultLayout(
  result: BatchRunResult | BatchRollbackResult,
  copyMessages: DialogCopy,
  undo = false,
  retry = false,
): { layout: any; fills: any[] } {
  const fills: any[] = [];
  const line = (id: MessageId, args: Record<string, unknown>) => {
    const elementID = `zmta-result-line-${fills.length}`;
    fills.push({ elementID, id, args });
    return { ...copy(""), id: elementID };
  };
  const summaryId: MessageId = "rolledBack" in result ? "dlg-result-summary-undo" : "dlg-result-summary-update";
  const summaryArgs = "rolledBack" in result
    ? { rolledBack: result.rolledBack, conflicts: result.conflicts, failed: result.failed }
    : { applied: result.applied, partial: result.partial, skipped: result.skipped + result.failed };
  const items = result.items.map(item => ({
    tag: "details", namespace: "html", properties: { open: true }, children: [
      line("dlg-result-item", {
        title: item.title || copyMessages.text("dlg-common-unnamed-item"),
        state: copyMessages.text(ITEM_STATE_IDS[item.status] || "dlg-result-state-unknown"),
      }),
      ...(item.message ? [copy(item.message)] : []),
      ...item.operations.map(operation => {
        const { label, state } = operationCopy(operation, copyMessages);
        return operation.message
          ? line("dlg-result-operation-message", { label, state, message: operation.message })
          : line("dlg-result-operation", { label, state });
      }),
    ],
  }));
  const layout = root("zmta-workflow-result", [
    copy(copyMessages.text(undo ? "dlg-result-title-undo" : retry ? "dlg-result-title-retry" : "dlg-result-title-update"), "h2"),
    line(summaryId, summaryArgs),
    ...items,
  ]);
  return { layout, fills };
}

export function showWorkflowResult(result: BatchRunResult | BatchRollbackResult, toolkit: any, options: {
  copy: DialogCopy; undo?: boolean; retry?: boolean; canRetry?: boolean; onRecords(returnWindow: any): Promise<unknown>;
}): Promise<"done" | "retry"> {
  if (!toolkit?.Dialog) return Promise.resolve("done");
  const copyMessages = options.copy;
  return new Promise(resolve => {
    const dialog = new toolkit.Dialog(1, 1);
    let settled = false;
    let owned: ReturnType<typeof trackPluginDialog>;
    const finish = (action: "done" | "retry", close = true) => {
      if (settled) return;
      const outcome = owned?.active() ? action : "done";
      settled = true; owned?.release(); resolve(outcome);
      if (close) dialog.window?.close?.();
    };
    owned = trackPluginDialog(dialog, "zmta-workflow-result", () => finish("done", false));
    if (!owned.active()) { owned.cancel(); return; }
    let recordsOpen = false;
    const actions = {
      done: () => finish("done"),
      records: () => {
        if (settled || recordsOpen || !owned.active()) return;
        recordsOpen = true;
        void options.onRecords(dialog.window).catch(error => Zotero.debug(`[zmta] 记录窗口失败：${error}`))
          .finally(() => { recordsOpen = false; if (owned.active() && !dialog.window?.closed) dialog.window?.focus?.(); });
      },
      ...(options.canRetry ? { retry: () => finish("retry") } : {}),
    };
    const { layout, fills } = buildWorkflowResultLayout(result, copyMessages, options.undo, options.retry);
    dialog.addCell(0, 0, layout, true);
    dialog.addButton(copyMessages.text("dlg-result-records"), "zmta-result-records", { noClose: true, callback: actions.records });
    if (actions.retry) dialog.addButton(copyMessages.text("dlg-result-retry"), "zmta-result-retry", { noClose: true, callback: actions.retry });
    dialog.addButton(copyMessages.text("dlg-result-done"), "zmta-result-done", { noClose: true, callback: actions.done });
    dialog.setDialogData({
      loadCallback: () => {
        if (!owned.attach()) return;
        markDialogWindow(dialog);
        fillCopy(dialog.window?.document, copyMessages, fills);
        dialog.window?.addEventListener?.("keydown", (event: any) => { if (event.key === "Escape") { event.preventDefault(); finish("done"); } });
      },
      beforeUnloadCallback: () => finish("done", false),
    });
    dialog.open(copyMessages.text(options.undo ? "dlg-result-title-undo" : options.retry ? "dlg-result-title-retry" : "dlg-result-title-update"), { width: 760, height: 620, centerscreen: true, resizable: true, noDialogMode: true });
    owned.attach();
  });
}
