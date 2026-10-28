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
}

export const BATCH_STATUS_ELEMENT_IDS = Object.freeze({
  root: "zmta-batch-status",
  close: "zmta-batch-status-close",
});

const BATCH_STATUS_LABELS: Record<BatchInspectionBatch["status"], string> = {
  running: "进行中",
  completed: "已完成",
  partial: "部分完成",
  failed: "失败",
  "rolled-back": "已回滚",
  "rollback-partial": "部分回滚",
};

const OPERATION_STATUS_LABELS: Record<BatchOperationStatus, string> = {
  planned: "待执行",
  applied: "已应用",
  failed: "失败",
  "rolled-back": "已回滚",
  "rollback-conflict": "回滚冲突",
};

const OPERATION_KIND_LABELS: Record<BatchInspectionOperation["kind"], string> = {
  field: "字段",
  creators: "作者与贡献者",
  attachment: "附件",
  note: "笔记",
};

const PROVIDER_LABELS: Record<string, string> = {
  douban: "豆瓣读书",
  "douban-web": "豆瓣读书",
  zotero: "Zotero",
};

const ROUTE_LABELS: Record<string, string> = {
  "url.web": "网页获取",
  "doi.search": "DOI 检索",
};

const FIELD_LABELS: Record<string, string> = {
  title: "标题",
  shortTitle: "短标题",
  abstractNote: "摘要",
  date: "日期",
  publisher: "出版社",
  publicationTitle: "刊物名称",
  volume: "卷",
  issue: "期",
  pages: "页码",
  edition: "版次",
  language: "语言",
  ISBN: "ISBN",
  ISSN: "ISSN",
  DOI: "DOI",
  url: "网址",
};

const CREATOR_ROLE_LABELS: Record<string, string> = {
  author: "作者",
  bookAuthor: "原著作者",
  contributor: "贡献者",
  editor: "编辑",
  seriesEditor: "丛书编辑",
  translator: "译者",
  director: "导演",
  scriptwriter: "编剧",
  producer: "制片人",
  performer: "表演者",
  composer: "作曲者",
  artist: "艺术家",
  interviewer: "采访者",
  interviewee: "受访者",
  inventor: "发明人",
};

const BATCH_STATUS_CSS = `
  #zmta-batch-status {
    --zmta-window: #242424;
    --zmta-panel: #2b2b2b;
    --zmta-panel-raised: #303030;
    --zmta-line: #4b4b4b;
    --zmta-text: #f0f0f0;
    --zmta-muted: #b5b5b5;
    --zmta-accent: #4da3ff;
    --zmta-danger: #ff8585;
    background: var(--zmta-window) !important;
    color: var(--zmta-text) !important;
    font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif !important;
  }

  @media (prefers-color-scheme: light) {
    #zmta-batch-status {
      --zmta-window: #f7f7f7;
      --zmta-panel: #ffffff;
      --zmta-panel-raised: #f0f0f0;
      --zmta-line: #d0d0d0;
      --zmta-text: #202124;
      --zmta-muted: #62666d;
      --zmta-accent: #0969da;
      --zmta-danger: #b42318;
    }
  }

  #zmta-batch-status .zmta-status-sidebar {
    border-color: var(--zmta-line) !important;
    background: var(--zmta-panel) !important;
  }

  #zmta-batch-status .zmta-status-tab {
    appearance: none !important;
    display: block !important;
    box-sizing: border-box !important;
    height: auto !important;
    min-height: 0 !important;
    max-height: none !important;
    line-height: 1.5 !important;
    color: var(--zmta-text) !important;
  }

  #zmta-batch-status .zmta-status-tab:hover,
  #zmta-batch-status .zmta-status-tab[aria-selected="true"] {
    background: var(--zmta-panel-raised) !important;
  }

  #zmta-batch-status .zmta-status-tab[aria-selected="true"] {
    border-color: var(--zmta-accent) !important;
  }

  #zmta-batch-status .zmta-status-muted,
  #zmta-batch-status .zmta-status-source,
  #zmta-batch-status .zmta-status-value {
    color: var(--zmta-muted) !important;
  }

  #zmta-batch-status .zmta-status-error {
    color: var(--zmta-danger) !important;
    overflow-wrap: anywhere !important;
    white-space: pre-wrap !important;
  }

  #zmta-batch-status .zmta-status-operation {
    border-color: var(--zmta-line) !important;
  }

  #zmta-batch-status .zmta-status-title,
  #zmta-batch-status .zmta-status-value,
  #zmta-batch-status .zmta-status-source {
    overflow-wrap: anywhere !important;
  }

  #zmta-batch-status .zmta-technical-details {
    margin: 5px 0 10px !important;
    color: var(--zmta-muted) !important;
    font-size: 12px !important;
  }

  #zmta-batch-status .zmta-technical-details summary {
    width: max-content !important;
    cursor: pointer !important;
  }

  #zmta-batch-status .zmta-technical-content {
    margin-top: 5px !important;
    padding-left: 12px !important;
    overflow-wrap: anywhere !important;
    user-select: text !important;
  }

  #zmta-batch-status-close {
    min-width: 88px !important;
    min-height: 32px !important;
  }

  @media (max-width: 700px) {
    #zmta-batch-status .zmta-status-workspace {
      grid-template-columns: minmax(0, 1fr) !important;
      grid-template-rows: minmax(88px, 28vh) minmax(0, 1fr) !important;
    }

    #zmta-batch-status .zmta-status-sidebar {
      border-right: 0 !important;
      border-bottom: 1px solid var(--zmta-line) !important;
    }
  }
`;

export function getBatchStatusLabel(status: BatchInspectionBatch["status"]): string {
  return BATCH_STATUS_LABELS[status];
}

export function getBatchOperationStatusLabel(status: BatchOperationStatus): string {
  return OPERATION_STATUS_LABELS[status];
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
  if (value === undefined) return "未知";
  if (value === null || value === "") return "（空）";
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
  if (value.length === 0) return "（空列表）";
  return value.map((creator: any, index) => {
    const name = typeof creator?.name === "string"
      ? creator.name
      : [creator?.firstName, creator?.lastName].filter(Boolean).join(" ");
    const creatorType = creator?.creatorType || "未知角色";
    return `${index + 1}. ${name || "（空名称）"} · ${CREATOR_ROLE_LABELS[creatorType] || creatorType}`;
  }).join("\n");
}

export function formatBatchInspectionSource(source?: BatchInspectionSource): string {
  if (!source) return "来源：未知";
  const provider = PROVIDER_LABELS[source.providerId] || source.providerId || "未知";
  return `来源：${provider}`;
}

function formatBatchTechnicalSource(source?: BatchInspectionSource): string {
  if (!source) return "来源信息不可用";
  const route = source.routeId ? (ROUTE_LABELS[source.routeId] || source.routeId) : "未知方式";
  const identifiers = source.identifiers.length
    ? source.identifiers.map((identifier) => `${identifier.type}: ${identifier.value}`).join(" · ")
    : "无标识符";
  return `获取方式：${route}\n标识符：${identifiers}`;
}

function operationCounts(batch: BatchInspectionBatch): string {
  const operations = batch.items.reduce((count, item) => count + item.operations.length, 0);
  return `${batch.items.length} 个条目 · ${operations} 项操作`;
}

function operationLabel(operation: BatchInspectionOperation): string {
  if (operation.kind === "field") return FIELD_LABELS[operation.label] || operation.label;
  if (operation.kind === "creators") return "作者与贡献者";
  return operation.label && operation.label !== "Note" ? operation.label : OPERATION_KIND_LABELS[operation.kind];
}

function buildTechnicalDetails(lines: string[]): any {
  return {
    tag: "details",
    namespace: "html",
    classList: ["zmta-technical-details"],
    children: [
      { tag: "summary", namespace: "html", properties: { textContent: "技术详情" } },
      { tag: "div", namespace: "html", classList: ["zmta-technical-content"], properties: { textContent: lines.join("\n") }, styles: { whiteSpace: "pre-wrap" } },
    ],
  };
}

function selectBatch(event: Event, selectedIndex: number, batchCount: number): void {
  const doc = (event.currentTarget as HTMLElement | null)?.ownerDocument;
  if (!doc) return;
  for (let index = 0; index < batchCount; index += 1) {
    const tab = doc.getElementById(`zmta-batch-status-tab-${index}`) as HTMLElement | null;
    const detail = doc.getElementById(`zmta-batch-status-detail-${index}`) as HTMLElement | null;
    if (tab) tab.setAttribute("aria-selected", String(index === selectedIndex));
    if (detail) detail.style.display = index === selectedIndex ? "block" : "none";
  }
}

function buildOperation(operation: BatchInspectionOperation): any {
  const hasValues = operation.kind === "field" || operation.before !== undefined || operation.after !== undefined;
  const isError = operation.status === "failed" || operation.status === "rollback-conflict";
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
          { tag: "strong", namespace: "html", properties: { textContent: operationLabel(operation) }, styles: { minWidth: "0", overflowWrap: "anywhere" } },
          { tag: "span", namespace: "html", properties: { textContent: getBatchOperationStatusLabel(operation.status) }, styles: { flex: "none", whiteSpace: "nowrap" } },
        ],
      },
      ...(hasValues ? [{
        tag: "div",
        namespace: "html",
        classList: ["zmta-status-value"],
        properties: { textContent: `${displayOperationValue(operation, operation.before)} → ${displayOperationValue(operation, operation.after)}` },
        styles: { marginTop: "4px", color: "GrayText", whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
      }] : []),
      ...(operation.message ? [{
        tag: "div",
        namespace: "html",
        classList: [isError ? "zmta-status-error" : "zmta-status-muted"],
        properties: { textContent: operation.message },
        styles: { marginTop: "4px", color: isError ? "Mark" : "GrayText", whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
      }] : []),
    ],
  };
}

function buildItem(item: BatchInspectionBatch["items"][number], showTechnicalDetails: boolean): any {
  return {
    tag: "section",
    namespace: "html",
    classList: ["zmta-status-item"],
    attributes: { "data-item-key": item.itemKey },
    styles: { marginBottom: "18px" },
    children: [
      { tag: "h3", namespace: "html", classList: ["zmta-status-title"], properties: { textContent: item.title || item.itemKey || "未命名条目" }, styles: { margin: "0 0 3px", fontSize: "15px", overflowWrap: "anywhere" } },
      { tag: "div", namespace: "html", classList: ["zmta-status-source"], properties: { textContent: formatBatchInspectionSource(item.source) }, styles: { margin: "5px 0 8px", color: "GrayText", fontSize: "12px", overflowWrap: "anywhere" } },
      ...(showTechnicalDetails
        ? [buildTechnicalDetails([`条目编号：${item.itemKey}`, formatBatchTechnicalSource(item.source)])]
        : []),
      ...(item.operations.length
        ? [{ tag: "div", namespace: "html", classList: ["zmta-status-operations"], styles: { border: "1px solid ButtonBorder", borderRadius: "7px", overflow: "hidden" }, children: item.operations.map(buildOperation) }]
        : [{ tag: "div", namespace: "html", classList: ["zmta-status-muted"], properties: { textContent: "没有操作记录" }, styles: { color: "GrayText", fontSize: "12px" } }]),
    ],
  };
}

// 返回 DialogHelper 可直接消费的声明式布局；事件只切换当前文档中的可见详情。
export function buildBatchStatusDialogLayout(
  batches: readonly BatchInspectionBatch[],
  options: BatchStatusDisplayOptions = {},
): any {
  const showTechnicalDetails = options.showTechnicalDetails === true;
  const summary = summarizeBatchStatus(batches);
  const totalOperations = summary.fields + summary.creators + summary.attachments + summary.notes;
  const tabs = batches.map((batch, index) => ({
    tag: "button",
    namespace: "html",
    classList: ["zmta-status-tab"],
    id: `zmta-batch-status-tab-${index}`,
    attributes: { type: "button", "aria-selected": String(index === 0) },
    listeners: [{ type: "click", listener: (event: Event) => selectBatch(event, index, batches.length) }],
    styles: { width: "100%", marginBottom: "4px", padding: "9px 10px", border: index === 0 ? "1px solid Highlight" : "1px solid transparent", borderRadius: "7px", backgroundColor: "transparent", color: "CanvasText", textAlign: "left", cursor: "pointer" },
    children: [
      { tag: "strong", namespace: "html", properties: { textContent: index === 0 ? "最近一次更新" : `较早记录 ${index + 1}` }, styles: { display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
      { tag: "span", namespace: "html", classList: ["zmta-status-muted"], properties: { textContent: `${getBatchStatusLabel(batch.status)} · ${batch.items.length} 个条目` }, styles: { display: "block", marginTop: "3px", color: "GrayText", fontSize: "11px" } },
    ],
  }));
  const details = batches.map((batch, index) => ({
    tag: "article",
    namespace: "html",
    id: `zmta-batch-status-detail-${index}`,
    attributes: { "data-batch-id": batch.batchId },
    styles: { display: index === 0 ? "block" : "none", padding: "20px 24px 32px", minWidth: "0" },
    children: [
      { tag: "h2", namespace: "html", classList: ["zmta-status-title"], properties: { textContent: index === 0 ? "最近一次更新" : `较早记录 ${index + 1}` }, styles: { margin: "0 0 5px", fontSize: "18px", overflowWrap: "anywhere" } },
      { tag: "div", namespace: "html", properties: { textContent: `${getBatchStatusLabel(batch.status)}${batch.incomplete ? " · 未完成" : ""}` }, styles: { marginBottom: "3px", fontWeight: "600" } },
      { tag: "div", namespace: "html", classList: ["zmta-status-muted"], properties: { textContent: operationCounts(batch) }, styles: { margin: "3px 0 18px", color: "GrayText", fontSize: "12px" } },
      ...(showTechnicalDetails
        ? [buildTechnicalDetails([`批次编号：${batch.batchId}`, `创建时间：${batch.createdAt}`, `完成时间：${batch.completedAt || "未完成"}`])]
        : []),
      ...(batch.items.length
        ? batch.items.map((item) => buildItem(item, showTechnicalDetails))
        : [{ tag: "div", namespace: "html", classList: ["zmta-status-muted"], properties: { textContent: "这个批次没有条目记录" }, styles: { color: "GrayText" } }]),
    ],
  }));

  return {
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
          { tag: "strong", namespace: "html", properties: { textContent: batches.length ? `${summary.batches} 个批次 · ${summary.incomplete} 个未完成` : "没有可查看的批次" }, styles: { display: "block", fontSize: "16px" } },
          { tag: "span", namespace: "html", classList: ["zmta-status-muted"], properties: { textContent: batches.length ? `${summary.items} 个条目 · ${totalOperations} 项操作${summary.failed + summary.rollbackConflicts ? ` · ${summary.failed + summary.rollbackConflicts} 项需处理` : ""}` : "没有更新记录" }, styles: { color: "GrayText", fontSize: "12px" } },
        ],
      },
      {
        tag: "div",
        namespace: "html",
        classList: ["zmta-status-workspace"],
        styles: { display: "grid", gridTemplateColumns: "clamp(220px, 25vw, 280px) minmax(0, 1fr)", width: "100%", minWidth: "0", minHeight: "0", boxSizing: "border-box" },
        children: [
          { tag: "nav", namespace: "html", classList: ["zmta-status-sidebar"], styles: { overflow: "auto", minWidth: "0", padding: "9px", borderRight: "1px solid ButtonBorder" }, children: tabs.length ? tabs : [{ tag: "div", namespace: "html", classList: ["zmta-status-muted"], properties: { textContent: "无批次" }, styles: { padding: "10px", color: "GrayText" } }] },
          { tag: "main", namespace: "html", classList: ["zmta-status-detail-pane"], styles: { overflow: "auto", minWidth: "0" }, children: details.length ? details : [{ tag: "div", namespace: "html", classList: ["zmta-status-muted"], properties: { textContent: "没有批次详情" }, styles: { padding: "20px 24px", color: "GrayText" } }] },
        ],
      },
      { tag: "style", namespace: "html", properties: { textContent: BATCH_STATUS_CSS } },
    ],
  };
}

export function getBatchStatusDialogOptions() {
  return { width: 980, height: 700, centerscreen: true, resizable: true, noDialogMode: true };
}

/** 打开只读状态窗口；唯一完成方式是关闭，重复按钮/窗口事件只结算一次。 */
export interface BatchStatusDialogObserver {
  /** 只供宿主机制测试观察真实 DialogHelper；生产调用不传。 */
  onOpen?(dialog: any): void;
}

export function showBatchStatusDialog(
  batches: readonly BatchInspectionBatch[],
  ztoolkit: any,
  observer: BatchStatusDialogObserver = {},
  displayOptions?: BatchStatusDisplayOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let dialog: any;
    try {
      dialog = new ztoolkit.Dialog(1, 1);
      const layout = buildBatchStatusDialogLayout(batches, {
        showTechnicalDetails: displayOptions?.showTechnicalDetails
          ?? getPref("showTechnicalDetails") === true,
      });
      layout.styles.gridColumn = "1 / -1";
      dialog.addCell(0, 0, layout, true);
    } catch (error) {
      reject(error);
      return;
    }

    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      resolve();
    };
    dialog.addButton("关闭", BATCH_STATUS_ELEMENT_IDS.close, { callback: finish });
    dialog.setDialogData({ beforeUnloadCallback: finish });
    dialog.open("批次状态", getBatchStatusDialogOptions());
    observer.onOpen?.(dialog);
  });
}
