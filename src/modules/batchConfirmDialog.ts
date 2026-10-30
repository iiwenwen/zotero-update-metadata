import { trackPluginDialog } from "./dialogLifecycle";
import { mountMetadataNavigation } from "./metadataNavigation";
import { DIALOG_STYLES, markDialogWindow } from "./dialogStyles";
import { fillCopy, type CopyEntry, type DialogCopy, type MessageId } from "./dialogCopy";
import { creatorRoleLabel, identityFieldLabel, metadataFieldLabel, metadataRouteLabel, metadataSourceLabel } from "./metadataDisplay";
// 批量审核 UI：只把预检纯数据转换为选择结果，不下载附件、不写入 Zotero。
// 纯逻辑（摘要、布局、默认值、收集）与 Dialog 生命周期分离，便于自动测试。

import type {
  BatchCreatorsCandidate,
  BatchFieldCandidate,
  BatchItemPreview,
  BatchItemSelection,
  BatchItemStatus,
} from "./batchTypes";
import { getPref } from "../utils/prefs";
import { getReviewSelectionDefaults, type ReviewSelectionDefaults } from "./reviewSelectionDefaults";

declare const Zotero: any;

export interface BatchSummary {
  total: number;
  ready: number;
  blocked: number;
  skipped: number;
  failed: number;
  fields: number;
  creators: number;
  attachments: number;
  notes: number;
}

export interface BatchSelectionSummary {
  items: number;
  fields: number;
  creators: number;
  attachments: number;
  notes: number;
}

export interface BatchDialogDisplayOptions {
  readonly showTechnicalDetails?: boolean;
  readonly initialSelections?: readonly BatchItemSelection[];
}

export interface BatchDialogLayoutOptions extends BatchDialogDisplayOptions {
  /** 纯布局使用显式快照；真实开窗由 showBatchConfirmDialog 读取偏好。 */
  readonly selectionDefaults?: Readonly<ReviewSelectionDefaults>;
}

interface BatchDialogActions {
  onRefresh?(index: number, doiOnly: boolean): void;
}

/** 条目状态在 dialogs.ftl 里的消息 id；显示文本一律由 copy 解析。 */
export const STATUS_MESSAGE_IDS: Record<BatchItemStatus, MessageId> = {
  pending: "dlg-review-status-pending",
  ready: "dlg-review-status-ready",
  blocked: "dlg-review-status-blocked",
  skipped: "dlg-review-status-skipped",
  failed: "dlg-review-status-failed",
  applied: "dlg-review-status-applied",
  partial: "dlg-review-status-partial",
  "rolled-back": "dlg-review-status-rolled-back",
  "rollback-conflict": "dlg-review-status-rollback-conflict",
};

/** 开窗时一次性解析的静态文案，避免逐条异步查询。 */
export const BATCH_REVIEW_COPY_IDS: readonly MessageId[] = Object.freeze([
  "dlg-review-title", "dlg-review-selection-help", "dlg-review-confirm", "dlg-review-empty",
  "dlg-review-nothing-to-update", "dlg-review-item-skipped", "dlg-review-refresh", "dlg-review-refresh-doi",
  "dlg-review-nav", "dlg-review-status-identity", "dlg-review-identity-check",
  "dlg-review-identity-fields-fallback", "dlg-review-identity-pending", "dlg-review-identity-confirmed",
  "dlg-review-col-accept", "dlg-review-col-field", "dlg-review-col-local", "dlg-review-col-incoming",
  "dlg-review-diff-table", "dlg-review-fill-empty", "dlg-review-creators-accept",
  "dlg-review-creators-field", "dlg-review-creators-empty", "dlg-review-creator-empty",
  "dlg-review-section-fields", "dlg-review-section-creators", "dlg-review-section-attachments",
  "dlg-review-section-notes", "dlg-review-section-creators-meta", "dlg-review-unnamed-attachment",
  "dlg-review-note-preview", "dlg-review-note-empty", "dlg-review-additions-hint",
  "dlg-review-excluded-details", "dlg-review-technical",
  "dlg-review-source-missing", "dlg-review-source-unknown", "dlg-review-source-douban",
  "dlg-common-cancel", "dlg-common-not-filled", "dlg-common-unnamed-item",
  ...Object.values(STATUS_MESSAGE_IDS),
  "dlg-review-overview", "dlg-review-selection-summary", "dlg-review-item-meta", "dlg-review-item-meta-count", "dlg-review-count", "dlg-review-identity-detail", "dlg-review-accept-field", "dlg-review-expand", "dlg-review-note-label", "dlg-review-section-fields-count", "dlg-review-excluded", "dlg-review-source",
]);


type Fill = (id: MessageId, args?: Record<string, unknown>, elementID?: string, attribute?: string) => string;

const BATCH_DIALOG_CSS = DIALOG_STYLES + `
  #zmta-batch-review {
    display: grid;
    height: 100%;
    min-height: 0;
    grid-template-rows: auto minmax(0, 1fr) auto;
    background: var(--zmta-window);
    color: var(--zmta-text);
    color-scheme: light dark;
    line-height: 1.55;
    overflow: hidden;
  }
  #zmta-batch-review, #zmta-batch-review * { box-sizing: border-box; }
  #zmta-batch-review h2, #zmta-batch-review h3, #zmta-batch-review p { margin: 0; }
  #zmta-batch-review .zmta-overview {
    display: flex; align-items: center; justify-content: space-between; gap: 20px;
    padding: 18px 24px 16px; border-bottom: 1px solid var(--zmta-line);
  }
  #zmta-batch-review .zmta-overview-title { font-size: 1.3em; font-weight: 600; }
  #zmta-batch-review .zmta-progress { color: var(--zmta-muted); font-size: .95em; }
  #zmta-batch-review .zmta-workspace { display: grid; grid-template-columns: 222px minmax(0, 1fr); min-height: 0; }
  #zmta-batch-review .zmta-workspace[data-single="true"] { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); }
  #zmta-batch-review .zmta-sidebar { padding: 16px 10px; overflow: auto; background: var(--zmta-sidebar); border-right: 1px solid var(--zmta-line); }
  #zmta-batch-review .zmta-detail-pane { min-width: 0; overflow: auto; scrollbar-gutter: stable; }
  #zmta-batch-review .zmta-detail { padding: 24px 28px 30px; min-width: 0; }
  #zmta-batch-review .zmta-detail-header { margin-bottom: 24px; }
  #zmta-batch-review .zmta-detail-title { font-size: 1.3em; line-height: 1.5; font-weight: 600; overflow-wrap: anywhere; }
  #zmta-batch-review .zmta-detail-source { display: flex; flex-wrap: wrap; gap: 4px 8px; margin-top: 5px; color: var(--zmta-muted); font-size: .95em; }
  #zmta-batch-review .zmta-technical-details { width: 100%; font-size: .95em; color: var(--zmta-muted); }
  #zmta-batch-review summary { width: fit-content; cursor: pointer; }
  #zmta-batch-review .zmta-technical-content { margin-top: 5px; overflow-wrap: anywhere; user-select: text; }
  #zmta-batch-review .zmta-section { margin: 0 0 20px; border: 0; padding: 0; }
  #zmta-batch-review .zmta-section-heading { margin-bottom: 10px; }
  #zmta-batch-review .zmta-section-title { font-size: 1em; font-weight: 600; }
  #zmta-batch-review .zmta-section-meta { margin-inline-start: 12px; color: var(--zmta-muted); font-size: .9em; }
  #zmta-batch-review .zmta-fields > .zmta-section-heading { display: none; }
  #zmta-batch-review .zmta-diff-table { width: 100%; table-layout: fixed; border-collapse: collapse; font: inherit; }
  #zmta-batch-review .zmta-check-col { width: 36px; }
  #zmta-batch-review .zmta-field-col { width: 90px; }
  #zmta-batch-review th { padding: 0 12px 9px 0; text-align: left; white-space: nowrap; font-size: .9em; font-weight: 500; color: var(--zmta-muted); border-bottom: 1px solid var(--zmta-line); }
  #zmta-batch-review td { vertical-align: top; padding: 12px 12px 12px 0; border-bottom: 1px solid var(--zmta-line); line-height: 1.7; overflow-wrap: anywhere; }
  #zmta-batch-review th:last-child, #zmta-batch-review td:last-child { padding-right: 0; }
  #zmta-batch-review .zmta-choice-cell { padding-top: 13px; }
  #zmta-batch-review .zmta-field-name { color: var(--zmta-muted); font-size: .95em; font-weight: 400; }
  #zmta-batch-review .zmta-field-hint { display: block; margin-top: 3px; color: var(--zmta-muted); font-size: .85em; }
  #zmta-batch-review .zmta-value-copy { white-space: pre-wrap; color: var(--zmta-text); }
  #zmta-batch-review .zmta-empty-value { color: var(--zmta-muted); }
  #zmta-batch-review .zmta-sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  #zmta-batch-review .zmta-mobile-label { display: none; }
  #zmta-batch-review .zmta-creators-list { padding: 0; margin: 0; list-style: none; }
  #zmta-batch-review .zmta-creators-list li + li { margin-top: 3px; }
  #zmta-batch-review .zmta-identity-review { display: grid; grid-template-columns: 20px minmax(0, 1fr); gap: 10px; padding: 13px 15px; margin-bottom: 20px; border-left: 2px solid var(--zmta-warning); background: var(--zmta-notice); }
  #zmta-batch-review .zmta-identity-description, #zmta-batch-review .zmta-identity-hint { margin-top: 5px; font-size: .95em; color: var(--zmta-muted); }
  #zmta-batch-review .zmta-candidate-row { font-size: 1em; }
  #zmta-batch-review .zmta-addition-row { display: grid; grid-template-columns: 20px minmax(0, 1fr); gap: 12px; padding: 10px 0; }
  #zmta-batch-review .zmta-addition-row strong { font-weight: 500; }
  #zmta-batch-review .zmta-note-details { grid-column: 2; color: var(--zmta-muted); font-size: .95em; }
  #zmta-batch-review .zmta-note-preview { margin-top: 7px; white-space: pre-wrap; overflow-wrap: anywhere; }
  #zmta-batch-review .zmta-addition-hint { margin-top: 10px; font-size: .9em; color: var(--zmta-muted); }
  #zmta-batch-review .zmta-empty { padding: 24px 0; color: var(--zmta-muted); }
  #zmta-batch-review .zmta-item-message { margin-top: 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
  #zmta-batch-review .zmta-footer { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 14px 22px; border-top: 1px solid var(--zmta-line); }
  #zmta-batch-review .zmta-selection-summary { font-size: 1em; font-weight: 500; }
  #zmta-batch-review .zmta-selection-help { margin-top: 2px; font-size: .9em; color: var(--zmta-muted); }
  @media (max-width: 850px) {
    #zmta-batch-review .zmta-workspace { grid-template-columns: 188px minmax(0, 1fr); }
    #zmta-batch-review .zmta-detail { padding: 20px; }
    #zmta-batch-review .zmta-field-col { width: 74px; }
  }
  @media (max-width: 760px) {
    #zmta-batch-review .zmta-overview { display: block; padding: 15px 16px; }
    #zmta-batch-review .zmta-progress { margin-top: 4px; }
    #zmta-batch-review .zmta-workspace { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
    #zmta-batch-review .zmta-sidebar { padding: 8px; border-right: 0; border-bottom: 1px solid var(--zmta-line); }
    #zmta-batch-review .zmta-detail { padding: 19px 17px; }
    #zmta-batch-review .zmta-diff-table, #zmta-batch-review tbody { display: block; }
    #zmta-batch-review colgroup, #zmta-batch-review thead { display: none; }
    #zmta-batch-review .zmta-diff-row { display: grid; grid-template-columns: 30px minmax(0, 1fr); gap: 7px 0; padding: 12px 0; border-bottom: 1px solid var(--zmta-line); }
    #zmta-batch-review td { display: block; padding: 0; border: 0; }
    #zmta-batch-review .zmta-choice-cell { grid-column: 1; grid-row: 1 / 4; padding: 0; }
    #zmta-batch-review .zmta-field-cell { grid-column: 2; grid-row: 1; }
    #zmta-batch-review .zmta-old-value { grid-column: 2; grid-row: 2; }
    #zmta-batch-review .zmta-new-value { grid-column: 2; grid-row: 3; }
    #zmta-batch-review .zmta-field-name { color: var(--zmta-text); font-weight: 500; }
    #zmta-batch-review .zmta-field-hint { display: inline; margin-left: 8px; }
    #zmta-batch-review .zmta-mobile-label { display: block; margin-bottom: 1px; font-size: .85em; color: var(--zmta-muted); }
    #zmta-batch-review .zmta-footer { flex-wrap: wrap; gap: 12px; padding: 12px 14px; }
  }
  @media (max-height: 600px) {
    #zmta-batch-review .zmta-overview { padding-block: 10px; }
    #zmta-batch-review .zmta-detail { padding-top: 16px; }
    #zmta-batch-review .zmta-footer { padding-block: 10px; }
  }
`;

function checkboxID(kind: "field" | "attachment" | "note", itemIndex: number, candidateIndex: number): string {
  return `zmta-batch-${kind}-${itemIndex}-${candidateIndex}`;
}

function creatorsCheckboxID(itemIndex: number): string {
  return `zmta-batch-creators-${itemIndex}`;
}

function identityCheckboxID(itemIndex: number): string {
  return `zmta-batch-identity-${itemIndex}`;
}

function isMissingValue(value: any): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

// 批量规则固定为：补缺默认选中，覆盖已有值默认不选中。
export function getBatchFieldDefaultChecked(candidate: BatchFieldCandidate): boolean {
  return isMissingValue(candidate.local);
}

export function summarizeBatchPreviews(previews: BatchItemPreview[]): BatchSummary {
  return previews.reduce<BatchSummary>(
    (summary, preview) => {
      summary.total += 1;
      if (preview.status === "ready") summary.ready += 1;
      if (preview.status === "blocked") summary.blocked += 1;
      if (preview.status === "skipped") summary.skipped += 1;
      if (preview.status === "failed") summary.failed += 1;
      if (preview.status === "ready") {
        summary.fields += preview.fields.length;
        summary.creators += preview.creators ? 1 : 0;
        summary.attachments += preview.attachments.length;
        summary.notes += preview.notes.length;
      }
      return summary;
    },
    { total: 0, ready: 0, blocked: 0, skipped: 0, failed: 0, fields: 0, creators: 0, attachments: 0, notes: 0 },
  );
}

export function summarizeBatchSelections(selections: BatchItemSelection[]): BatchSelectionSummary {
  return selections.reduce<BatchSelectionSummary>(
    (summary, selection) => {
      const operationCount = selection.fields.length + (selection.creators ? 1 : 0) + selection.attachments.length + selection.notes.length;
      if (operationCount > 0) summary.items += 1;
      summary.fields += selection.fields.length;
      summary.creators += selection.creators ? 1 : 0;
      summary.attachments += selection.attachments.length;
      summary.notes += selection.notes.length;
      return summary;
    },
    { items: 0, fields: 0, creators: 0, attachments: 0, notes: 0 },
  );
}

/** 页脚摘要的参数；句子本身在 dialogs.ftl，代码只负责数数。 */
export function batchSelectionSummaryArgs(summary: BatchSelectionSummary): { items: number; ops: number } {
  return { items: summary.items, ops: summary.fields + summary.creators + summary.attachments + summary.notes };
}

function getDefaultBatchSelections(previews: BatchItemPreview[], defaults: ReviewSelectionDefaults): BatchItemSelection[] {
  return previews
    .filter((preview) => preview.status === "ready" && !preview.identityReview?.required)
    .map((preview) => ({
      itemID: preview.itemID,
      itemKey: preview.itemKey,
      fields: preview.fields.filter(getBatchFieldDefaultChecked),
      creators: preview.creators?.defaultChecked ? preview.creators : undefined,
      attachments: defaults.attachments ? [...preview.attachments] : [],
      notes: defaults.notes ? [...preview.notes] : [],
      candidate: preview.candidate,
      attempts: preview.attempts,
      candidateDigest: preview.candidateDigest,
      routeId: preview.routeId,
      normalizedDOI: preview.normalizedDOI,
      identityConfirmed: false,
    }));
}

function refreshBatchSelectionSummary(previews: BatchItemPreview[], event: Event, copy: DialogCopy): void {
  const doc = (event.currentTarget as HTMLElement | null)?.ownerDocument;
  if (!doc) return;
  refreshBatchSelectionUI(previews, doc, copy);
}

/** 侧栏与条目标题下那行说明：状态词是静态文案，计数由 FTL 参数填入。 */
function itemMetaEntry(
  preview: BatchItemPreview,
  selectedCount: number,
  identityConfirmed: boolean,
  copy: DialogCopy,
): { id: MessageId; args: Record<string, unknown> } {
  const title = preview.title || preview.itemKey;
  if (preview.status !== "ready") {
    return { id: "dlg-review-item-meta", args: { title, state: copy.text(STATUS_MESSAGE_IDS[preview.status]) } };
  }
  if (preview.identityReview?.required && !identityConfirmed) {
    return { id: "dlg-review-item-meta", args: { title, state: copy.text("dlg-review-status-identity") } };
  }
  const total = preview.fields.length + (preview.creators ? 1 : 0) + preview.attachments.length + preview.notes.length;
  return { id: "dlg-review-item-meta-count", args: { title, selected: selectedCount, total } };
}

function refreshBatchSelectionUI(previews: BatchItemPreview[], doc: Document, copy: DialogCopy): void {
  const selections = collectBatchSelections(previews, doc);
  const summary = summarizeBatchSelections(selections);
  const target = doc.getElementById("zmta-batch-selection-summary");
  if (target) copy.apply(target, "dlg-review-selection-summary", batchSelectionSummaryArgs(summary));
  const confirm = doc.getElementById("zmta-batch-confirm") as HTMLButtonElement | null;
  if (confirm) confirm.disabled = summary.items === 0;
  previews.forEach((preview, itemIndex) => {
    const selection = selections.find((entry) => entry.itemID === preview.itemID);
    const selected = selection ? summarizeBatchSelections([selection]) : null;
    const count = selected ? selected.fields + selected.creators + selected.attachments + selected.notes : 0;
    const identityConfirmed = !preview.identityReview?.required || Boolean(selection?.identityConfirmed);
    const meta = doc.getElementById(`zmta-batch-item-meta-${itemIndex}`);
    if (meta) {
      const entry = itemMetaEntry(preview, count, identityConfirmed, copy);
      copy.apply(meta, entry.id, entry.args);
    }
    const hint = doc.getElementById(`zmta-batch-identity-hint-${itemIndex}`);
    if (hint) copy.apply(hint, identityConfirmed ? "dlg-review-identity-confirmed" : "dlg-review-identity-pending");
    for (const [kind, entries] of [["attachment", preview.attachments], ["note", preview.notes]] as const) {
      const selectedCount = entries.filter((_entry, index) => Boolean((doc.getElementById(checkboxID(kind, itemIndex, index)) as HTMLInputElement | null)?.checked)).length;
      const counter = doc.getElementById(`zmta-batch-${kind}-count-${itemIndex}`);
      if (counter) copy.apply(counter, "dlg-review-count", { selected: selectedCount, total: entries.length });
    }
  });
}

function batchSourceURL(preview: BatchItemPreview): string | null {
  const evidenceURL = preview.candidate?.evidence?.sourceURL;
  if (typeof evidenceURL === "string" && evidenceURL.length > 0) return evidenceURL;
  return typeof preview.sourceURL === "string" && preview.sourceURL.length > 0 ? preview.sourceURL : null;
}

function batchSourceName(preview: BatchItemPreview, sourceURL: string | null, copy: DialogCopy): string {
  const providerId = preview.candidate?.providerId;
  const known = metadataSourceLabel(providerId);
  if (known) return known;
  if (!sourceURL) return copy.text("dlg-review-source-missing");
  try {
    const hostname = new URL(sourceURL).hostname;
    return hostname === "book.douban.com" ? copy.text("dlg-review-source-douban") : hostname;
  } catch {
    return copy.text("dlg-review-source-unknown");
  }
}

function buildBatchSource(preview: BatchItemPreview, showTechnicalDetails: boolean, copy: DialogCopy, fill: Fill): any {
  const sourceURL = batchSourceURL(preview);
  const sourceName = batchSourceName(preview, sourceURL, copy);
  const routeLabel = metadataRouteLabel(preview.routeId);
  const translator = preview.candidate?.evidence?.translator;
  const translatorName = translator?.label || translator?.id;
  const fetchedAt = preview.candidate?.evidence?.fetchedAt;
  const attemptSummary = preview.attempts?.map((attempt) => {
    const diagnostic = attempt.diagnostic;
    const detail = diagnostic
      ? `（${diagnostic.stage}：${diagnostic.message}${diagnostic.httpStatus ? `，HTTP ${diagnostic.httpStatus}` : ""}）`
      : "";
    return `${attempt.routeId}: ${attempt.outcome}${detail}`;
  }).join(" → ");
  // 技术详情是给排障看的原始字段，保持宿主语言，不做用户化改写。
  const technicalLines = [
    ...(preview.candidate?.providerId ? [`来源内部编号：${preview.candidate.providerId}`] : []),
    ...(sourceURL ? [`地址：${sourceURL}`] : []),
    ...(routeLabel ? [`获取方式：${routeLabel}`] : []),
    ...(preview.normalizedDOI ? [`DOI：${preview.normalizedDOI}`] : []),
    ...(translatorName ? [`转换器：${translatorName}`] : []),
    ...(fetchedAt ? [`获取时间：${fetchedAt}`] : []),
    ...(attemptSummary ? [`尝试记录：${attemptSummary}`] : []),
  ];
  return {
    tag: "div",
    namespace: "html",
    classList: ["zmta-detail-source"],
    children: [
      { tag: "span", namespace: "html", id: fill("dlg-review-source", { source: sourceName }), properties: { textContent: "" } },
      ...(showTechnicalDetails && technicalLines.length ? [{
        tag: "details",
        namespace: "html",
        classList: ["zmta-technical-details"],
        children: [
          { tag: "summary", namespace: "html", properties: { textContent: copy.text("dlg-review-technical") } },
          { tag: "div", namespace: "html", classList: ["zmta-technical-content"], properties: { textContent: technicalLines.join("\n") }, styles: { whiteSpace: "pre-wrap" } },
        ],
      }] : []),
    ],
  };
}

function buildExcludedFieldWarnings(preview: BatchItemPreview, showTechnicalDetails: boolean, copy: DialogCopy, fill: Fill): any | null {
  if (!preview.excludedFields?.length) return null;
  return {
    tag: "div",
    namespace: "html",
    classList: ["zmta-excluded-fields"],
    attributes: { role: "note" },
    styles: {
      marginTop: "10px",
      padding: "8px 10px",
      border: "1px solid ButtonBorder",
      borderRadius: "6px",
      color: "CanvasText",
      backgroundColor: "Field",
      fontSize: "12px",
    },
    children: [
      {
        tag: "strong",
        namespace: "html",
        id: fill("dlg-review-excluded", { count: preview.excludedFields.length }),
        properties: { textContent: "" },
      },
      ...(showTechnicalDetails ? [{
        tag: "details",
        namespace: "html",
        classList: ["zmta-technical-details"],
        children: [
          { tag: "summary", namespace: "html", properties: { textContent: copy.text("dlg-review-excluded-details") } },
          { tag: "div", namespace: "html", classList: ["zmta-technical-content"], properties: { textContent: preview.excludedFields.map((entry) => entry.message).join("\n") }, styles: { whiteSpace: "pre-wrap" } },
        ],
      }] : []),
    ],
  };
}

function buildIdentityReview(
  preview: BatchItemPreview,
  itemIndex: number,
  onChange: (event: Event) => void,
  copy: DialogCopy,
  fill: Fill,
  checked = false,
): any | null {
  if (!preview.identityReview?.required) return null;
  const id = identityCheckboxID(itemIndex);
  const checkLabel = copy.text("dlg-review-identity-check");
  const matched = (preview.identityReview.matchedFields || []).map(identityFieldLabel).join("、")
    || copy.text("dlg-review-identity-fields-fallback");
  return {
    tag: "label", namespace: "html", classList: ["zmta-identity-review"], properties: { htmlFor: id },
    children: [
      { tag: "input", namespace: "html", id, attributes: { type: "checkbox", "aria-label": checkLabel }, properties: { checked }, listeners: [{ type: "change", listener: onChange }] },
      {
        tag: "span", namespace: "html", children: [
          { tag: "strong", namespace: "html", properties: { textContent: checkLabel } },
          { tag: "div", namespace: "html", classList: ["zmta-identity-description"], id: fill("dlg-review-identity-detail", { fields: matched }), properties: { textContent: "" } },
          { tag: "div", namespace: "html", id: `zmta-batch-identity-hint-${itemIndex}`, classList: ["zmta-identity-hint"], properties: { textContent: copy.text("dlg-review-identity-pending") } },
        ],
      },
    ],
  };
}

interface SectionMeta {
  /** 已解析的静态文案。 */
  readonly text?: string;
  /** 需要参数、挂载后填入的文案。 */
  readonly id?: MessageId;
  readonly args?: Record<string, unknown>;
  /** 运行中会被刷新的计数节点 id。 */
  readonly counterID?: string;
}

function buildSection(title: string, meta: SectionMeta, children: any[], options: { fields?: boolean; fill: Fill }): any {
  // 初选内容直接可见；未选分区仍可收起。只设置初始展开，不监听/改写用户选择。
  const fields = options.fields === true;
  const hasSelection = (node: any): boolean => (node.tag === "input" && node.properties?.checked === true)
    || (node.children || []).some(hasSelection);
  const metaNode: any = { tag: "span", namespace: "html", classList: ["zmta-section-meta"] };
  if (meta.id) {
    metaNode.id = options.fill(meta.id, meta.args, meta.counterID);
    metaNode.properties = { textContent: "" };
  } else {
    if (meta.counterID) metaNode.id = meta.counterID;
    metaNode.properties = { textContent: meta.text ?? "" };
  }
  return {
    tag: fields ? "section" : "details", namespace: "html", classList: ["zmta-section", ...(fields ? ["zmta-fields"] : [])],
    ...(fields ? {} : { properties: { open: children.some(hasSelection) } }),
    attributes: { "aria-label": title },
    children: [
      {
        tag: fields ? "div" : "summary", namespace: "html", classList: ["zmta-section-heading"], children: [
          { tag: "span", namespace: "html", classList: ["zmta-section-title"], properties: { textContent: title } },
          metaNode,
        ],
      },
      ...children,
    ],
  };
}

function buildDiffTable(rows: any[], copy: DialogCopy, showHeader = true): any {
  return {
    tag: "table", namespace: "html", classList: ["zmta-diff-table"], attributes: { "aria-label": copy.text("dlg-review-diff-table") },
    children: [
      {
        tag: "colgroup", namespace: "html", children: [
          { tag: "col", namespace: "html", classList: ["zmta-check-col"] },
          { tag: "col", namespace: "html", classList: ["zmta-field-col"] },
          { tag: "col", namespace: "html" }, { tag: "col", namespace: "html" },
        ],
      },
      {
        tag: "thead", namespace: "html", classList: showHeader ? [] : ["zmta-sr-only"], children: [{
          tag: "tr", namespace: "html", children: [
            copy.text("dlg-review-col-accept"),
            copy.text("dlg-review-col-field"),
            copy.text("dlg-review-col-local"),
            copy.text("dlg-review-col-incoming"),
          ].map((label) => ({
            tag: "th", namespace: "html", attributes: { scope: "col" }, properties: { textContent: label },
          })),
        }],
      },
      { tag: "tbody", namespace: "html", children: rows },
    ],
  };
}

function buildValueCell(label: string, className: string, children: any[]): any {
  return {
    tag: "td", namespace: "html", classList: [className], children: [
      { tag: "span", namespace: "html", classList: ["zmta-mobile-label"], properties: { textContent: label } },
      ...children,
    ],
  };
}

function buildFieldCandidate(
  candidate: BatchFieldCandidate,
  itemIndex: number,
  candidateIndex: number,
  onChange: (event: Event) => void,
  copy: DialogCopy,
  fill: Fill,
  checked?: boolean,
): any {
  const id = checkboxID("field", itemIndex, candidateIndex);
  const rowID = `${id}-row`;
  const label = metadataFieldLabel(candidate.field);
  const empty = copy.text("dlg-common-not-filled");
  const values = [candidate.local, candidate.incoming].map((value) => isMissingValue(value) ? empty : String(value));
  const long = candidate.field === "abstractNote" || values.some((value) => value.length > 140 || value.includes("\n"));
  fill("dlg-review-accept-field", { field: label }, id, "aria-label");
  return {
    tag: "tr", namespace: "html", id: rowID,
    classList: ["zmta-candidate-row", "zmta-diff-row", ...(long ? ["zmta-long-row"] : [])],
    children: [
      {
        tag: "td", namespace: "html", classList: ["zmta-choice-cell"], children: [{
          tag: "input", namespace: "html", id, attributes: { type: "checkbox" },
          properties: { checked: checked ?? getBatchFieldDefaultChecked(candidate) }, listeners: [{ type: "change", listener: onChange }],
        }],
      },
      {
        tag: "td", namespace: "html", classList: ["zmta-field-cell"], children: [
          { tag: "label", namespace: "html", classList: ["zmta-field-name"], properties: { htmlFor: id, textContent: label } },
          ...(isMissingValue(candidate.local) ? [{ tag: "span", namespace: "html", classList: ["zmta-field-hint"], properties: { textContent: copy.text("dlg-review-fill-empty") } }] : []),

        ],
      },
      ...values.map((text, index) => {
        const value = {
          tag: "p", namespace: "html", id: `${id}-${index ? "incoming" : "local"}`,
          classList: ["zmta-value-copy", ...(isMissingValue(index ? candidate.incoming : candidate.local) ? ["zmta-empty-value"] : [])],
          properties: { textContent: text },
        };
        return buildValueCell(index ? copy.text("dlg-review-col-incoming") : copy.text("dlg-review-col-local"), index ? "zmta-new-value" : "zmta-old-value", long ? [{
          tag: "details", namespace: "html", classList: ["zmta-long-value"], children: [
            { tag: "summary", namespace: "html", id: fill("dlg-review-expand", { preview: `${text.slice(0, 100)}${text.length > 100 ? "…" : ""}` }), properties: { textContent: "" } }, value,
          ],
        }] : [value]);
      }),
    ],
  };
}

function creatorName(creator: BatchCreatorsCandidate["incoming"][number], emptyName: string): string {
  if (typeof creator.name === "string") return creator.name || emptyName;
  const name = [creator.firstName, creator.lastName]
    .filter((part) => typeof part === "string" && part.length > 0)
    .join(" ");
  return name || emptyName;
}

function buildCreatorList(creators: BatchCreatorsCandidate["incoming"], className: string, copy: DialogCopy): any {
  const emptyName = copy.text("dlg-review-creator-empty");
  return {
    tag: "ol", namespace: "html", classList: ["zmta-creators-list", className],
    children: creators.length
      ? creators.map((creator) => ({
        tag: "li", namespace: "html", attributes: { "data-creator-type": creator.creatorType },
        properties: { textContent: `${creatorName(creator, emptyName)} · ${creatorRoleLabel(creator.creatorType)}` },
      }))
      : [{ tag: "li", namespace: "html", properties: { textContent: copy.text("dlg-review-creators-empty") } }],
  };
}

function buildCreatorsCandidate(candidate: BatchCreatorsCandidate, itemIndex: number, onChange: (event: Event) => void, copy: DialogCopy, checked?: boolean): any {
  const id = creatorsCheckboxID(itemIndex);
  return {
    tag: "tr", namespace: "html", classList: ["zmta-candidate-row", "zmta-diff-row", "zmta-creators-row"],
    children: [
      { tag: "td", namespace: "html", classList: ["zmta-choice-cell"], children: [{ tag: "input", namespace: "html", id, attributes: { type: "checkbox", "aria-label": copy.text("dlg-review-creators-accept") }, properties: { checked: checked ?? candidate.defaultChecked }, listeners: [{ type: "change", listener: onChange }] }] },
      { tag: "td", namespace: "html", classList: ["zmta-field-cell"], children: [{ tag: "label", namespace: "html", classList: ["zmta-field-name"], properties: { htmlFor: id, textContent: copy.text("dlg-review-creators-field") } }] },
      buildValueCell(copy.text("dlg-review-col-local"), "zmta-old-value", [buildCreatorList(candidate.local, "zmta-creators-local", copy)]),
      buildValueCell(copy.text("dlg-review-col-incoming"), "zmta-new-value", [buildCreatorList(candidate.incoming, "zmta-creators-incoming", copy)]),
    ],
  };
}

function buildAttachmentCandidate(candidate: any, itemIndex: number, candidateIndex: number, onChange: (event: Event) => void, copy: DialogCopy, checked: boolean): any {
  const id = checkboxID("attachment", itemIndex, candidateIndex);
  return {
    tag: "label", namespace: "html", classList: ["zmta-candidate-row", "zmta-addition-row"], properties: { htmlFor: id },
    children: [
      { tag: "input", namespace: "html", id, attributes: { type: "checkbox" }, properties: { checked }, listeners: [{ type: "change", listener: onChange }] },
      { tag: "strong", namespace: "html", properties: { textContent: String(candidate.title || copy.text("dlg-review-unnamed-attachment")) } },
    ],
  };
}

function buildNoteCandidate(
  candidate: any,
  itemIndex: number,
  candidateIndex: number,
  onChange: (event: Event) => void,
  copy: DialogCopy,
  fill: Fill,
  checked: boolean,
): any {
  const id = checkboxID("note", itemIndex, candidateIndex);
  const preview = String(candidate.content || "")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:p|div|h[1-6]|li)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    tag: "div", namespace: "html", classList: ["zmta-candidate-row", "zmta-addition-row", "zmta-note-row"],
    children: [
      { tag: "input", namespace: "html", id, attributes: { type: "checkbox" }, properties: { checked }, listeners: [{ type: "change", listener: onChange }] },
      { tag: "label", namespace: "html", id: fill("dlg-review-note-label", { index: candidateIndex + 1 }), properties: { htmlFor: id, textContent: "" } },
      {
        tag: "details", namespace: "html", classList: ["zmta-note-details"], children: [
          { tag: "summary", namespace: "html", properties: { textContent: copy.text("dlg-review-note-preview") } },
          { tag: "div", namespace: "html", classList: ["zmta-note-preview"], properties: { textContent: preview || copy.text("dlg-review-note-empty") } },
        ],
      },
    ],
  };
}

function showDetail(doc: Document, itemIndex: number, itemCount: number): void {
  if (!doc) return;
  for (let i = 0; i < itemCount; i += 1) {
    const detail = doc.getElementById(`zmta-batch-detail-${i}`) as HTMLElement | null;
    if (detail) detail.style.display = i === itemIndex ? "block" : "none";
  }
  const pane = doc.getElementById("zmta-batch-detail-pane");
  if (pane) pane.scrollTop = 0;
}

// 返回 DialogHelper 可直接消费的声明式布局；选择仅由原收集函数读取。
// 同步纯函数：静态文案由 copy.text 取，带参数的句子登记成 fills，挂载后统一填入。
export function buildBatchDialogLayout(
  previews: BatchItemPreview[],
  copy: DialogCopy,
  options: BatchDialogLayoutOptions = {},
  actions: BatchDialogActions = {},
): { layout: any; fills: CopyEntry[] } {
  const fills: CopyEntry[] = [];
  const fill: Fill = (id, args, elementID, attribute) => {
    const target = elementID ?? `zmta-review-copy-${fills.length}`;
    fills.push({ elementID: target, id, args, ...(attribute ? { attribute } : {}) });
    return target;
  };
  const showTechnicalDetails = options.showTechnicalDetails === true;
  const defaults = Object.freeze({
    attachments: options.selectionDefaults?.attachments === true,
    notes: options.selectionDefaults?.notes === true,
  });
  const summary = summarizeBatchPreviews(previews);
  const presetFor = (preview: BatchItemPreview) => options.initialSelections?.find(s => s.itemID === preview.itemID && s.itemKey === preview.itemKey && s.candidateDigest === preview.candidateDigest);
  const defaultSelections = previews.filter(p => p.status === "ready").flatMap(p => {
    const preset = presetFor(p);
    return preset ? (p.identityReview?.required && !preset.identityConfirmed ? [] : [preset]) : getDefaultBatchSelections([p], defaults);
  });
  const selectedSummary = summarizeBatchSelections(defaultSelections);
  const onSelectionChange = (event: Event) => refreshBatchSelectionSummary(previews, event, copy);
  const firstVisibleIndex = previews.findIndex((preview) => preview.status === "ready");
  const initialIndex = firstVisibleIndex >= 0 ? firstVisibleIndex : 0;

  const details = previews.map((preview, itemIndex) => {
    const preset = presetFor(preview);
    const identityReview = preview.status === "ready" ? buildIdentityReview(preview, itemIndex, onSelectionChange, copy, fill, preset?.identityConfirmed === true) : null;
    const excludedFields = buildExcludedFieldWarnings(preview, showTechnicalDetails, copy, fill);
    const attachmentCount = preset ? preset.attachments.length : defaults.attachments ? preview.attachments.length : 0;
    const noteCount = preset ? preset.notes.length : defaults.notes ? preview.notes.length : 0;
    const sections = preview.status === "ready" ? [
      ...(preview.fields.length ? [buildSection(copy.text("dlg-review-section-fields"), { id: "dlg-review-section-fields-count", args: { count: preview.fields.length } }, [buildDiffTable(preview.fields.map((candidate, candidateIndex) => buildFieldCandidate(candidate, itemIndex, candidateIndex, onSelectionChange, copy, fill, preset ? preset.fields.some(f => f.field === candidate.field) : undefined)), copy)], { fields: true, fill })] : []),
      ...(preview.creators ? [buildSection(copy.text("dlg-review-section-creators"), { text: copy.text("dlg-review-section-creators-meta") }, [buildDiffTable([buildCreatorsCandidate(preview.creators, itemIndex, onSelectionChange, copy, preset ? Boolean(preset.creators) : undefined)], copy, false)], { fill })] : []),
      ...(preview.attachments.length ? [buildSection(copy.text("dlg-review-section-attachments"), { id: "dlg-review-count", args: { selected: attachmentCount, total: preview.attachments.length }, counterID: `zmta-batch-attachment-count-${itemIndex}` }, preview.attachments.map((candidate, candidateIndex) => buildAttachmentCandidate(candidate, itemIndex, candidateIndex, onSelectionChange, copy, preset ? preset.attachments.some(a => JSON.stringify(a) === JSON.stringify(candidate)) : defaults.attachments)), { fill })] : []),
      ...(preview.notes.length ? [buildSection(copy.text("dlg-review-section-notes"), { id: "dlg-review-count", args: { selected: noteCount, total: preview.notes.length }, counterID: `zmta-batch-note-count-${itemIndex}` }, preview.notes.map((candidate, candidateIndex) => buildNoteCandidate(candidate, itemIndex, candidateIndex, onSelectionChange, copy, fill, preset ? preset.notes.some(n => JSON.stringify(n) === JSON.stringify(candidate)) : defaults.notes)), { fill })] : []),
    ] : [];
    return {
      tag: "article", namespace: "html", classList: ["zmta-detail"], id: `zmta-batch-detail-${itemIndex}`,
      styles: { display: itemIndex === initialIndex ? "block" : "none" },
      children: [
        {
          tag: "header", namespace: "html", classList: ["zmta-detail-header"], children: [
            { tag: "h2", namespace: "html", classList: ["zmta-detail-title"], properties: { textContent: preview.title || preview.itemKey } },
            ...(preview.status === "ready" || showTechnicalDetails ? [buildBatchSource(preview, showTechnicalDetails, copy, fill)] : []),
            ...(excludedFields ? [excludedFields] : []),
          ],
        },
        ...(identityReview ? [identityReview] : []),
        ...sections,
        ...(preview.status !== "ready" ? [{
          tag: "div", namespace: "html", classList: ["zmta-empty"], attributes: { role: "status" }, children: [
            { tag: "strong", namespace: "html", properties: { textContent: copy.text(STATUS_MESSAGE_IDS[preview.status]) } },
            { tag: "p", namespace: "html", classList: ["zmta-item-message"], properties: { textContent: preview.message || copy.text("dlg-review-item-skipped") } },
            ...(actions.onRefresh ? [{ tag: "button", namespace: "html", attributes: { type: "button" }, properties: { textContent: copy.text("dlg-review-refresh") }, listeners: [{ type: "click", listener: () => actions.onRefresh?.(itemIndex, false) }] },
              ...(preview.normalizedDOI ? [{ tag: "button", namespace: "html", attributes: { type: "button" }, properties: { textContent: copy.text("dlg-review-refresh-doi") }, listeners: [{ type: "click", listener: () => actions.onRefresh?.(itemIndex, true) }] }] : [])] : []),
          ],
        }] : !sections.length ? [{ tag: "div", namespace: "html", classList: ["zmta-empty"], properties: { textContent: copy.text("dlg-review-nothing-to-update") } }] : []),
        ...(preview.status === "ready" && (preview.attachments.length || preview.notes.length) ? [{
          tag: "p", namespace: "html", classList: ["zmta-addition-hint"], properties: { textContent: copy.text("dlg-review-additions-hint") },
        }] : []),
      ],
    };
  });

  const layout = {
    tag: "div", namespace: "html", classList: ["zmta-batch-review"], id: "zmta-batch-review",
    styles: { width: "100%", minWidth: "0", minHeight: "0", boxSizing: "border-box" },
    children: [
      {
        tag: "header", namespace: "html", classList: ["zmta-overview"], children: [
          { tag: "strong", namespace: "html", classList: ["zmta-overview-title"], properties: { textContent: copy.text("dlg-review-title") } },
          { tag: "div", namespace: "html", id: fill("dlg-review-overview", { total: summary.total, ready: summary.ready }), classList: ["zmta-progress"], properties: { textContent: "" } },
        ],
      },
      {
        tag: "div", namespace: "html", classList: ["zmta-workspace"], attributes: { "data-single": String(previews.length < 2) }, styles: { width: "100%", minWidth: "0", minHeight: "0", boxSizing: "border-box" },
        children: [
          { tag: "nav", namespace: "html", id: "zmta-review-navigation", classList: ["zmta-sidebar"], attributes: { "aria-label": copy.text("dlg-review-nav") }, styles: { display: previews.length < 2 ? "none" : "block" } },
          { tag: "main", namespace: "html", id: "zmta-batch-detail-pane", classList: ["zmta-detail-pane"], children: details.length ? details : [{ tag: "div", namespace: "html", classList: ["zmta-empty"], properties: { textContent: copy.text("dlg-review-empty") } }] },
        ],
      },
      {
        tag: "footer", namespace: "html", classList: ["zmta-footer"], children: [
          {
            tag: "div", namespace: "html", children: [
              { tag: "p", namespace: "html", classList: ["zmta-selection-summary"], id: fill("dlg-review-selection-summary", batchSelectionSummaryArgs(selectedSummary), "zmta-batch-selection-summary"), attributes: { "aria-live": "polite" }, properties: { textContent: "" } },
              { tag: "p", namespace: "html", classList: ["zmta-selection-help"], properties: { textContent: copy.text("dlg-review-selection-help") } },
            ],
          },

        ],
      },
      { tag: "style", namespace: "html", properties: { textContent: BATCH_DIALOG_CSS } },
    ],
  };
  return { layout, fills };
}

export function collectBatchSelections(previews: BatchItemPreview[], doc: any): BatchItemSelection[] {
  if (!doc) return [];
  return previews.reduce<BatchItemSelection[]>((selections, preview, itemIndex) => {
    if (preview.status !== "ready") return selections;
    const identityConfirmed = !preview.identityReview?.required
      || Boolean(doc.getElementById(identityCheckboxID(itemIndex))?.checked);
    if (!identityConfirmed) return selections;
    selections.push({
      itemID: preview.itemID,
      itemKey: preview.itemKey,
      fields: preview.fields.filter((_candidate, candidateIndex) => Boolean(doc.getElementById(checkboxID("field", itemIndex, candidateIndex))?.checked)),
      creators: preview.creators && doc.getElementById(creatorsCheckboxID(itemIndex))?.checked
        ? preview.creators
        : undefined,
      attachments: preview.attachments.filter((_candidate, candidateIndex) => Boolean(doc.getElementById(checkboxID("attachment", itemIndex, candidateIndex))?.checked)),
      notes: preview.notes.filter((_candidate, candidateIndex) => Boolean(doc.getElementById(checkboxID("note", itemIndex, candidateIndex))?.checked)),
      candidate: preview.candidate,
      attempts: preview.attempts,
      candidateDigest: preview.candidateDigest,
      routeId: preview.routeId,
      normalizedDOI: preview.normalizedDOI,
      identityConfirmed: preview.identityReview?.required ? true : undefined,
    });
    return selections;
  }, []);
}

export function getBatchDialogOptions() {
  return { width: 1080, height: 760, centerscreen: true, resizable: true, noDialogMode: true };
}

export interface BatchConfirmDialogObserver {
  /** 只供宿主机制测试观察真实 DialogHelper；生产调用不传。 */
  onOpen?(dialog: any): void;
  onRefresh?(preview: BatchItemPreview, doiOnly: boolean, selections: BatchItemSelection[]): void;
}

export function showBatchConfirmDialog(
  previews: BatchItemPreview[],
  ztoolkit: any,
  copy: DialogCopy,
  observer: BatchConfirmDialogObserver = {},
  displayOptions?: BatchDialogDisplayOptions,
): Promise<BatchItemSelection[] | null> {
  return new Promise((resolve) => {
    let dialog: any;
    let resolved = false;
    let owned: ReturnType<typeof trackPluginDialog> | undefined;
    let disposeNavigation = () => {};
    const finish = (confirmed: boolean, closeWindow = true) => {
      if (resolved) return;
      if (confirmed && !owned?.active()) confirmed = false;
      const selections = confirmed ? collectBatchSelections(previews, dialog?.window?.document) : null;
      if (confirmed && summarizeBatchSelections(selections || []).items === 0) return;
      resolved = true;
      owned?.release();
      try { disposeNavigation(); } catch (error) { Zotero.debug(`[zmta-ui] review navigation cleanup: ${error}`); }
      resolve(selections);
      if (closeWindow) dialog?.window?.close?.();
    };
    try {
      const selectionDefaults = getReviewSelectionDefaults();
      dialog = new ztoolkit.Dialog(1, 1);
      owned = trackPluginDialog(dialog, "zmta-batch-review", () => finish(false, false));
      if (!owned.active()) { owned.cancel(); return; }
      const { layout, fills } = buildBatchDialogLayout(previews, copy, {
        showTechnicalDetails: displayOptions?.showTechnicalDetails
          ?? getPref("showTechnicalDetails") === true,
        selectionDefaults,
        initialSelections: displayOptions?.initialSelections,
      }, {
        ...(observer.onRefresh ? { onRefresh: (index: number, doiOnly: boolean) => {
          if (resolved || !owned?.active()) return;
          const doc = dialog?.window?.document;
          const snapshot = previews.filter(p => p.status === "ready").map(p => {
            const i = previews.indexOf(p);
            return { itemID: p.itemID, itemKey: p.itemKey, candidateDigest: p.candidateDigest,
              fields: p.fields.filter((_f, j) => doc?.getElementById(checkboxID("field", i, j))?.checked),
              creators: p.creators && doc?.getElementById(creatorsCheckboxID(i))?.checked ? p.creators : undefined,
              attachments: p.attachments.filter((_a, j) => doc?.getElementById(checkboxID("attachment", i, j))?.checked),
              notes: p.notes.filter((_n, j) => doc?.getElementById(checkboxID("note", i, j))?.checked),
              identityConfirmed: Boolean(doc?.getElementById(identityCheckboxID(i))?.checked),
            };
          });
          observer.onRefresh!(previews[index], doiOnly, snapshot);
          finish(false);
        } } : {}),
      });
      layout.styles.gridColumn = "1 / -1";
      dialog.addCell(0, 0, layout, true);
      dialog.addButton(copy.text("dlg-common-cancel"), "zmta-batch-cancel", { noClose: true, callback: () => finish(false) });
      dialog.addButton(copy.text("dlg-review-confirm"), "zmta-batch-confirm", { noClose: true, callback: () => finish(true) });
      dialog.setDialogData({
        loadCallback: () => {
          if (!owned?.attach()) return;
          markDialogWindow(dialog);
          const doc = dialog.window.document;
          doc.documentElement?.classList?.add("zmta-review-window");
          const firstReady = Math.max(0, previews.findIndex(p => p.status === "ready"));
          const key = (p: BatchItemPreview) => `${p.itemID}:${p.itemKey}`;
          disposeNavigation = mountMetadataNavigation(dialog.window, "zmta-review-navigation", previews.map((p, i) => ({
            key: key(p), label: `${p.title || p.itemKey} · ${copy.text(STATUS_MESSAGE_IDS[p.status])}`, optionID: `zmta-batch-item-meta-${i}`,
          })), previews[firstReady] ? key(previews[firstReady]) : "", selectedKey => {
            const index = previews.findIndex(p => key(p) === selectedKey);
            if (index >= 0) showDetail(doc, index, previews.length);
          });
          fillCopy(doc, copy, fills);
          refreshBatchSelectionUI(previews, doc, copy);
          dialog.window.addEventListener?.("keydown", (event: any) => {
            if (event.key === "Escape") { event.preventDefault(); finish(false); }
          });
        },
        beforeUnloadCallback: () => finish(false, false),
      });
      dialog.open(copy.text("dlg-review-title"), getBatchDialogOptions());
      owned.attach();
      observer.onOpen?.(dialog);
    } catch (error) {
      Zotero.debug(`[zmta-batch-dialog] Dialog 创建失败: ${error}`);
      finish(false);
    }
  });
}
