import { trackPluginDialog } from "./dialogLifecycle";
import { DIALOG_STYLES, markDialogWindow } from "./dialogStyles";
import { fillCopy, type CopyEntry, type DialogCopy, type MessageId } from "./dialogCopy";
// 批量预检进度 UI：只消费纯进度事件，并通过 AbortSignal 请求协作取消。

import type { BatchPreflightProgress, BatchPreflightProgressStage } from "./batchTypes";

export interface BatchPreflightDialogHandle {
  readonly signal: AbortSignal;
  update(event: BatchPreflightProgress): void;
  requestCancel(): void;
  close(): void;
}

export interface BatchPreflightViewState {
  readonly completed: number;
  readonly total: number;
  readonly title: string;
  /** 当前阶段在 dialogs.ftl 里的消息 id；展示文本由 copy 解析。 */
  readonly stageId: MessageId;
  readonly stopping: boolean;
}

export const BATCH_PREFLIGHT_ELEMENT_IDS = Object.freeze({
  progress: "zmta-preflight-progress",
  meter: "zmta-preflight-meter",
  title: "zmta-preflight-title",
  stage: "zmta-preflight-stage",
  cancel: "zmta-preflight-cancel",
});

export const STAGE_MESSAGE_IDS: Record<BatchPreflightProgressStage, MessageId> = {
  "batch-start": "dlg-preflight-preparing",
  "item-start": "dlg-preflight-stage-item",
  "route-start": "dlg-preflight-stage-route",
  "item-complete": "dlg-preflight-stage-item-done",
  stopping: "dlg-preflight-stage-stopping",
  "batch-complete": "dlg-preflight-stage-done",
  cancelled: "dlg-preflight-stage-cancelled",
};

/** 开窗时一次性解析的静态文案，避免逐条异步查询。 */
export const BATCH_PREFLIGHT_COPY_IDS: readonly MessageId[] = Object.freeze([
  "dlg-preflight-title",
  "dlg-preflight-preparing",
  "dlg-preflight-current-item",
  "dlg-preflight-current-stage",
  "dlg-preflight-meter",
  "dlg-preflight-cancel",
  "dlg-preflight-stopping",
  ...Object.values(STAGE_MESSAGE_IDS),
  "dlg-preflight-progress",
]);

const PREFLIGHT_DIALOG_CSS = DIALOG_STYLES;

function normalizeTotal(total: number): number {
  return Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0;
}

export function reduceBatchPreflightViewState(
  current: BatchPreflightViewState,
  event: BatchPreflightProgress,
): BatchPreflightViewState {
  const total = normalizeTotal(event.total);
  const completed = Math.min(total, normalizeTotal(event.completed));
  const stopping = current.stopping || event.stage === "stopping" || event.stage === "cancelled";
  return {
    completed,
    total,
    title: event.title || current.title || "—",
    stageId: stopping && event.stage !== "cancelled" ? STAGE_MESSAGE_IDS.stopping : STAGE_MESSAGE_IDS[event.stage],
    stopping,
  };
}

export function buildBatchPreflightDialogLayout(total: number, copy: DialogCopy): { layout: any; fills: CopyEntry[] } {
  const safeTotal = normalizeTotal(total);
  const labelStyle = { marginBottom: "3px", color: "var(--zmta-muted)", fontSize: "11px" };
  const fills: CopyEntry[] = [{
    elementID: BATCH_PREFLIGHT_ELEMENT_IDS.progress,
    id: "dlg-preflight-progress",
    args: { done: 0, total: safeTotal },
  }];
  const layout = {
    tag: "div",
    namespace: "html",
    id: "zmta-batch-preflight",
    styles: {
      width: "100%",
      minWidth: "0",
      minHeight: "0",
      flex: "1",
      overflow: "auto",
      boxSizing: "border-box",
      padding: "18px",
      color: "CanvasText",
      backgroundColor: "Canvas",
    },
    children: [
      {
        tag: "section",
        namespace: "html",
        classList: ["zmta-preflight-card"],
        styles: { padding: "18px", border: "1px solid ButtonBorder", borderRadius: "8px", backgroundColor: "Canvas" },
        children: [
          {
            tag: "div",
            namespace: "html",
            id: BATCH_PREFLIGHT_ELEMENT_IDS.progress,
            classList: ["zmta-preflight-progress"],
            properties: { textContent: "" },
            attributes: { role: "status" },
            styles: { marginBottom: "12px", fontSize: "1.2em" },
          },
          { tag: "progress", namespace: "html", id: BATCH_PREFLIGHT_ELEMENT_IDS.meter, attributes: { "aria-label": copy.text("dlg-preflight-meter") }, properties: { max: Math.max(1, safeTotal), value: 0 } },
          { tag: "div", namespace: "html", properties: { textContent: copy.text("dlg-preflight-current-item") }, styles: labelStyle },
          {
            tag: "div",
            namespace: "html",
            id: BATCH_PREFLIGHT_ELEMENT_IDS.title,
            properties: { textContent: "—" },
            styles: { minHeight: "21px", marginBottom: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: "600" },
          },
          { tag: "div", namespace: "html", properties: { textContent: copy.text("dlg-preflight-current-stage") }, styles: labelStyle },
          {
            tag: "div",
            namespace: "html",
            id: BATCH_PREFLIGHT_ELEMENT_IDS.stage,
            classList: ["zmta-preflight-stage"],
            attributes: { role: "status" },
            properties: { textContent: copy.text("dlg-preflight-preparing") },
            styles: { minHeight: "20px", color: "var(--zmta-muted)" },
          },
        ],
      },
      { tag: "style", namespace: "html", properties: { textContent: PREFLIGHT_DIALOG_CSS } },
    ],
  };
  return { layout, fills };
}

export function getBatchPreflightDialogOptions() {
  return { width: 480, height: 300, centerscreen: true, resizable: true, noDialogMode: true };
}

function setText(doc: any, id: string, value: string): void {
  const element = doc?.getElementById?.(id);
  if (element) element.textContent = value;
}

function renderBatchPreflightState(doc: any, state: BatchPreflightViewState, copy: DialogCopy): void {
  const meter = doc?.getElementById?.(BATCH_PREFLIGHT_ELEMENT_IDS.meter);
  if (meter) { meter.max = Math.max(1, state.total); meter.value = state.completed; }
  fillCopy(doc, copy, [{ elementID: BATCH_PREFLIGHT_ELEMENT_IDS.progress, id: "dlg-preflight-progress", args: { done: state.completed, total: state.total } }]);
  setText(doc, BATCH_PREFLIGHT_ELEMENT_IDS.title, state.title);
  setText(doc, BATCH_PREFLIGHT_ELEMENT_IDS.stage, copy.text(state.stageId));
  const cancel = doc?.getElementById?.(BATCH_PREFLIGHT_ELEMENT_IDS.cancel);
  if (cancel && state.stopping) { cancel.disabled = true; cancel.textContent = copy.text("dlg-preflight-stopping"); }
}

function createCooperativeAbortController(): { signal: AbortSignal; abort(): void } {
  const listeners = new Set<EventListenerOrEventListenerObject>();
  const signal = {
    aborted: false,
    addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
      if (type === "abort" && listener) listeners.add(listener);
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
      if (type === "abort" && listener) listeners.delete(listener);
    },
  } as unknown as AbortSignal & { aborted: boolean };
  return {
    signal,
    abort() {
      if (signal.aborted) return;
      signal.aborted = true;
      const event = { type: "abort", target: signal, currentTarget: signal } as unknown as Event;
      for (const listener of listeners) {
        if (typeof listener === "function") listener.call(signal, event);
        else listener.handleEvent(event);
      }
    },
  };
}

export function openBatchPreflightDialog(ztoolkit: any, total: number, copy: DialogCopy): BatchPreflightDialogHandle {
  const controller = createCooperativeAbortController();
  const safeTotal = normalizeTotal(total);
  let state: BatchPreflightViewState = {
    completed: 0,
    total: safeTotal,
    title: "—",
    stageId: STAGE_MESSAGE_IDS["batch-start"],
    stopping: false,
  };
  let closed = false;
  let dialog: any;

  const document = () => dialog?.window?.document;
  const requestCancel = () => {
    if (controller.signal.aborted || closed) return;
    controller.abort();
    state = { ...state, stageId: STAGE_MESSAGE_IDS.stopping, stopping: true };
    renderBatchPreflightState(document(), state, copy);
  };

  dialog = new ztoolkit.Dialog(1, 1);
  const owned = trackPluginDialog(dialog, "zmta-batch-preflight", () => { requestCancel(); closed = true; });
  const built = buildBatchPreflightDialogLayout(safeTotal, copy);
  const layout = built.layout;
  layout.styles.gridColumn = "1 / -1";
  dialog.addCell(0, 0, layout, true);
  dialog.addButton(copy.text("dlg-preflight-cancel"), BATCH_PREFLIGHT_ELEMENT_IDS.cancel, { noClose: true, callback: requestCancel });
  dialog.setDialogData({ loadCallback: () => { if (!owned.attach()) return; markDialogWindow(dialog); fillCopy(document(), copy, built.fills); renderBatchPreflightState(document(), state, copy); }, beforeUnloadCallback: () => { requestCancel(); closed = true; owned.release(); } });
  if (owned.active()) {
    try {
      dialog.open(copy.text("dlg-preflight-title"), getBatchPreflightDialogOptions());
      owned.attach();
    } catch (error) {
      // open 抛错时不会有窗口；不结算会留下"占位窗口"条目，之后聚焦恢复恒为 false。
      owned.cancel();
      throw error;
    }
  } else owned.cancel();

  return {
    signal: controller.signal,
    update(event: BatchPreflightProgress) {
      if (closed) return;
      state = reduceBatchPreflightViewState(state, event);
      renderBatchPreflightState(document(), state, copy);
    },
    requestCancel,
    close() {
      if (closed) return;
      closed = true;
      owned.release();
      dialog?.window?.close?.();
    },
  };
}
