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
  readonly stage: string;
  readonly stopping: boolean;
}

export const BATCH_PREFLIGHT_ELEMENT_IDS = Object.freeze({
  progress: "zmta-preflight-progress",
  title: "zmta-preflight-title",
  stage: "zmta-preflight-stage",
  cancel: "zmta-preflight-cancel",
});

const STAGE_LABELS: Record<BatchPreflightProgressStage, string> = {
  "batch-start": "正在准备",
  "item-start": "正在检查条目",
  "route-start": "正在查询上游",
  "item-complete": "条目检查完成",
  stopping: "正在停止",
  "batch-complete": "预检完成",
  cancelled: "已停止",
};

const PREFLIGHT_DIALOG_CSS = `
  #zmta-batch-preflight {
    --zmta-window: #242424;
    --zmta-panel: #303030;
    --zmta-line: #4b4b4b;
    --zmta-text: #f0f0f0;
    --zmta-muted: #b5b5b5;
    --zmta-accent: #4da3ff;
    background: var(--zmta-window) !important;
    color: var(--zmta-text) !important;
    color-scheme: light dark;
    font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif !important;
  }

  @media (prefers-color-scheme: light) {
    #zmta-batch-preflight {
      --zmta-window: #f7f7f7;
      --zmta-panel: #ffffff;
      --zmta-line: #d0d0d0;
      --zmta-text: #202124;
      --zmta-muted: #62666d;
      --zmta-accent: #0969da;
    }
  }

  #zmta-batch-preflight .zmta-preflight-card {
    border: 1px solid var(--zmta-line) !important;
    background: var(--zmta-panel) !important;
  }

  #zmta-batch-preflight .zmta-preflight-progress {
    color: var(--zmta-accent) !important;
  }

  #zmta-batch-preflight .zmta-preflight-stage {
    color: var(--zmta-muted) !important;
  }
`;

function normalizeTotal(total: number): number {
  return Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0;
}

function formatStage(event: BatchPreflightProgress): string {
  if (event.message) return event.message;
  return STAGE_LABELS[event.stage];
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
    stage: stopping && event.stage !== "cancelled" ? "正在停止" : formatStage(event),
    stopping,
  };
}

export function buildBatchPreflightDialogLayout(total: number): any {
  const safeTotal = normalizeTotal(total);
  return {
    tag: "div",
    namespace: "html",
    id: "zmta-batch-preflight",
    styles: {
      width: "100%",
      minWidth: "0",
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
            properties: { textContent: `已完成 0 / ${safeTotal}` },
            styles: { marginBottom: "12px", color: "LinkText", fontSize: "16px", fontWeight: "650" },
          },
          { tag: "div", namespace: "html", properties: { textContent: "当前条目" }, styles: { marginBottom: "3px", color: "GrayText", fontSize: "11px" } },
          {
            tag: "div",
            namespace: "html",
            id: BATCH_PREFLIGHT_ELEMENT_IDS.title,
            properties: { textContent: "—" },
            styles: { minHeight: "21px", marginBottom: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: "600" },
          },
          { tag: "div", namespace: "html", properties: { textContent: "当前阶段" }, styles: { marginBottom: "3px", color: "GrayText", fontSize: "11px" } },
          {
            tag: "div",
            namespace: "html",
            id: BATCH_PREFLIGHT_ELEMENT_IDS.stage,
            classList: ["zmta-preflight-stage"],
            properties: { textContent: "正在准备" },
            styles: { minHeight: "20px", color: "GrayText" },
          },
        ],
      },
      { tag: "style", namespace: "html", properties: { textContent: PREFLIGHT_DIALOG_CSS } },
    ],
  };
}

export function getBatchPreflightDialogOptions() {
  return { width: 480, height: 300, centerscreen: true, resizable: false, noDialogMode: true };
}

function setText(doc: any, id: string, value: string): void {
  const element = doc?.getElementById?.(id);
  if (element) element.textContent = value;
}

function renderBatchPreflightState(doc: any, state: BatchPreflightViewState): void {
  setText(doc, BATCH_PREFLIGHT_ELEMENT_IDS.progress, `已完成 ${state.completed} / ${state.total}`);
  setText(doc, BATCH_PREFLIGHT_ELEMENT_IDS.title, state.title);
  setText(doc, BATCH_PREFLIGHT_ELEMENT_IDS.stage, state.stage);
  const cancel = doc?.getElementById?.(BATCH_PREFLIGHT_ELEMENT_IDS.cancel);
  if (cancel && state.stopping) cancel.disabled = true;
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

export function openBatchPreflightDialog(ztoolkit: any, total: number): BatchPreflightDialogHandle {
  const controller = createCooperativeAbortController();
  const safeTotal = normalizeTotal(total);
  let state: BatchPreflightViewState = {
    completed: 0,
    total: safeTotal,
    title: "—",
    stage: "正在准备",
    stopping: false,
  };
  let closed = false;
  let dialog: any;

  const document = () => dialog?.window?.document;
  const requestCancel = () => {
    if (controller.signal.aborted || closed) return;
    controller.abort();
    state = { ...state, stage: "正在停止", stopping: true };
    renderBatchPreflightState(document(), state);
  };

  dialog = new ztoolkit.Dialog(1, 1);
  const layout = buildBatchPreflightDialogLayout(safeTotal);
  layout.styles.gridColumn = "1 / -1";
  dialog.addCell(0, 0, layout, true);
  dialog.addButton("取消", BATCH_PREFLIGHT_ELEMENT_IDS.cancel, { noClose: true, callback: requestCancel });
  dialog.setDialogData({ beforeUnloadCallback: () => requestCancel() });
  dialog.open("正在预检元数据更新", getBatchPreflightDialogOptions());

  return {
    signal: controller.signal,
    update(event: BatchPreflightProgress) {
      if (closed) return;
      state = reduceBatchPreflightViewState(state, event);
      renderBatchPreflightState(document(), state);
    },
    requestCancel,
    close() {
      if (closed) return;
      closed = true;
      dialog?.window?.close?.();
    },
  };
}
