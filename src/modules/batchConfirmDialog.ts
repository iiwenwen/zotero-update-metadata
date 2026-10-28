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
}

export interface BatchDialogLayoutOptions extends BatchDialogDisplayOptions {
  /** 纯布局使用显式快照；真实开窗由 showBatchConfirmDialog 读取偏好。 */
  readonly selectionDefaults?: Readonly<ReviewSelectionDefaults>;
}

interface BatchDialogActions {
  onConfirm?(): void;
  onCancel?(): void;
}

const STATUS_LABELS: Record<BatchItemStatus, string> = {
  pending: "预检中",
  ready: "可更新",
  blocked: "已阻断",
  skipped: "跳过",
  failed: "预检失败",
  applied: "已应用",
  partial: "部分成功",
  "rolled-back": "已撤销",
  "rollback-conflict": "回滚冲突",
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

const BATCH_DIALOG_CSS = `
  .zmta-review-window body { margin: 0; padding: 0; height: 100vh; overflow: hidden; }
  .zmta-review-window #zmta-batch-review { height: 100vh; }
  #zmta-batch-review {
    --zmta-window: #ffffff;
    --zmta-sidebar: #f6f7f8;
    --zmta-line: #e6e8eb;
    --zmta-text: #20242b;
    --zmta-muted: #68717d;
    --zmta-hover: #f5f7fa;
    --zmta-accent: #2463c5;
    --zmta-button-text: #ffffff;
    --zmta-selection: #e9f0fc;
    --zmta-warning: #8a561b;
    --zmta-danger: #a73d3d;
    --zmta-notice: #faf6ed;
    display: grid;
    height: 100%;
    min-height: 0;
    grid-template-rows: auto minmax(0, 1fr) auto;
    background: var(--zmta-window);
    color: var(--zmta-text);
    color-scheme: light dark;
    font: 13px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    overflow: hidden;
  }
  @media (prefers-color-scheme: dark) {
    #zmta-batch-review {
      --zmta-window: #25272b;
      --zmta-sidebar: #212327;
      --zmta-line: #393c42;
      --zmta-text: #e6e8ec;
      --zmta-muted: #a8afb9;
      --zmta-hover: #2d3036;
      --zmta-accent: #8ab4fa;
      --zmta-button-text: #17243c;
      --zmta-selection: #303e55;
      --zmta-warning: #e0b778;
      --zmta-danger: #ed9c9c;
      --zmta-notice: #342f26;
    }
  }
  #zmta-batch-review, #zmta-batch-review * { box-sizing: border-box; }
  #zmta-batch-review h2, #zmta-batch-review h3, #zmta-batch-review p { margin: 0; }
  #zmta-batch-review button { font: inherit; color: inherit; cursor: pointer; }
  #zmta-batch-review button:disabled { opacity: .45; cursor: default; }
  #zmta-batch-review button:focus-visible,
  #zmta-batch-review input:focus-visible,
  #zmta-batch-review summary:focus-visible { outline: 2px solid var(--zmta-accent); outline-offset: 3px; }
  #zmta-batch-review input[type="checkbox"] { width: 16px; height: 16px; margin: 3px 0; accent-color: var(--zmta-accent); }
  #zmta-batch-review .zmta-overview {
    display: flex; align-items: center; justify-content: space-between; gap: 20px;
    padding: 18px 24px 16px; border-bottom: 1px solid var(--zmta-line);
  }
  #zmta-batch-review .zmta-overview-title { font-size: 18px; font-weight: 600; }
  #zmta-batch-review .zmta-progress { color: var(--zmta-muted); font-size: 12px; }
  #zmta-batch-review .zmta-workspace { display: grid; grid-template-columns: 222px minmax(0, 1fr); min-height: 0; }
  #zmta-batch-review .zmta-sidebar { padding: 16px 10px; overflow: auto; background: var(--zmta-sidebar); border-right: 1px solid var(--zmta-line); }
  #zmta-batch-review .zmta-item { appearance: none; display: block; width: 100%; height: auto; min-height: 0; max-height: none; padding: 11px 10px; margin: 0 0 3px; text-align: left; border: 0; border-radius: 5px; background: transparent; line-height: 1.55; }
  #zmta-batch-review .zmta-item:hover { background: var(--zmta-hover); }
  #zmta-batch-review .zmta-item[aria-current="true"] { background: var(--zmta-selection); }
  #zmta-batch-review .zmta-item-title { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 13px; font-weight: 500; line-height: 1.55; }
  #zmta-batch-review .zmta-item-meta { display: block; color: var(--zmta-muted); margin-top: 4px; font-size: 11px; }
  #zmta-batch-review [data-status="blocked"] .zmta-item-meta,
  #zmta-batch-review [data-status="partial"] .zmta-item-meta,
  #zmta-batch-review [data-status="rollback-conflict"] .zmta-item-meta,
  #zmta-batch-review [data-identity-pending="true"] .zmta-item-meta { color: var(--zmta-warning); }
  #zmta-batch-review [data-status="failed"] .zmta-item-meta { color: var(--zmta-danger); }
  #zmta-batch-review .zmta-detail-pane { min-width: 0; overflow: auto; scrollbar-gutter: stable; }
  #zmta-batch-review .zmta-detail { padding: 24px 28px 30px; min-width: 0; }
  #zmta-batch-review .zmta-detail-header { margin-bottom: 24px; }
  #zmta-batch-review .zmta-detail-title { font-size: 18px; line-height: 1.5; font-weight: 600; overflow-wrap: anywhere; }
  #zmta-batch-review .zmta-detail-source { display: flex; flex-wrap: wrap; gap: 4px 8px; margin-top: 5px; color: var(--zmta-muted); font-size: 12px; }
  #zmta-batch-review .zmta-technical-details { width: 100%; font-size: 12px; color: var(--zmta-muted); }
  #zmta-batch-review summary { width: fit-content; cursor: pointer; }
  #zmta-batch-review .zmta-technical-content { margin-top: 5px; overflow-wrap: anywhere; user-select: text; }
  #zmta-batch-review .zmta-section { margin: 0 0 20px; border: 0; padding: 0; }
  #zmta-batch-review .zmta-section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 10px; }
  #zmta-batch-review .zmta-section-title { font-size: 13px; font-weight: 600; }
  #zmta-batch-review .zmta-section-meta { color: var(--zmta-muted); font-size: 11px; }
  #zmta-batch-review .zmta-fields > .zmta-section-heading { display: none; }
  #zmta-batch-review .zmta-diff-table { width: 100%; table-layout: fixed; border-collapse: collapse; font: inherit; }
  #zmta-batch-review .zmta-check-col { width: 36px; }
  #zmta-batch-review .zmta-field-col { width: 90px; }
  #zmta-batch-review th { padding: 0 12px 9px 0; text-align: left; white-space: nowrap; font-size: 11px; font-weight: 500; color: var(--zmta-muted); border-bottom: 1px solid var(--zmta-line); }
  #zmta-batch-review td { vertical-align: top; padding: 12px 12px 12px 0; border-bottom: 1px solid var(--zmta-line); line-height: 1.7; overflow-wrap: anywhere; }
  #zmta-batch-review th:last-child, #zmta-batch-review td:last-child { padding-right: 0; }
  #zmta-batch-review .zmta-choice-cell { padding-top: 13px; }
  #zmta-batch-review .zmta-field-name { color: var(--zmta-muted); font-size: 12px; font-weight: 400; }
  #zmta-batch-review .zmta-field-hint { display: block; margin-top: 3px; color: var(--zmta-muted); font-size: 10px; }
  #zmta-batch-review .zmta-value-copy { white-space: pre-wrap; color: var(--zmta-text); }
  #zmta-batch-review .zmta-empty-value { color: var(--zmta-muted); }
  #zmta-batch-review .zmta-long-row:not(.zmta-expanded) .zmta-value-copy { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }
  #zmta-batch-review .zmta-expand { appearance: none; display: block; min-width: 0; height: auto; min-height: 0; max-height: none; padding: 0; margin-top: 7px; border: 0; background: transparent; font-size: 12px; color: var(--zmta-accent); text-align: left; }
  #zmta-batch-review .zmta-sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  #zmta-batch-review .zmta-mobile-label { display: none; }
  #zmta-batch-review .zmta-creators-list { padding: 0; margin: 0; list-style: none; }
  #zmta-batch-review .zmta-creators-list li + li { margin-top: 3px; }
  #zmta-batch-review .zmta-identity-review { display: grid; grid-template-columns: 20px minmax(0, 1fr); gap: 10px; padding: 13px 15px; margin-bottom: 20px; border-left: 2px solid var(--zmta-warning); background: var(--zmta-notice); }
  #zmta-batch-review .zmta-identity-description, #zmta-batch-review .zmta-identity-hint { margin-top: 5px; font-size: 12px; color: var(--zmta-muted); }
  #zmta-batch-review .zmta-candidate-row { font-size: 13px; }
  #zmta-batch-review .zmta-addition-row { display: grid; grid-template-columns: 20px minmax(0, 1fr); gap: 12px; padding: 10px 0; }
  #zmta-batch-review .zmta-addition-row strong { font-weight: 500; }
  #zmta-batch-review .zmta-note-details { grid-column: 2; color: var(--zmta-muted); font-size: 12px; }
  #zmta-batch-review .zmta-note-preview { margin-top: 7px; white-space: pre-wrap; overflow-wrap: anywhere; }
  #zmta-batch-review .zmta-addition-hint { margin-top: 10px; font-size: 11px; color: var(--zmta-muted); }
  #zmta-batch-review .zmta-empty { padding: 24px 0; color: var(--zmta-muted); }
  #zmta-batch-review .zmta-item-message { margin-top: 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
  #zmta-batch-review .zmta-footer { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 14px 22px; border-top: 1px solid var(--zmta-line); }
  #zmta-batch-review .zmta-selection-summary { font-size: 13px; font-weight: 500; }
  #zmta-batch-review .zmta-selection-help { margin-top: 2px; font-size: 11px; color: var(--zmta-muted); }
  #zmta-batch-review .zmta-footer-actions { display: flex; gap: 9px; }
  #zmta-batch-review .zmta-action { appearance: none; min-height: 34px; max-height: none; padding: 7px 16px; border: 1px solid var(--zmta-line); border-radius: 5px; background: var(--zmta-window); font-size: 12px; font-weight: 500; white-space: nowrap; }
  #zmta-batch-review .zmta-action:hover:not(:disabled) { background: var(--zmta-hover); }
  #zmta-batch-review #zmta-batch-confirm { background: var(--zmta-accent); border-color: var(--zmta-accent); color: var(--zmta-button-text); }
  @media (max-width: 850px) {
    #zmta-batch-review .zmta-workspace { grid-template-columns: 188px minmax(0, 1fr); }
    #zmta-batch-review .zmta-detail { padding: 20px; }
    #zmta-batch-review .zmta-field-col { width: 74px; }
  }
  @media (max-width: 760px) {
    #zmta-batch-review .zmta-overview { display: block; padding: 15px 16px; }
    #zmta-batch-review .zmta-progress { margin-top: 4px; }
    #zmta-batch-review .zmta-workspace { grid-template-columns: minmax(0, 1fr); grid-template-rows: 112px minmax(0, 1fr); }
    #zmta-batch-review .zmta-sidebar { display: flex; gap: 5px; padding: 8px; overflow-x: auto; overflow-y: hidden; border-right: 0; border-bottom: 1px solid var(--zmta-line); }
    #zmta-batch-review .zmta-item { flex: 0 0 190px; height: 80px; margin: 0; padding: 9px; }
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
    #zmta-batch-review .zmta-expand { display: inline-block; margin: 0 0 0 10px; }
    #zmta-batch-review .zmta-mobile-label { display: block; margin-bottom: 1px; font-size: 10px; color: var(--zmta-muted); }
    #zmta-batch-review .zmta-footer { flex-wrap: wrap; gap: 12px; padding: 12px 14px; }
    #zmta-batch-review .zmta-footer-actions { margin-left: auto; }
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

export function formatBatchSelectionSummary(summary: BatchSelectionSummary): string {
  const operations = summary.fields + summary.creators + summary.attachments + summary.notes;
  return `已选择 ${summary.items} 个条目 · ${operations} 项更新`;
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

function refreshBatchSelectionSummary(previews: BatchItemPreview[], event: Event): void {
  const doc = (event.currentTarget as HTMLElement | null)?.ownerDocument;
  if (!doc) return;
  refreshBatchSelectionUI(previews, doc);
}

function batchItemMeta(preview: BatchItemPreview, selectedCount: number, identityConfirmed: boolean): string {
  if (preview.status !== "ready") return STATUS_LABELS[preview.status];
  if (preview.identityReview?.required && !identityConfirmed) return "待确认身份";
  const total = preview.fields.length + (preview.creators ? 1 : 0) + preview.attachments.length + preview.notes.length;
  return `已选 ${selectedCount} / ${total} 项`;
}

function refreshBatchSelectionUI(previews: BatchItemPreview[], doc: Document): void {
  const selections = collectBatchSelections(previews, doc);
  const summary = summarizeBatchSelections(selections);
  const target = doc.getElementById("zmta-batch-selection-summary");
  if (target) target.textContent = formatBatchSelectionSummary(summary);
  const confirm = doc.getElementById("zmta-batch-confirm") as HTMLButtonElement | null;
  if (confirm) confirm.disabled = summary.items === 0;
  previews.forEach((preview, itemIndex) => {
    const selection = selections.find((entry) => entry.itemID === preview.itemID);
    const selected = selection ? summarizeBatchSelections([selection]) : null;
    const count = selected ? selected.fields + selected.creators + selected.attachments + selected.notes : 0;
    const identityConfirmed = !preview.identityReview?.required || Boolean(selection?.identityConfirmed);
    const meta = doc.getElementById(`zmta-batch-item-meta-${itemIndex}`);
    if (meta) meta.textContent = batchItemMeta(preview, count, identityConfirmed);
    doc.getElementById(`zmta-batch-item-${itemIndex}`)?.setAttribute?.("data-identity-pending", String(!identityConfirmed));
    const hint = doc.getElementById(`zmta-batch-identity-hint-${itemIndex}`);
    if (hint) hint.textContent = identityConfirmed
      ? "身份已确认，本条目勾选内容已纳入更新。"
      : "确认前，本条目的勾选内容不会纳入更新。";
    for (const [kind, entries] of [["attachment", preview.attachments], ["note", preview.notes]] as const) {
      const selectedCount = entries.filter((_entry, index) => Boolean((doc.getElementById(checkboxID(kind, itemIndex, index)) as HTMLInputElement | null)?.checked)).length;
      const counter = doc.getElementById(`zmta-batch-${kind}-count-${itemIndex}`);
      if (counter) counter.textContent = `已选 ${selectedCount} / ${entries.length} 项`;
    }
  });
}

function batchSourceURL(preview: BatchItemPreview): string | null {
  const evidenceURL = preview.candidate?.evidence?.sourceURL;
  if (typeof evidenceURL === "string" && evidenceURL.length > 0) return evidenceURL;
  return typeof preview.sourceURL === "string" && preview.sourceURL.length > 0 ? preview.sourceURL : null;
}

function batchSourceName(preview: BatchItemPreview, sourceURL: string | null): string {
  const providerId = preview.candidate?.providerId;
  if (providerId === "douban") return "豆瓣读书";
  if (typeof providerId === "string" && providerId.length > 0) return providerId;
  if (!sourceURL) return "未提供";
  try {
    const hostname = new URL(sourceURL).hostname;
    return hostname === "book.douban.com" ? "豆瓣读书" : hostname;
  } catch {
    return "未知来源";
  }
}

function buildBatchSource(preview: BatchItemPreview, showTechnicalDetails: boolean): any {
  const sourceURL = batchSourceURL(preview);
  const sourceName = batchSourceName(preview, sourceURL);
  const routeLabel = preview.routeId === "doi.search"
    ? "DOI 检索"
    : preview.routeId === "url.web" ? "网页获取" : preview.routeId;
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
  const technicalLines = [
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
      { tag: "span", namespace: "html", properties: { textContent: `来源：${sourceName}` } },
      ...(showTechnicalDetails && technicalLines.length ? [{
        tag: "details",
        namespace: "html",
        classList: ["zmta-technical-details"],
        children: [
          { tag: "summary", namespace: "html", properties: { textContent: "技术详情" } },
          { tag: "div", namespace: "html", classList: ["zmta-technical-content"], properties: { textContent: technicalLines.join("\n") }, styles: { whiteSpace: "pre-wrap" } },
        ],
      }] : []),
    ],
  };
}

function buildExcludedFieldWarnings(preview: BatchItemPreview, showTechnicalDetails: boolean): any | null {
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
        properties: { textContent: `已忽略 ${preview.excludedFields.length} 个不适用字段` },
      },
      ...(showTechnicalDetails ? [{
        tag: "details",
        namespace: "html",
        classList: ["zmta-technical-details"],
        children: [
          { tag: "summary", namespace: "html", properties: { textContent: "查看详情" } },
          { tag: "div", namespace: "html", classList: ["zmta-technical-content"], properties: { textContent: preview.excludedFields.map((entry) => entry.message).join("\n") }, styles: { whiteSpace: "pre-wrap" } },
        ],
      }] : []),
    ],
  };
}

function buildIdentityReview(preview: BatchItemPreview, itemIndex: number, onChange: (event: Event) => void): any | null {
  if (!preview.identityReview?.required) return null;
  const id = identityCheckboxID(itemIndex);
  return {
    tag: "label", namespace: "html", classList: ["zmta-identity-review"], properties: { htmlFor: id },
    children: [
      { tag: "input", namespace: "html", id, attributes: { type: "checkbox", "aria-label": "确认候选与本地条目是同一作品" }, properties: { checked: false }, listeners: [{ type: "change", listener: onChange }] },
      {
        tag: "span", namespace: "html", children: [
          { tag: "strong", namespace: "html", properties: { textContent: "确认候选与本地条目是同一作品" } },
          { tag: "div", namespace: "html", classList: ["zmta-identity-description"], properties: { textContent: preview.identityReview.summary } },
          { tag: "div", namespace: "html", id: `zmta-batch-identity-hint-${itemIndex}`, classList: ["zmta-identity-hint"], properties: { textContent: "确认前，本条目的勾选内容不会纳入更新。" } },
        ],
      },
    ],
  };
}

function buildSection(title: string, description: string, children: any[], counterID?: string): any {
  return {
    tag: "section", namespace: "html", classList: ["zmta-section", ...(title === "字段" ? ["zmta-fields"] : [])],
    attributes: { "aria-label": title },
    children: [
      {
        tag: "div", namespace: "html", classList: ["zmta-section-heading"], children: [
          { tag: "h3", namespace: "html", classList: ["zmta-section-title"], properties: { textContent: title } },
          { tag: "span", namespace: "html", ...(counterID ? { id: counterID } : {}), classList: ["zmta-section-meta"], properties: { textContent: description } },
        ],
      },
      ...children,
    ],
  };
}

function buildDiffTable(rows: any[], showHeader = true): any {
  return {
    tag: "table", namespace: "html", classList: ["zmta-diff-table"], attributes: { "aria-label": "当前值与上游值对比" },
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
          tag: "tr", namespace: "html", children: ["采用", "字段", "当前值", "上游值"].map((label) => ({
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

function buildFieldCandidate(candidate: BatchFieldCandidate, itemIndex: number, candidateIndex: number, onChange: (event: Event) => void): any {
  const id = checkboxID("field", itemIndex, candidateIndex);
  const rowID = `${id}-row`;
  const label = FIELD_LABELS[candidate.field] || candidate.field;
  const values = [candidate.local, candidate.incoming].map((value) => isMissingValue(value) ? "未填写" : String(value));
  const long = candidate.field === "abstractNote" || values.some((value) => value.length > 140 || value.includes("\n"));
  return {
    tag: "tr", namespace: "html", id: rowID,
    classList: ["zmta-candidate-row", "zmta-diff-row", ...(long ? ["zmta-long-row"] : [])],
    children: [
      {
        tag: "td", namespace: "html", classList: ["zmta-choice-cell"], children: [{
          tag: "input", namespace: "html", id, attributes: { type: "checkbox", "aria-label": `采用上游${label}` },
          properties: { checked: getBatchFieldDefaultChecked(candidate) }, listeners: [{ type: "change", listener: onChange }],
        }],
      },
      {
        tag: "td", namespace: "html", classList: ["zmta-field-cell"], children: [
          { tag: "label", namespace: "html", classList: ["zmta-field-name"], properties: { htmlFor: id, textContent: label } },
          ...(isMissingValue(candidate.local) ? [{ tag: "span", namespace: "html", classList: ["zmta-field-hint"], properties: { textContent: "补充缺失" } }] : []),
          ...(long ? [{
            tag: "button", namespace: "html", classList: ["zmta-expand"], attributes: { type: "button", "aria-expanded": "false", "aria-controls": `${id}-local ${id}-incoming` },
            properties: { textContent: "展开全文" }, listeners: [{ type: "click", listener: (event: Event) => {
              const button = event.currentTarget as HTMLButtonElement;
              const row = button.ownerDocument.getElementById(rowID);
              if (!row) return;
              const expanded = row.classList.toggle("zmta-expanded");
              button.setAttribute("aria-expanded", String(expanded));
              button.textContent = expanded ? "收起全文" : "展开全文";
            } }],
          }] : []),
        ],
      },
      ...values.map((text, index) => buildValueCell(index ? "上游值" : "当前值", index ? "zmta-new-value" : "zmta-old-value", [{
        tag: "p", namespace: "html", id: `${id}-${index ? "incoming" : "local"}`,
        classList: ["zmta-value-copy", ...(isMissingValue(index ? candidate.incoming : candidate.local) ? ["zmta-empty-value"] : [])],
        properties: { textContent: text },
      }])),
    ],
  };
}

function creatorName(creator: BatchCreatorsCandidate["incoming"][number]): string {
  if (typeof creator.name === "string") return creator.name || "（空名称）";
  const name = [creator.firstName, creator.lastName]
    .filter((part) => typeof part === "string" && part.length > 0)
    .join(" ");
  return name || "（空名称）";
}

function creatorRole(creatorType: string): string {
  return CREATOR_ROLE_LABELS[creatorType] || creatorType;
}

function buildCreatorList(creators: BatchCreatorsCandidate["incoming"], className: string): any {
  return {
    tag: "ol", namespace: "html", classList: ["zmta-creators-list", className],
    children: creators.length
      ? creators.map((creator) => ({
        tag: "li", namespace: "html", attributes: { "data-creator-type": creator.creatorType },
        properties: { textContent: `${creatorName(creator)} · ${creatorRole(creator.creatorType)}` },
      }))
      : [{ tag: "li", namespace: "html", properties: { textContent: "（空列表）" } }],
  };
}

function buildCreatorsCandidate(candidate: BatchCreatorsCandidate, itemIndex: number, onChange: (event: Event) => void): any {
  const id = creatorsCheckboxID(itemIndex);
  return {
    tag: "tr", namespace: "html", classList: ["zmta-candidate-row", "zmta-diff-row", "zmta-creators-row"],
    children: [
      { tag: "td", namespace: "html", classList: ["zmta-choice-cell"], children: [{ tag: "input", namespace: "html", id, attributes: { type: "checkbox", "aria-label": "采用上游作者与贡献者整组列表" }, properties: { checked: candidate.defaultChecked }, listeners: [{ type: "change", listener: onChange }] }] },
      { tag: "td", namespace: "html", classList: ["zmta-field-cell"], children: [{ tag: "label", namespace: "html", classList: ["zmta-field-name"], properties: { htmlFor: id, textContent: "完整列表" } }] },
      buildValueCell("当前值", "zmta-old-value", [buildCreatorList(candidate.local, "zmta-creators-local")]),
      buildValueCell("上游值", "zmta-new-value", [buildCreatorList(candidate.incoming, "zmta-creators-incoming")]),
    ],
  };
}

function buildAttachmentCandidate(candidate: any, itemIndex: number, candidateIndex: number, onChange: (event: Event) => void, checked: boolean): any {
  const id = checkboxID("attachment", itemIndex, candidateIndex);
  return {
    tag: "label", namespace: "html", classList: ["zmta-candidate-row", "zmta-addition-row"], properties: { htmlFor: id },
    children: [
      { tag: "input", namespace: "html", id, attributes: { type: "checkbox" }, properties: { checked }, listeners: [{ type: "change", listener: onChange }] },
      { tag: "strong", namespace: "html", properties: { textContent: String(candidate.title || "未命名附件") } },
    ],
  };
}

function buildNoteCandidate(candidate: any, itemIndex: number, candidateIndex: number, onChange: (event: Event) => void, checked: boolean): any {
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
      { tag: "label", namespace: "html", properties: { htmlFor: id, textContent: `笔记 ${candidateIndex + 1}` } },
      {
        tag: "details", namespace: "html", classList: ["zmta-note-details"], children: [
          { tag: "summary", namespace: "html", properties: { textContent: "预览笔记" } },
          { tag: "div", namespace: "html", classList: ["zmta-note-preview"], properties: { textContent: preview || "（空笔记）" } },
        ],
      },
    ],
  };
}

function showDetail(event: Event, itemIndex: number, itemCount: number): void {
  const doc = (event.currentTarget as HTMLElement | null)?.ownerDocument;
  if (!doc) return;
  for (let i = 0; i < itemCount; i += 1) {
    const detail = doc.getElementById(`zmta-batch-detail-${i}`) as HTMLElement | null;
    const tab = doc.getElementById(`zmta-batch-item-${i}`);
    if (detail) detail.style.display = i === itemIndex ? "block" : "none";
    tab?.setAttribute("aria-current", String(i === itemIndex));
  }
  const pane = doc.getElementById("zmta-batch-detail-pane");
  if (pane) pane.scrollTop = 0;
}

// 返回 DialogHelper 可直接消费的声明式布局；选择仅由原收集函数读取。
export function buildBatchDialogLayout(
  previews: BatchItemPreview[],
  options: BatchDialogLayoutOptions = {},
  actions: BatchDialogActions = {},
): any {
  const showTechnicalDetails = options.showTechnicalDetails === true;
  const defaults = Object.freeze({
    attachments: options.selectionDefaults?.attachments === true,
    notes: options.selectionDefaults?.notes === true,
  });
  const summary = summarizeBatchPreviews(previews);
  const defaultSelections = getDefaultBatchSelections(previews, defaults);
  const selectedSummary = summarizeBatchSelections(defaultSelections);
  const onSelectionChange = (event: Event) => refreshBatchSelectionSummary(previews, event);
  const firstVisibleIndex = previews.findIndex((preview) => preview.status === "ready");
  const initialIndex = firstVisibleIndex >= 0 ? firstVisibleIndex : 0;
  const itemTabs = previews.map((preview, itemIndex) => {
    const selected = defaultSelections.find((entry) => entry.itemID === preview.itemID);
    const count = selected ? selected.fields.length + (selected.creators ? 1 : 0) + selected.attachments.length + selected.notes.length : 0;
    return {
      tag: "button", namespace: "html", classList: ["zmta-item"], id: `zmta-batch-item-${itemIndex}`,
      attributes: { type: "button", "aria-current": String(itemIndex === initialIndex), "data-status": preview.status, "data-identity-pending": String(Boolean(preview.identityReview?.required)) },
      properties: { title: preview.title || preview.itemKey },
      listeners: [{ type: "click", listener: (event: Event) => showDetail(event, itemIndex, previews.length) }],
      children: [
        { tag: "span", namespace: "html", classList: ["zmta-item-title"], properties: { textContent: preview.title || preview.itemKey } },
        { tag: "span", namespace: "html", classList: ["zmta-item-meta"], id: `zmta-batch-item-meta-${itemIndex}`, properties: { textContent: batchItemMeta(preview, count, false) } },
      ],
    };
  });

  const details = previews.map((preview, itemIndex) => {
    const identityReview = preview.status === "ready" ? buildIdentityReview(preview, itemIndex, onSelectionChange) : null;
    const excludedFields = buildExcludedFieldWarnings(preview, showTechnicalDetails);
    const sections = preview.status === "ready" ? [
      ...(preview.fields.length ? [buildSection("字段", `${preview.fields.length} 项`, [buildDiffTable(preview.fields.map((candidate, candidateIndex) => buildFieldCandidate(candidate, itemIndex, candidateIndex, onSelectionChange)))])] : []),
      ...(preview.creators ? [buildSection("作者与贡献者", "整组选择", [buildDiffTable([buildCreatorsCandidate(preview.creators, itemIndex, onSelectionChange)], false)])] : []),
      ...(preview.attachments.length ? [buildSection("新增附件", `已选 ${defaults.attachments ? preview.attachments.length : 0} / ${preview.attachments.length} 项`, preview.attachments.map((candidate, candidateIndex) => buildAttachmentCandidate(candidate, itemIndex, candidateIndex, onSelectionChange, defaults.attachments)), `zmta-batch-attachment-count-${itemIndex}`)] : []),
      ...(preview.notes.length ? [buildSection("新增笔记", `已选 ${defaults.notes ? preview.notes.length : 0} / ${preview.notes.length} 项`, preview.notes.map((candidate, candidateIndex) => buildNoteCandidate(candidate, itemIndex, candidateIndex, onSelectionChange, defaults.notes)), `zmta-batch-note-count-${itemIndex}`)] : []),
    ] : [];
    return {
      tag: "article", namespace: "html", classList: ["zmta-detail"], id: `zmta-batch-detail-${itemIndex}`,
      styles: { display: itemIndex === initialIndex ? "block" : "none" },
      children: [
        {
          tag: "header", namespace: "html", classList: ["zmta-detail-header"], children: [
            { tag: "h2", namespace: "html", classList: ["zmta-detail-title"], properties: { textContent: preview.title || preview.itemKey } },
            ...(preview.status === "ready" || showTechnicalDetails ? [buildBatchSource(preview, showTechnicalDetails)] : []),
            ...(excludedFields ? [excludedFields] : []),
          ],
        },
        ...(identityReview ? [identityReview] : []),
        ...sections,
        ...(preview.status !== "ready" ? [{
          tag: "div", namespace: "html", classList: ["zmta-empty"], children: [
            { tag: "strong", namespace: "html", properties: { textContent: STATUS_LABELS[preview.status] } },
            { tag: "p", namespace: "html", classList: ["zmta-item-message"], properties: { textContent: preview.message || "本条目不会更新。" } },
          ],
        }] : !sections.length ? [{ tag: "div", namespace: "html", classList: ["zmta-empty"], properties: { textContent: "没有需要更新的内容" } }] : []),
        ...(preview.status === "ready" && (preview.attachments.length || preview.notes.length) ? [{
          tag: "p", namespace: "html", classList: ["zmta-addition-hint"], properties: { textContent: "只新增，不修改已有附件和笔记；请留意重复内容。" },
        }] : []),
      ],
    };
  });

  return {
    tag: "div", namespace: "html", classList: ["zmta-batch-review"], id: "zmta-batch-review",
    styles: { width: "100%", minWidth: "0", minHeight: "0", boxSizing: "border-box" },
    children: [
      {
        tag: "header", namespace: "html", classList: ["zmta-overview"], children: [
          { tag: "strong", namespace: "html", classList: ["zmta-overview-title"], properties: { textContent: "审核元数据更新" } },
          { tag: "div", namespace: "html", classList: ["zmta-progress"], properties: { textContent: `${summary.total} 个条目 · ${summary.ready} 个可更新` } },
        ],
      },
      {
        tag: "div", namespace: "html", classList: ["zmta-workspace"], styles: { width: "100%", minWidth: "0", minHeight: "0", boxSizing: "border-box" },
        children: [
          { tag: "nav", namespace: "html", classList: ["zmta-sidebar"], attributes: { "aria-label": "本次审核条目" }, children: itemTabs.length ? itemTabs : [{ tag: "div", namespace: "html", properties: { textContent: "没有可审核条目" } }] },
          { tag: "main", namespace: "html", id: "zmta-batch-detail-pane", classList: ["zmta-detail-pane"], children: details.length ? details : [{ tag: "div", namespace: "html", classList: ["zmta-empty"], properties: { textContent: "没有可审核内容" } }] },
        ],
      },
      {
        tag: "footer", namespace: "html", classList: ["zmta-footer"], children: [
          {
            tag: "div", namespace: "html", children: [
              { tag: "p", namespace: "html", classList: ["zmta-selection-summary"], id: "zmta-batch-selection-summary", attributes: { "aria-live": "polite" }, properties: { textContent: formatBatchSelectionSummary(selectedSummary) } },
              { tag: "p", namespace: "html", classList: ["zmta-selection-help"], properties: { textContent: "仅更新勾选内容；已有值默认保留" } },
            ],
          },
          {
            tag: "div", namespace: "html", classList: ["zmta-footer-actions"], children: [
              { tag: "button", namespace: "html", classList: ["zmta-action"], id: "zmta-batch-cancel", attributes: { type: "button" }, properties: { textContent: "取消" }, listeners: [{ type: "click", listener: () => actions.onCancel?.() }] },
              { tag: "button", namespace: "html", classList: ["zmta-action"], id: "zmta-batch-confirm", attributes: { type: "button" }, properties: { textContent: "更新所选内容", disabled: selectedSummary.items === 0 }, listeners: [{ type: "click", listener: () => actions.onConfirm?.() }] },
            ],
          },
        ],
      },
      { tag: "style", namespace: "html", properties: { textContent: BATCH_DIALOG_CSS } },
    ],
  };
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
}

export function showBatchConfirmDialog(
  previews: BatchItemPreview[],
  ztoolkit: any,
  observer: BatchConfirmDialogObserver = {},
  displayOptions?: BatchDialogDisplayOptions,
): Promise<BatchItemSelection[] | null> {
  return new Promise((resolve) => {
    let dialog: any;
    let resolved = false;
    const finish = (confirmed: boolean, closeWindow = true) => {
      if (resolved) return;
      const selections = confirmed ? collectBatchSelections(previews, dialog?.window?.document) : null;
      if (confirmed && summarizeBatchSelections(selections || []).items === 0) return;
      resolved = true;
      resolve(selections);
      if (closeWindow) dialog?.window?.close?.();
    };
    try {
      const selectionDefaults = getReviewSelectionDefaults();
      dialog = new ztoolkit.Dialog(1, 1);
      const layout = buildBatchDialogLayout(previews, {
        showTechnicalDetails: displayOptions?.showTechnicalDetails
          ?? getPref("showTechnicalDetails") === true,
        selectionDefaults,
      }, { onConfirm: () => finish(true), onCancel: () => finish(false) });
      layout.styles.gridColumn = "1 / -1";
      dialog.addCell(0, 0, layout, true);
      dialog.setDialogData({
        loadCallback: () => {
          const doc = dialog.window.document;
          doc.documentElement.classList.add("zmta-review-window");
          refreshBatchSelectionUI(previews, doc);
        },
        beforeUnloadCallback: () => finish(false, false),
      });
      dialog.open("审核元数据更新", getBatchDialogOptions());
      observer.onOpen?.(dialog);
    } catch (error) {
      Zotero.debug(`[zmta-batch-dialog] Dialog 创建失败: ${error}`);
      finish(false);
    }
  });
}
