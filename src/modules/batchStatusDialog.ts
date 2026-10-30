import { trackPluginDialog } from "./dialogLifecycle";
import { mountMetadataNavigation } from "./metadataNavigation";
import { DIALOG_STYLES, markDialogWindow } from "./dialogStyles";
import { fillCopy, type DialogCopy, type MessageId } from "./dialogCopy";
import { creatorRoleLabel, metadataFieldLabel, metadataRouteLabel, metadataSourceLabel, metadataRecordTime } from "./metadataDisplay";
import { localized } from "../utils/locale";
// 批次状态 UI：只消费 journal 的不可变展示快照，不查询条目、不访问来源、不提供写入动作。

import type {
  BatchInspectionBatch,
  BatchInspectionOperation,
  BatchInspectionSource,
  BatchOperationStatus,
} from "./batchTypes";
import { getPref } from "../utils/prefs";

export interface BatchStatusSummary {
  readonly batches: number;
  readonly incomplete: number;
  readonly items: number;
  readonly fields: number;
  readonly creators: number;
  readonly attachments: number;
  readonly notes: number;
  readonly failed: number;
  readonly rollbackConflicts: number;
}

export interface BatchStatusDisplayOptions {
  readonly showTechnicalDetails?: boolean;
  readonly error?: string;
  readonly initialBatchId?: string;
  readonly locatableItemKeys?: ReadonlySet<string>;
}

export const BATCH_STATUS_ELEMENT_IDS = Object.freeze({
  root: "zmta-batch-status",
  close: "zmta-batch-status-close",
});

const BATCH_STATUS_MESSAGE_IDS: Record<BatchInspectionBatch["status"], MessageId> = {
  running: "dlg-history-batch-running",
  completed: "dlg-history-batch-completed",
  partial: "dlg-history-batch-partial",
  failed: "dlg-history-batch-failed",
  "rolled-back": "dlg-history-batch-rolled-back",
  "rollback-partial": "dlg-history-batch-rollback-partial",
};

const OPERATION_STATUS_MESSAGE_IDS: Record<BatchOperationStatus, MessageId> = {
  planned: "dlg-history-op-planned",
  applied: "dlg-history-op-applied",
  failed: "dlg-history-op-failed",
  "rolled-back": "dlg-history-op-rolled-back",
  "rollback-conflict": "dlg-history-op-rollback-conflict",
};

const OPERATION_KIND_MESSAGE_IDS: Record<BatchInspectionOperation["kind"], MessageId> = {
  field: "dlg-history-kind-field",
  creators: "dlg-history-kind-creators",
  attachment: "dlg-history-kind-attachment",
  note: "dlg-history-kind-note",
};

export const BATCH_STATUS_COPY_IDS: readonly MessageId[] = Object.freeze([
  "dlg-history-title", "dlg-history-none", "dlg-history-no-operations", "dlg-history-no-items",
  "dlg-history-latest", "dlg-history-earlier", "dlg-history-technical", "dlg-history-locate",
  "dlg-history-locate-title", "dlg-history-locate-disabled", "dlg-history-locate-failed",
  "dlg-history-empty-headline", "dlg-history-unavailable-headline", "dlg-history-empty-subline",
  "dlg-history-reload", "dlg-history-back", "dlg-history-nav", "dlg-history-unfinished",
  "dlg-history-headline", "dlg-history-headline-incomplete", "dlg-history-subline",
  "dlg-history-subline-attention", "dlg-history-batch-meta", "dlg-history-op-values", "dlg-history-source",
  "dlg-common-unnamed-item",
  ...Object.values(BATCH_STATUS_MESSAGE_IDS),
  ...Object.values(OPERATION_STATUS_MESSAGE_IDS),
  ...Object.values(OPERATION_KIND_MESSAGE_IDS),
]);

const BATCH_STATUS_CSS = DIALOG_STYLES + `
  #zmta-batch-status .zmta-status-title,
  #zmta-batch-status .zmta-status-value,
  #zmta-batch-status .zmta-status-source,
  #zmta-batch-status .zmta-status-error { overflow-wrap: anywhere; }
  #zmta-batch-status .zmta-technical-details { margin: 5px 0 10px; }
  #zmta-batch-status .zmta-technical-content { white-space: pre-wrap; user-select: text; }
  @media (max-width: 760px) {
    #zmta-batch-status .zmta-status-workspace { grid-template-columns: minmax(0, 1fr) !important; grid-template-rows: auto minmax(0, 1fr); }
    #zmta-batch-status .zmta-status-workspace[data-single="true"] { grid-template-rows: minmax(0, 1fr); }
    #zmta-batch-status .zmta-status-sidebar { border-right: 0 !important; border-bottom: 1px solid ButtonBorder; }
  }
`;

export function getBatchStatusLabel(status: BatchInspectionBatch["status"], copy: DialogCopy): string {
  return copy.text(BATCH_STATUS_MESSAGE_IDS[status]);
}

export function getBatchOperationStatusLabel(status: BatchOperationStatus, copy: DialogCopy): string {
  return copy.text(OPERATION_STATUS_MESSAGE_IDS[status]);
}

export function summarizeBatchStatus(batches: readonly BatchInspectionBatch[]): BatchStatusSummary {
  const summary = {
    batches: batches.length,
    incomplete: 0,
    items: 0,
    fields: 0,
    creators: 0,
    attachments: 0,
    notes: 0,
    failed: 0,
    rollbackConflicts: 0,
  };
  for (const batch of batches) {
    if (batch.incomplete) summary.incomplete += 1;
    summary.items += batch.items.length;
    for (const item of batch.items) {
      for (const operation of item.operations) {
        if (operation.kind === "field") summary.fields += 1;
        else if (operation.kind === "creators") summary.creators += 1;
        else if (operation.kind === "attachment") summary.attachments += 1;
        else summary.notes += 1;
        if (operation.status === "failed") summary.failed += 1;
        if (operation.status === "rollback-conflict") summary.rollbackConflicts += 1;
      }
    }
  }
  return summary;
}

function displayValue(value: unknown): string {
  if (value === undefined) return localized("未知", "Unknown");
  if (value === null || value === "") return localized("（空）", "(empty)");
  if (typeof value === "string") return value;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch (_error) {
    return String(value);
  }
}

function displayOperationValue(operation: BatchInspectionOperation, value: unknown): string {
  if (operation.kind !== "creators" || !Array.isArray(value)) return displayValue(value);
  if (value.length === 0) return localized("（空列表）", "(empty list)");
  return value.map((creator: any, index) => {
    const name = typeof creator?.name === "string"
      ? creator.name
      : [creator?.firstName, creator?.lastName].filter(Boolean).join(" ");
    const creatorType = creator?.creatorType || "未知角色";
    return `${index + 1}. ${name || localized("（空名称）", "(no name)")} · ${creatorRoleLabel(creatorType)}`;
  }).join("\n");
}

/** 只给出来源名；"来源："前缀在界面文案里，由 FTL 统一。 */
export function formatBatchInspectionSource(source?: BatchInspectionSource): string {
  return (source && metadataSourceLabel(source.providerId)) || localized("未知", "Unknown");
}

/** 技术详情是排障区：标签走命令式双语，内部诊断原文不做翻译。 */
function technicalSourceLines(source: BatchInspectionSource | undefined): string[] {
  const routeLabel = localized("获取方式：", "Retrieved by: ");
  const identifierLabel = localized("标识符：", "Identifiers: ");
  if (!source) return [localized("来源信息不可用", "Source information unavailable")];
  const route = source.routeId
    ? (metadataRouteLabel(source.routeId) ?? source.routeId)
    : localized("未知方式", "Unknown route");
  const identifiers = source.identifiers.length
    ? source.identifiers.map((identifier) => `${identifier.type}: ${identifier.value}`).join(" · ")
    : localized("无标识符", "No identifiers");
  return [`${routeLabel}${route}`, `${identifierLabel}${identifiers}`];
}

function operationLabel(operation: BatchInspectionOperation, copy: DialogCopy): string {
  if (operation.kind === "field") return metadataFieldLabel(operation.label);
  if (operation.kind === "creators") return copy.text("dlg-history-kind-creators");
  return operation.label && operation.label !== "Note" ? operation.label : copy.text(OPERATION_KIND_MESSAGE_IDS[operation.kind]);
}

function buildTechnicalDetails(lines: string[], copy: DialogCopy): any {
  return {
    tag: "details",
    namespace: "html",
    classList: ["zmta-technical-details"],
    children: [
      { tag: "summary", namespace: "html", properties: { textContent: copy.text("dlg-history-technical") } },
      { tag: "div", namespace: "html", classList: ["zmta-technical-content"], properties: { textContent: lines.join("\n") }, styles: { whiteSpace: "pre-wrap" } },
    ],
  };
}

function selectBatch(doc: Document, selectedIndex: number, batchCount: number): void {
  if (!doc) return;
  for (let index = 0; index < batchCount; index += 1) {
    const detail = doc.getElementById(`zmta-batch-status-detail-${index}`) as HTMLElement | null;
    if (detail) detail.style.display = index === selectedIndex ? "block" : "none";
  }
  const pane = doc.getElementById("zmta-status-detail-pane");
  if (pane) pane.scrollTop = 0;
}

function buildOperation(operation: BatchInspectionOperation, operationIndex: number, copy: DialogCopy, fills: any[]): any {
  const hasValues = operation.kind === "field" || operation.before !== undefined || operation.after !== undefined;
  const isError = operation.status === "failed" || operation.status === "rollback-conflict";
  const valueID = `zmta-status-op-value-${operationIndex}`;
  if (hasValues) {
    fills.push({ elementID: valueID, id: "dlg-history-op-values", args: {
      before: displayOperationValue(operation, operation.before),
      after: displayOperationValue(operation, operation.after),
    } });
  }
  return {
    tag: "div",
    namespace: "html",
    classList: ["zmta-status-operation"],
    attributes: { "data-kind": operation.kind, "data-status": operation.status },
    styles: { padding: "9px 10px", borderBottom: "1px solid ButtonBorder" },
    children: [
      {
        tag: "div",
        namespace: "html",
        styles: { display: "flex", justifyContent: "space-between", gap: "16px", alignItems: "baseline" },
        children: [
          { tag: "strong", namespace: "html", properties: { textContent: operationLabel(operation, copy) }, styles: { minWidth: "0", overflowWrap: "anywhere" } },
          { tag: "span", namespace: "html", properties: { textContent: getBatchOperationStatusLabel(operation.status, copy) }, styles: { flex: "none", whiteSpace: "nowrap" } },
        ],
      },
      ...(hasValues ? [{
        tag: "div",
        namespace: "html",
        id: valueID,
        classList: ["zmta-status-value"],
        properties: { textContent: "" },
        styles: { marginTop: "4px", color: "var(--zmta-muted)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
      }] : []),
      ...(operation.message ? [{
        tag: "div",
        namespace: "html",
        classList: [isError ? "zmta-status-error" : "zmta-status-muted"],
        properties: { textContent: operation.message },
        styles: { marginTop: "4px", color: isError ? "Mark" : "var(--zmta-muted)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
      }] : []),
    ],
  };
}

function buildItem(
  item: BatchInspectionBatch["items"][number],
  itemIndex: number,
  copy: DialogCopy,
  fills: any[],
  showTechnicalDetails: boolean,
  locate?: (item: BatchInspectionBatch["items"][number]) => void,
  locatable?: ReadonlySet<string>,
): any {
  const sourceID = `zmta-status-source-${itemIndex}`;
  fills.push({ elementID: sourceID, id: "dlg-history-source", args: { source: formatBatchInspectionSource(item.source) } });
  return {
    tag: "details",
    namespace: "html",
    properties: { open: true },
    classList: ["zmta-status-item"],
    attributes: { "data-item-key": item.itemKey },
    styles: { marginBottom: "18px" },
    children: [
      { tag: "summary", namespace: "html", classList: ["zmta-status-title"], properties: { textContent: item.title || copy.text("dlg-common-unnamed-item") }, styles: { margin: "0 0 3px", fontSize: "15px", overflowWrap: "anywhere" } },
      { tag: "div", namespace: "html", id: sourceID, classList: ["zmta-status-source"], properties: { textContent: "" }, styles: { margin: "5px 0 8px", color: "var(--zmta-muted)", fontSize: "12px", overflowWrap: "anywhere" } },
      ...(locate ? [{ tag: "button", namespace: "html", attributes: { type: "button" },
        properties: {
          textContent: copy.text("dlg-history-locate"),
          disabled: !locatable?.has(item.itemKey),
          title: locatable?.has(item.itemKey) ? copy.text("dlg-history-locate-title") : copy.text("dlg-history-locate-disabled"),
        },
        listeners: [{ type: "click", listener: () => locate(item) }] }] : []),
      ...(showTechnicalDetails
        ? [buildTechnicalDetails([`${localized("条目编号：", "Item ID: ")}${item.itemKey}`, ...technicalSourceLines(item.source)], copy)]
        : []),
      ...(item.operations.length
        ? [{ tag: "div", namespace: "html", classList: ["zmta-status-operations"], styles: { border: "1px solid ButtonBorder", borderRadius: "7px", overflow: "hidden" },
          children: item.operations.map((operation, index) => buildOperation(operation, `${itemIndex}-${index}`, copy, fills)) }]
        : [{ tag: "div", namespace: "html", classList: ["zmta-status-muted"], properties: { textContent: copy.text("dlg-history-no-operations") }, styles: { color: "var(--zmta-muted)", fontSize: "12px" } }]),
    ],
  };
}

// 返回 DialogHelper 可直接消费的声明式布局；事件只切换当前文档中的可见详情。
export function buildBatchStatusDialogLayout(
  batches: readonly BatchInspectionBatch[],
  copy: DialogCopy,
  options: BatchStatusDisplayOptions = {},
  actions: { locate?: (item: BatchInspectionBatch["items"][number]) => void } = {},
): { layout: any; fills: any[] } {
  const showTechnicalDetails = options.showTechnicalDetails === true;
  const summary = summarizeBatchStatus(batches);
  const initialIndex = Math.max(0, batches.findIndex(batch => batch.batchId === options.initialBatchId));
  const totalOperations = summary.fields + summary.creators + summary.attachments + summary.notes;
  const fills: any[] = [];
  const headlineID = "zmta-records-headline";
  const sublineID = "zmta-records-subline";
  if (batches.length) {
    fills.push({
      elementID: headlineID,
      id: summary.incomplete ? "dlg-history-headline-incomplete" : "dlg-history-headline",
      args: { batches: summary.batches, incomplete: summary.incomplete },
    });
    fills.push({
      elementID: sublineID,
      id: summary.failed + summary.rollbackConflicts ? "dlg-history-subline-attention" : "dlg-history-subline",
      args: { items: summary.items, ops: totalOperations, attention: summary.failed + summary.rollbackConflicts },
    });
  }
  const details = batches.map((batch, index) => {
    const state = `${getBatchStatusLabel(batch.status, copy)}${batch.incomplete ? ` · ${copy.text("dlg-history-unfinished")}` : ""}`;
    const titleID = `zmta-status-batch-title-${index}`;
    if (index > 0) fills.push({ elementID: titleID, id: "dlg-history-earlier", args: { index: index + 1 } });
    const metaID = `zmta-status-batch-meta-${index}`;
    fills.push({
      elementID: metaID,
      id: "dlg-history-batch-meta",
      args: {
        start: metadataRecordTime(batch.createdAt),
        end: metadataRecordTime(batch.completedAt),
        items: batch.items.length,
        ops: batch.items.reduce((count, item) => count + item.operations.length, 0),
      },
    });
    return {
      tag: "article",
      namespace: "html",
      id: `zmta-batch-status-detail-${index}`,
      attributes: { "data-batch-id": batch.batchId },
      styles: { display: index === initialIndex ? "block" : "none", padding: "20px 24px 32px", minWidth: "0" },
      children: [
        { tag: "h2", namespace: "html", id: titleID, classList: ["zmta-status-title"],
          properties: { textContent: index === 0 ? copy.text("dlg-history-latest") : "" },
          styles: { margin: "0 0 5px", fontSize: "18px", overflowWrap: "anywhere" } },
        { tag: "div", namespace: "html", properties: { textContent: state }, styles: { marginBottom: "3px", fontWeight: "600" } },
        { tag: "div", namespace: "html", id: metaID, classList: ["zmta-status-muted"], properties: { textContent: "" }, styles: { margin: "3px 0 18px", color: "var(--zmta-muted)", fontSize: "12px" } },
        ...(showTechnicalDetails
          ? [buildTechnicalDetails([
            `${localized("更新编号：", "Update ID: ")}${batch.batchId}`,
            `${localized("创建时间：", "Created: ")}${batch.createdAt}`,
            `${localized("完成时间：", "Finished: ")}${batch.completedAt || copy.text("dlg-history-unfinished")}`,
          ], copy)]
          : []),
        ...(batch.items.length
          ? batch.items.map((item, itemIndex) => buildItem(item, `${index}-${itemIndex}`, copy, fills, showTechnicalDetails, actions.locate, options.locatableItemKeys))
          : [{ tag: "div", namespace: "html", classList: ["zmta-status-muted"], properties: { textContent: copy.text("dlg-history-no-items") }, styles: { color: "var(--zmta-muted)" } }]),
      ],
    };
  });

  const layout = {
    tag: "div",
    namespace: "html",
    id: BATCH_STATUS_ELEMENT_IDS.root,
    styles: { display: "grid", gridTemplateRows: "auto minmax(0, 1fr)", width: "100%", minWidth: "0", height: "100%", minHeight: "0", boxSizing: "border-box", overflow: "hidden", colorScheme: "light dark", color: "CanvasText", backgroundColor: "Canvas" },
    children: [
      {
        tag: "header",
        namespace: "html",
        styles: { padding: "12px 18px", borderBottom: "1px solid ButtonBorder" },
        children: [
          { tag: "p", namespace: "html", id: "zmta-records-message", attributes: { role: options.error ? "alert" : "status" }, properties: { textContent: options.error || "" } },
          { tag: "strong", namespace: "html", id: headlineID, properties: { textContent: "" }, styles: { display: "block", fontSize: "16px" } },
          { tag: "span", namespace: "html", id: sublineID, classList: ["zmta-status-muted"], properties: { textContent: "" }, styles: { color: "var(--zmta-muted)", fontSize: "12px" } },
        ],
      },
      {
        tag: "div",
        namespace: "html",
        classList: ["zmta-status-workspace"],
        attributes: { "data-single": String(batches.length < 2) },
        styles: { display: "grid", gridTemplateColumns: batches.length < 2 ? "minmax(0, 1fr)" : "clamp(220px, 25vw, 280px) minmax(0, 1fr)", width: "100%", minWidth: "0", minHeight: "0", boxSizing: "border-box" },
        children: [
          { tag: "nav", namespace: "html", id: "zmta-history-navigation", classList: ["zmta-status-sidebar"], attributes: { "aria-label": copy.text("dlg-history-nav") }, styles: { overflow: "auto", minWidth: "0", padding: "9px", borderRight: "1px solid ButtonBorder", display: batches.length < 2 ? "none" : "block" } },
          { tag: "main", namespace: "html", id: "zmta-status-detail-pane", classList: ["zmta-status-detail-pane"], styles: { overflow: "auto", minWidth: "0" }, children: details.length ? details : [{ tag: "div", namespace: "html", classList: ["zmta-status-muted"], properties: { textContent: copy.text("dlg-history-none") }, styles: { padding: "20px 24px", color: "var(--zmta-muted)" } }] },
        ],
      },
      { tag: "style", namespace: "html", properties: { textContent: BATCH_STATUS_CSS } },
    ],
  };
  // 空记录/读取失败时的头部文字是静态文案，直接用 text 填。
  if (!batches.length) {
    const headline = layout.children[0].children[1];
    headline.properties.textContent = copy.text(options.error ? "dlg-history-unavailable-headline" : "dlg-history-empty-headline");
    layout.children[0].children[2].properties.textContent = copy.text("dlg-history-empty-subline");
  }
  return { layout, fills };
}

export function getBatchStatusDialogOptions() {
  return { width: 980, height: 700, centerscreen: true, resizable: true, noDialogMode: true };
}

/** 打开只读状态窗口；唯一完成方式是关闭，重复按钮/窗口事件只结算一次。 */
export interface BatchStatusDialogObserver {
  /** 只供宿主机制测试观察真实 DialogHelper；生产调用不传。 */
  onOpen?(dialog: any): void;
  onReloadRequest?(): void;
  onLocate?(item: BatchInspectionBatch["items"][number]): Promise<void>;
}

export function showBatchStatusDialog(
  batches: readonly BatchInspectionBatch[],
  ztoolkit: any,
  copy: DialogCopy,
  observer: BatchStatusDialogObserver = {},
  displayOptions?: BatchStatusDisplayOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let dialog: any;
    let fills: any[] = [];
    try {
      dialog = new ztoolkit.Dialog(1, 1);
      const built = buildBatchStatusDialogLayout(batches, copy, {
        showTechnicalDetails: displayOptions?.showTechnicalDetails
          ?? getPref("showTechnicalDetails") === true,
        ...displayOptions,
      }, { locate: observer.onLocate ? item => {
        if (!owned?.active()) return;
        void observer.onLocate!(item).catch(error => {
          if (!owned?.active()) return;
          const message = dialog.window?.document?.getElementById("zmta-records-message");
          if (message) message.textContent = error instanceof Error ? error.message : copy.text("dlg-history-locate-failed");
        });
      } : undefined });
      fills = built.fills;
      built.layout.styles.gridColumn = "1 / -1";
      dialog.addCell(0, 0, built.layout, true);
    } catch (error) {
      reject(error);
      return;
    }

    let closed = false;
    let owned: ReturnType<typeof trackPluginDialog>;
    let disposeNavigation = () => {};
    const finish = () => {
      if (closed) return;
      closed = true;
      owned?.release();
      try { disposeNavigation(); } catch (error) { Zotero.debug(`[zmta-ui] history navigation cleanup: ${error}`); }
      resolve();
    };
    owned = trackPluginDialog(dialog, "zmta-batch-status", finish);
    if (!owned.active()) { owned.cancel(); return; }
    if (observer.onReloadRequest) dialog.addButton(copy.text("dlg-history-reload"), "zmta-batch-status-reload", { callback: () => { if (closed || !owned.active()) return; observer.onReloadRequest!(); finish(); } });
    dialog.addButton(copy.text("dlg-history-back"), BATCH_STATUS_ELEMENT_IDS.close, { callback: finish });
    dialog.setDialogData({
      loadCallback: () => { if (!owned.attach()) return; markDialogWindow(dialog);
        fillCopy(dialog.window?.document, copy, fills);
        const initialIndex = Math.max(0, batches.findIndex(b => b.batchId === displayOptions?.initialBatchId));
        disposeNavigation = mountMetadataNavigation(dialog.window, "zmta-history-navigation", batches.map(b => ({
          key: b.batchId,
          label: `${metadataRecordTime(b.completedAt || b.createdAt)} · ${getBatchStatusLabel(b.status, copy)} · ${localized(`${b.items.length} 个条目`, `${b.items.length} items`)}`,
        })), batches[initialIndex]?.batchId || "", key => {
          const index = batches.findIndex(b => b.batchId === key);
          if (index >= 0) selectBatch(dialog.window.document, index, batches.length);
        });
        dialog.window?.addEventListener?.("keydown", (event: any) => { if (event.key === "Escape") { event.preventDefault(); finish(); dialog.window?.close?.(); } }); },
      beforeUnloadCallback: finish,
    });
    dialog.open(copy.text("dlg-history-title"), getBatchStatusDialogOptions());
    owned.attach();
    observer.onOpen?.(dialog);
  });
}
