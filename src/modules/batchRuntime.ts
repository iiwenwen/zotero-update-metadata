import { getPluginDialogScope, isPluginDialogScopeActive, restorePluginWindowFocus } from "./dialogLifecycle";
import { openExecutionDialog, showUndoConfirmation, showWorkflowResult, EXECUTION_COPY_IDS, UNDO_COPY_IDS, RESULT_COPY_IDS, type ExecutionDialog } from "./workflowDialogs";
import {
  applyBatch,
  BatchLimitError,
  preflightBatch,
  preflightDOIBatch,
  retryFailedBatch,
  hasRetryableBatchOperations,
  type BatchOperationEvent,
} from "./batchSyncUpdate";
import { showBatchConfirmDialog, BATCH_REVIEW_COPY_IDS } from "./batchConfirmDialog";
import { openBatchPreflightDialog, BATCH_PREFLIGHT_COPY_IDS } from "./batchPreflightDialog";
import { showBatchStatusDialog, BATCH_STATUS_COPY_IDS } from "./batchStatusDialog";
import { createDialogCopy, type DialogCopy, type MessageId } from "./dialogCopy";
import {
  BatchJournal,
  type BatchJournalStorage,
  type JournalBatchItemInput,
} from "./batchJournal";
import {
  BatchPreflightCancelledError,
  MAX_BATCH_ITEMS,
  type BatchItemPreview,
  type BatchItemSelection,
  type BatchRunResult,
  type BatchRuntimeCapabilities,
  type BatchJournalRecord,
} from "./batchTypes";
import { DefaultZoteroRollbackPort } from "./update/zoteroMutationPort";
import { selectionSourceEvidence } from "./update/planner";
import { normalizeDOI } from "./update/resolution";
import { tryAcquireWorkflowActivity } from "./workflowActivity";
import { PLUGIN_NAME } from "../config";
import { localized } from "../utils/locale";
import { canRefreshReview } from "./reviewRecovery";

declare const Zotero: any;
declare const __testBuild__: boolean;
declare const PathUtils: any;
declare const IOUtils: any;

const JOURNAL_DIR = "zmta-update-metadata";
const JOURNAL_FILE = "batch-journal.json";

export interface BatchJournalFileHost {
  dataDirectory: string;
  join(...parts: string[]): string;
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string | Uint8Array>;
  ensureDirectory(path: string): Promise<void>;
  write(path: string, value: string): Promise<void>;
}

function defaultFileHost(): BatchJournalFileHost {
  return {
    dataDirectory: Zotero.DataDirectory.dir,
    join: (...parts) => PathUtils.join(...parts),
    exists: (path) => IOUtils.exists(path),
    read: (path) => Zotero.File.getContentsAsync(path, "utf-8"),
    ensureDirectory: (path) => Zotero.File.createDirectoryIfMissingAsync(path),
    write: (path, value) => Zotero.File.putContentsAsync(path, value, "utf-8"),
  };
}

export class ZoteroFileBatchJournalStorage implements BatchJournalStorage {
  private readonly directory: string;
  private readonly path: string;

  constructor(private readonly host: BatchJournalFileHost = defaultFileHost()) {
    this.directory = host.join(host.dataDirectory, JOURNAL_DIR);
    this.path = host.join(this.directory, JOURNAL_FILE);
  }

  async read(): Promise<string | null> {
    if (!await this.host.exists(this.path)) return null;
    const value = await this.host.read(this.path);
    if (typeof value === "string") return value;
    if (value instanceof Uint8Array) return new TextDecoder("utf-8", { fatal: true }).decode(value);
    throw new Error("批次日志读取结果不是 UTF-8 文本");
  }

  async write(value: string): Promise<void> {
    await this.host.ensureDirectory(this.directory);
    await this.host.write(this.path, value);
  }
}

export interface RetryState {
  selections: BatchItemSelection[];
  result: BatchRunResult;
}

let journal: BatchJournal | null = null;
let retryState: RetryState | null = null;
let journalStorage: BatchJournalStorage | null = null;
let retryGetItem: (itemID: number) => Promise<any> = (itemID) => Zotero.Items.getAsync(itemID);
let retryRunner: typeof retryFailedBatch = retryFailedBatch;
let runtimeCapabilities: BatchRuntimeCapabilities = Object.freeze({
  loaded: false,
  incompleteCount: 0,
  hasRetryableItems: false,
  hasUndoableBatch: false,
  hasInspectableBatches: false,
});
let incompleteAlertShown = false;
let confirmUndoForTests: ((batch: BatchJournalRecord) => Promise<boolean>) | undefined;

function getJournal(): BatchJournal {
  if (!journal) journal = new BatchJournal(journalStorage || new ZoteroFileBatchJournalStorage());
  return journal;
}

function hasRetryableItems(): boolean {
  if (!retryState) return false;
  return retryState.selections.some((selection) => {
    const result = retryState!.result.items.find((item) => item.itemKey === selection.itemKey);
    return hasRetryableBatchOperations(result);
  });
}

export function getBatchRuntimeCapabilities(): BatchRuntimeCapabilities {
  return Object.freeze({ ...runtimeCapabilities });
}

export async function refreshBatchRuntimeCapabilities(): Promise<BatchRuntimeCapabilities> {
  try {
    const inspectable = await getJournal().getInspectableBatches();
    const incomplete = inspectable.filter((batch) => batch.incomplete);
    const latestTerminal = inspectable.find((batch) => !batch.incomplete);
    const hasUndoableBatch = incomplete.length === 0 && Boolean(
      latestTerminal &&
      latestTerminal.status !== "rolled-back" &&
      latestTerminal.status !== "rollback-partial" &&
      latestTerminal.items.some((item) => item.operations.some((operation) => operation.status === "applied")),
    );
    runtimeCapabilities = Object.freeze({
      loaded: true,
      incompleteCount: incomplete.length,
      hasRetryableItems: hasRetryableItems(),
      hasUndoableBatch,
      hasInspectableBatches: inspectable.length > 0,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    Zotero.debug(`[zmta-runtime] 更新记录读取失败：${message}`);
    runtimeCapabilities = Object.freeze({
      loaded: true,
      journalError: message,
      incompleteCount: 0,
      hasRetryableItems: false,
      hasUndoableBatch: false,
      hasInspectableBatches: false,
    });
  }
  return getBatchRuntimeCapabilities();
}

export async function initializeBatchRuntimeState(win?: any): Promise<BatchRuntimeCapabilities> {
  const capabilities = await refreshBatchRuntimeCapabilities();
  if (!incompleteAlertShown && !capabilities.journalError && capabilities.incompleteCount > 0) {
    incompleteAlertShown = true;
    alertUser(win, localized(
      `检测到 ${capabilities.incompleteCount} 次未完成的更新。\n插件不会自动继续或撤销；请从“工具 → 查看更新记录”检查，期间撤销入口保持禁用。`,
      `${capabilities.incompleteCount} unfinished batch(es) detected.\nThe plugin will not automatically resume or undo them. Check Tools → View Update History; undo remains disabled until then.`,
    ));
  }
  return capabilities;
}

export async function inspectBatchStatus(win?: any, ztoolkit?: any, options: { batchId?: string; returnWindow?: any } = {}) {
  const dialogScope = getPluginDialogScope();
  if (!isPluginDialogScopeActive(dialogScope)) return null;
  let reload = true;
  let batches: Awaited<ReturnType<BatchJournal["getInspectableBatches"]>> = [];
  while (reload && isPluginDialogScopeActive(dialogScope)) {
    reload = false;
    let error: string | undefined;
    try {
      const journal = getJournal();
      batches = await (journal.getHistoryBatches ? journal.getHistoryBatches() : journal.getInspectableBatches());
    } catch (cause) {
      batches = [];
      error = localized("无法读取更新记录。请重新读取。", "Update history could not be read. Reload the records.");
      Zotero.debug(`[zmta] 更新记录读取失败：${cause}`);
    }
    await refreshBatchRuntimeCapabilities();
    if (!isPluginDialogScopeActive(dialogScope)) return null;
    if (!ztoolkit?.Dialog) {
      alertUser(win, error || (batches.length ? localized("暂时打不开更新记录窗口。", "The update history window could not be opened.") : localized("还没有更新记录。", "There is no update history yet.")));
      return null;
    }
    const locatable = new Set<string>();
    if (win?.ZoteroPane?.selectItem) {
      for (const item of batches.flatMap(batch => [...batch.items])) {
        try {
          const current = await Zotero.Items.getAsync(item.itemID);
          if (current && current.key === item.itemKey && !current.deleted) locatable.add(item.itemKey);
        } catch { /* 仍可阅读记录，不允许误定位另一个条目 */ }
      }
    }
    try {
      const copy = await resolveDialogCopy(win);
      await showBatchStatusDialog(batches, ztoolkit, copy, {
        onReloadRequest: () => { reload = true; },
        onLocate: async (item) => {
          const current = await Zotero.Items.getAsync(item.itemID);
          if (!isPluginDialogScopeActive(dialogScope) || !win || win.closed || !current || current.key !== item.itemKey || current.deleted) throw new Error(localized("原条目或窗口已不可用。更新记录仍可查看。", "The original item or window is unavailable. You can still view the update record."));
          await win.ZoteroPane.selectItem(item.itemID);
          win.focus?.();
        },
      }, { error, initialBatchId: options.batchId, locatableItemKeys: locatable });
    } catch (cause) {
      Zotero.debug(`[zmta] 更新记录窗口失败：${cause}`);
      alertUser(win, localized("无法打开更新记录窗口。请稍后重试。", "The update history window could not be opened. Try again later."));
      return null;
    }
  }
  let returnWindow = options.returnWindow || win;
  try { if (returnWindow?.closed) returnWindow = win; } catch { returnWindow = win; }
  restorePluginWindowFocus(returnWindow, dialogScope);
  return batches;
}

function makeBatchId(): string {
  const random = Zotero.Utilities?.randomString?.(8) || Math.random().toString(36).slice(2, 10);
  return `batch-${Date.now()}-${random}`;
}

function alertUser(win: any, message: string): void {
  Zotero.alert(win || Zotero.getMainWindow(), localized(PLUGIN_NAME.zh, PLUGIN_NAME.en), message);
}

/** 一次工作流只解析一次对话框文案；主窗口的 document.l10n 是唯一来源。 */
const DIALOG_COPY_IDS: readonly MessageId[] = Object.freeze([
  ...BATCH_PREFLIGHT_COPY_IDS,
  ...BATCH_REVIEW_COPY_IDS,
  ...BATCH_STATUS_COPY_IDS,
  ...EXECUTION_COPY_IDS,
  ...UNDO_COPY_IDS,
  ...RESULT_COPY_IDS,
]);

function resolveDialogCopy(win?: any): Promise<DialogCopy> {
  // 只用发起窗口的 l10n：没有窗口时退化成消息 id，绝不猜测另一个窗口。
  return createDialogCopy(win, DIALOG_COPY_IDS);
}

function journalItems(
  selections: BatchItemSelection[],
  previews: BatchItemPreview[],
): JournalBatchItemInput[] {
  const byKey = new Map(previews.map((preview) => [preview.itemKey, preview]));
  return selections.map((selection) => {
    const preview = byKey.get(selection.itemKey);
    return {
      itemID: selection.itemID,
      itemKey: selection.itemKey,
      libraryID: Number(preview?.libraryID || 0),
      title: preview?.title || selection.itemKey,
    };
  });
}

function retryJournalItems(selections: BatchItemSelection[], items: any[]): JournalBatchItemInput[] {
  const byKey = new Map(items.filter(Boolean).map((item) => [String(item.key || ""), item]));
  return selections.map((selection) => {
    const item = byKey.get(selection.itemKey);
    return {
      itemID: selection.itemID,
      itemKey: selection.itemKey,
      libraryID: Number(item?.libraryID || 0),
      title: item ? String(item.getField?.("title") || selection.itemKey) : selection.itemKey,
    };
  });
}

/** 将核心层的操作事件桥接到持久批次日志；导出仅用于集成测试。 */
export function createJournalCallback(
  batchJournal: BatchJournal,
  sourceEvidence: ReadonlyMap<string, NonNullable<BatchItemSelection["candidate"]>["evidence"]> = new Map(),
) {
  return async (event: BatchOperationEvent): Promise<void> => {
    const preserveApplied = event.status === "failed" && event.recoveryRequired === true;
    if (event.kind === "field") {
      if (event.status === "planned") {
        await batchJournal.planField(event.batchId, event.itemKey, {
          field: event.identity,
          before: event.before,
          after: event.after,
        });
      } else if (event.status === "applied" || event.status === "failed") {
        await batchJournal.resolveField(
          event.batchId,
          event.itemKey,
          event.identity,
          event.status,
          event.message,
          preserveApplied,
          event.after,
          event.recoveryRequired,
        );
        if (event.status === "applied") {
          const evidence = sourceEvidence.get(event.itemKey);
          if (evidence) await batchJournal.recordSourceEvidence(event.batchId, event.itemKey, evidence);
        }
      }
      return;
    }

    if (event.kind === "creators") {
      if (event.status === "planned") {
        await batchJournal.planCreators(event.batchId, event.itemKey, {
          before: event.before,
          after: event.after,
        });
      } else if (event.status === "applied" || event.status === "failed") {
        await batchJournal.resolveCreators(
          event.batchId,
          event.itemKey,
          event.status,
          event.message,
          preserveApplied,
          event.after,
          event.recoveryRequired,
        );
        if (event.status === "applied") {
          const evidence = sourceEvidence.get(event.itemKey);
          if (evidence) await batchJournal.recordSourceEvidence(event.batchId, event.itemKey, evidence);
        }
      }
      return;
    }

    if (event.status === "planned") {
      await batchJournal.planCreatedItem(event.batchId, event.itemKey, {
        kind: event.kind,
        operationId: event.identity,
      });
    } else if (event.status === "applied" || event.status === "failed") {
      await batchJournal.resolveCreatedItem(
        event.batchId,
        event.itemKey,
        event.identity,
        event.status,
        event.createdItemKey,
        event.message,
        preserveApplied,
        event.createdItemFingerprint,
        event.recoveryRequired,
      );
      if (event.status === "applied") {
        const evidence = sourceEvidence.get(event.itemKey);
        if (evidence) await batchJournal.recordSourceEvidence(event.batchId, event.itemKey, evidence);
      }
    }
  };
}

/** 将条目汇总转换为日志终态；保持为纯函数便于覆盖边界。 */
export function finalJournalStatus(result: BatchRunResult): "completed" | "partial" | "failed" {
  if (result.failed === result.total && result.total > 0) return "failed";
  if (result.failed > 0 || result.partial > 0) return "partial";
  return "completed";
}

function resultMessage(result: BatchRunResult): string {
  const recoveryRequired = result.items.some((item) => item.operations.some((entry) => entry.recoveryRequired));
  return [
    localized("更新结果", "Update results"),
    localized(`已更新 ${result.applied}`, `Updated ${result.applied}`),
    localized(`部分完成 ${result.partial}`, `Partly updated ${result.partial}`),
    localized(`未更新 ${result.skipped}`, `Not updated ${result.skipped}`),
    localized(`失败 ${result.failed}`, `Failed ${result.failed}`),
    recoveryRequired ? localized("有些更新没能安全撤回。请查看更新记录并人工处理，不要重复执行这些操作。", "Some changes could not be safely reverted. Check update history and resolve them manually; do not repeat those operations.") : "",
    result.items.some(hasRetryableBatchOperations) ? localized("可从菜单重试其余失败项。", "Use the menu to retry the remaining failed operations.") : "",
  ].filter(Boolean).join("\n");
}

async function executeSelections(
  selections: BatchItemSelection[],
  previews: BatchItemPreview[],
  batchId: string,
  ztoolkit: any,
  copy: DialogCopy,
): Promise<BatchRunResult> {
  const dialogScope = getPluginDialogScope();
  const batchJournal = getJournal();
  const progress = ztoolkit?.Dialog ? openExecutionDialog(ztoolkit, selections.length, copy) : null;
  let completedItems = 0;
  try {
    if (!isPluginDialogScopeActive(dialogScope)) throw new BatchPreflightCancelledError(0, selections.length);
    await batchJournal.startBatch(batchId, journalItems(selections, previews));
    const evidence = new Map(selections.flatMap((selection) => {
      const source = selectionSourceEvidence(selection);
      return source ? [[selection.itemKey, source] as const] : [];
    }));
    const result = await applyBatch(selections, {
      batchId,
      onOperationStatus: async (event) => {
        await createJournalCallback(batchJournal, evidence)(event);
        progress?.update({ completed: completedItems, total: selections.length, title: previews.find(p => p.itemKey === event.itemKey)?.title,
          stageId: event.kind === "attachment" ? "dlg-exec-stage-attachment" : event.kind === "note" ? "dlg-exec-stage-note" : "dlg-exec-stage-field" });
      },
      onItemComplete: (item, completed, total) => { completedItems = completed; progress?.update({ completed, total, title: item.title, stageId: "dlg-exec-stage-item-done" }); },
    });
    await batchJournal.finalizeBatch(batchId, finalJournalStatus(result));
    retryState = { selections, result };
    return result;
  } finally {
    progress?.close();
    await refreshBatchRuntimeCapabilities();
  }
}

async function presentResult(
  result: BatchRunResult | import("./batchTypes").BatchRollbackResult,
  win: any,
  toolkit: any,
  copy: DialogCopy,
  undo = false,
  retry = false,
): Promise<"done" | "retry"> {
  if (!toolkit?.Dialog) {
    if ("applied" in result) alertUser(win, resultMessage(result));
    else alertUser(win, localized(`已撤销 ${result.rolledBack} 项；保留 ${result.conflicts} 项；失败 ${result.failed} 项`, `${result.rolledBack} undone; ${result.conflicts} kept; ${result.failed} failed`));
    return "done";
  }
  try {
    return await showWorkflowResult(result, toolkit, { copy, undo, retry,
      canRetry: !undo && result.items.some(hasRetryableBatchOperations),
      onRecords: returnWindow => inspectBatchStatus(win, toolkit, { batchId: result.batchId, returnWindow }),
    });
  } catch (error) {
    Zotero.debug(`[zmta] 结果显示失败：${error}`);
    alertUser(win, localized("处理已结束，但无法打开结果窗口。请从工具菜单查看更新记录。请勿重复执行更新。", "Processing has ended, but the results window could not be opened. View update history from the Tools menu. Do not repeat the update."));
    return "done";
  }
}

async function reviewWithRecovery(items: any[], initial: BatchItemPreview[], toolkit: any, copy: DialogCopy): Promise<{ selections: BatchItemSelection[] | null; previews: BatchItemPreview[] }> {
  let previews = initial.map(preview => ({ ...preview,
    ...(preview.status !== "ready" ? { normalizedDOI: preview.normalizedDOI || normalizeItemDOI(items.find(item => item.id === preview.itemID)) } : {}),
  }));
  let saved: BatchItemSelection[] | undefined;
  while (true) {
    let refresh: { preview: BatchItemPreview; doiOnly: boolean } | undefined;
    const selections = await showBatchConfirmDialog(previews, toolkit, copy, {
      onRefresh: (preview, doiOnly, current) => { refresh = { preview, doiOnly }; saved = current.filter(s => s.itemKey !== preview.itemKey); },
    }, { initialSelections: saved });
    if (!refresh) return { selections, previews };
    const request = refresh as { preview: BatchItemPreview; doiOnly: boolean };
    if (!canRefreshReview(request.preview, request.doiOnly)) return { selections: null, previews };
    const item = items.find(item => item.id === request.preview.itemID && item.key === request.preview.itemKey
      && item.libraryID === request.preview.libraryID);
    if (!item || item.deleted || item.isEditable?.() === false) return { selections: null, previews };
    if (String(item.getField?.("url") || "") !== (request.preview.sourceURL || "")
      || normalizeItemDOI(item) !== request.preview.normalizedDOI) {
      alertUser(win, localized("条目来源已变化，请重新打开审核窗口。", "The item's source has changed. Open a new review."));
      return { selections: null, previews };
    }
    const progress = openBatchPreflightDialog(toolkit, 1, copy);
    try {
      const fetched = await (request.doiOnly ? preflightDOIBatch : preflightBatch)([item], {
        signal: progress.signal, onProgress: event => progress.update(event),
      });
      const updated = fetched[0];
      if (updated) previews = previews.map(p => p.itemKey === request.preview.itemKey ? { ...updated, normalizedDOI: updated.normalizedDOI || normalizeItemDOI(item) } : p);
    } finally { progress.close(); }
  }
}
function normalizeItemDOI(item: any): string | undefined {
  return normalizeDOI(item?.getField?.("DOI")) || undefined;
}

async function runBatchWorkflowWith(
  items: any[],
  ztoolkit: any,
  win: any,
  preflight: typeof preflightBatch,
): Promise<BatchRunResult | null> {
  const dialogScope = getPluginDialogScope();
  if (!isPluginDialogScopeActive(dialogScope)) return null;
  const release = tryAcquireWorkflowActivity("reviewing");
  if (!release) {
    alertUser(win, localized("正在处理另一项任务。请等待任务完成。", "Another task is in progress. Wait for it to finish."));
    return null;
  }
  try {
    const copy = await resolveDialogCopy(win);
    const progress = openBatchPreflightDialog(ztoolkit, items.length, copy);
    let previews: BatchItemPreview[];
    try {
      previews = await preflight(items, {
        signal: progress.signal,
        onProgress: (event) => progress.update(event),
      });
    } finally {
      progress.close();
    }
    if (previews.length === 0) {
      alertUser(win, localized("请至少选择一个条目。", "Select at least one item."));
      return null;
    }
    const reviewed = await reviewWithRecovery(items, previews, ztoolkit, copy);
    const selections = reviewed.selections;
    previews = reviewed.previews;
    if (!selections || selections.every((selection) =>
      !selection.creators
      && selection.fields.length === 0 && selection.attachments.length === 0 && selection.notes.length === 0
    )) {
      return null;
    }
    if (!isPluginDialogScopeActive(dialogScope)) return null;
    const result = await executeSelections(selections, previews, makeBatchId(), ztoolkit, copy);
    release();
    if (isPluginDialogScopeActive(dialogScope) && await presentResult(result, win, ztoolkit, copy) === "retry") await retryLastFailedBatch(win, ztoolkit, result.batchId);
    return result;
  } catch (error) {
    if (error instanceof BatchPreflightCancelledError) return null;
    Zotero.debug(`[zmta] 更新失败：${error instanceof Error ? error.message : String(error)}`);
    const message = error instanceof BatchLimitError
      ? localized(`一次最多处理 ${MAX_BATCH_ITEMS} 个条目，这次选中了 ${error.count} 个。`, `Select at most ${MAX_BATCH_ITEMS} items at a time; ${error.count} were selected.`)
      : localized("更新失败，请查看更新记录核对已完成的操作后再试。", "The update failed. Check update history for completed operations before trying again.");
    alertUser(win, message);
    return null;
  } finally {
    release();
    restorePluginWindowFocus(win, dialogScope);
  }
}

export function runBatchWorkflow(
  items: any[],
  ztoolkit: any,
  win?: any,
): Promise<BatchRunResult | null> {
  return runBatchWorkflowWith(items, ztoolkit, win, preflightBatch);
}

export function runDOIBatchWorkflow(
  items: any[],
  ztoolkit: any,
  win?: any,
): Promise<BatchRunResult | null> {
  return runBatchWorkflowWith(items, ztoolkit, win, preflightDOIBatch);
}

export async function retryLastFailedBatch(win?: any, ztoolkit?: any, expectedBatchId?: string): Promise<BatchRunResult | null> {
  const dialogScope = getPluginDialogScope();
  if (!isPluginDialogScopeActive(dialogScope)) return null;
  const release = tryAcquireWorkflowActivity("retrying");
  if (!release) {
    alertUser(win, localized("正在处理另一项任务。请等待任务完成。", "Another task is in progress. Wait for it to finish."));
    return null;
  }
  try {
    const capabilities = getBatchRuntimeCapabilities();
    if (capabilities.loaded && capabilities.journalError) {
      alertUser(win, localized("读取更新记录失败，暂时不能重试，以免记录丢失。", "Update history could not be read. Retry is disabled so the record is not lost."));
      return null;
    }
    if (!retryState || (expectedBatchId && retryState.result.batchId !== expectedBatchId)) {
      alertUser(win, localized("这次打开 Zotero 后还没有失败内容可以重试。", "Nothing has failed since Zotero started, so there is nothing to retry."));
      return null;
    }
    const batchId = makeBatchId();
    const copy = await resolveDialogCopy(win);
    const retryableSelections = retryState.selections.filter((selection) => {
      const item = retryState!.result.items.find((entry) => entry.itemKey === selection.itemKey);
      return hasRetryableBatchOperations(item);
    });
    // 这里只读取条目身份用于日志；Translator 预检由 retryFailedBatch 独占执行一次。
    const items = await Promise.all(retryableSelections.map((selection) => retryGetItem(selection.itemID)));
    const batchJournal = getJournal();
    const progress = ztoolkit
      ? openBatchPreflightDialog(ztoolkit, retryableSelections.length, copy)
      : null;
    let executionProgress: ExecutionDialog | null = null;
    let resolvedSelections: BatchItemSelection[] | null = null;
    let journalCallback: ReturnType<typeof createJournalCallback> | null = null;
    const startRetryJournal = async (selections: readonly BatchItemSelection[]) => {
      if (resolvedSelections) return;
      if (!isPluginDialogScopeActive(dialogScope) || progress?.signal.aborted) {
        throw new BatchPreflightCancelledError(0, retryableSelections.length);
      }
      // 关闭取消入口后才进入 journal/apply 边界；关闭本身不会触发 abort。
      progress?.close();
      executionProgress = ztoolkit?.Dialog ? openExecutionDialog(ztoolkit, selections.length, copy) : null;
      if (!isPluginDialogScopeActive(dialogScope)) throw new BatchPreflightCancelledError(0, selections.length);
      resolvedSelections = [...selections];
      await batchJournal.startBatch(batchId, retryJournalItems(resolvedSelections, items));
      const evidence = new Map(resolvedSelections.flatMap((selection) => {
        const source = selectionSourceEvidence(selection);
        return source ? [[selection.itemKey, source] as const] : [];
      }));
      journalCallback = createJournalCallback(batchJournal, evidence);
    };
    let result: BatchRunResult;
    try {
      result = await retryRunner(retryState.selections, retryState.result, {
        batchId,
        signal: progress?.signal,
        onProgress: progress ? (event) => progress.update(event) : undefined,
        review: async previews => {
          progress?.close();
          const selection = await showBatchConfirmDialog(previews, ztoolkit, copy, {}, { initialSelections: previews.filter(p => p.status === "ready").map(p => ({
            itemID: p.itemID, itemKey: p.itemKey, fields: p.fields.filter(f => f.defaultChecked), creators: p.creators?.defaultChecked ? p.creators : undefined,
            attachments: p.attachments, notes: p.notes, candidateDigest: p.candidateDigest,
          })) });
          return isPluginDialogScopeActive(dialogScope) ? selection : null;
        },
        onItemComplete: (item, completed, total) => executionProgress?.update({ completed, total, title: item.title, stageId: "dlg-exec-stage-item-done" }),
        onResolvedSelections: startRetryJournal,
        onOperationStatus: async (event) => {
          if (!journalCallback) throw new Error("重试候选尚未冻结，拒绝记录写入事件");
          await journalCallback(event);
        },
      });
    } finally {
      progress?.close();
      executionProgress?.close();
    }
    // 测试注入的旧 runner 可能不支持 onResolvedSelections；兼容时只生成无来源的空操作日志。
    if (!resolvedSelections) await startRetryJournal(retryableSelections);
    await batchJournal.finalizeBatch(batchId, finalJournalStatus(result));
    retryState = { selections: resolvedSelections || [], result };
    await refreshBatchRuntimeCapabilities();
    release();
    if (isPluginDialogScopeActive(dialogScope) && await presentResult(result, win, ztoolkit, copy, false, true) === "retry") await retryLastFailedBatch(win, ztoolkit, result.batchId);
    return result;
  } catch (error) {
    await refreshBatchRuntimeCapabilities();
    if (error instanceof BatchPreflightCancelledError) return null;
    Zotero.debug(`[zmta] 重试失败：${error instanceof Error ? error.message : String(error)}`);
    alertUser(win, localized("重试没完成，请查看更新记录核对已完成的操作后再试。", "The retry did not finish. Check update history before trying again."));
    return null;
  } finally {
    release();
    restorePluginWindowFocus(win, dialogScope);
  }
}

export async function rollbackLatestBatch(win?: any, ztoolkit?: any) {
  const dialogScope = getPluginDialogScope();
  if (!isPluginDialogScopeActive(dialogScope)) return null;
  const release = tryAcquireWorkflowActivity("rolling-back");
  if (!release) { alertUser(win, localized("正在处理另一项任务。请等待任务完成。", "Another task is in progress. Wait for it to finish.")); return null; }
  let progress: ExecutionDialog | null = null;
  try {
    const copy = await resolveDialogCopy(win);
    const batchJournal = getJournal();
    const snapshot = await batchJournal.getLatestUndoableBatch();
    if (!snapshot) { alertUser(win, localized("最近没有可以撤销的更新。", "There is no recent update to undo.")); return null; }
    const confirmed = confirmUndoForTests ? await confirmUndoForTests(snapshot) : await showUndoConfirmation(snapshot, ztoolkit, copy);
    if (!confirmed || !isPluginDialogScopeActive(dialogScope)) return null;
    progress = ztoolkit?.Dialog ? openExecutionDialog(ztoolkit, snapshot.items.length, copy, true) : null;
    if (!isPluginDialogScopeActive(dialogScope)) return null;
    const result = await batchJournal.rollbackLatest(new DefaultZoteroRollbackPort(), {
      expectedBatchId: snapshot.batchId,
      onItemComplete: (title, completed, total) => progress?.update({ title, completed, total, stageId: "dlg-exec-stage-item-done" }),
    });
    progress?.close();
    await refreshBatchRuntimeCapabilities();
    release();
    if (result && isPluginDialogScopeActive(dialogScope)) await presentResult(result, win, ztoolkit, copy, true);
    return result;
  } catch (error) {
    Zotero.debug(`[zmta] 撤销失败：${error}`);
    alertUser(win, localized("撤销没完成，请查看更新记录核对已撤销的操作后再试。", "The undo did not finish. Check update history before trying again."));
    return null;
  } finally {
    try { progress?.close(); await refreshBatchRuntimeCapabilities(); }
    finally { release(); restorePluginWindowFocus(win, dialogScope); }
  }
}

export interface BatchRuntimeTestOptions {
  journal?: BatchJournal;
  storage?: BatchJournalStorage;
  fileHost?: BatchJournalFileHost;
  retryState?: RetryState;
  retryGetItem?: (itemID: number) => Promise<any>;
  retryRunner?: typeof retryFailedBatch;
  confirmUndo?: (batch: BatchJournalRecord) => Promise<boolean>;
}

export function resetBatchRuntimeForTests(options: BatchRuntimeTestOptions = {}): void {
  if (options.confirmUndo && !__testBuild__) throw new Error("测试交互仅允许测试构建注入");
  confirmUndoForTests = __testBuild__ ? options.confirmUndo : undefined;
  journal = options.journal || null;
  journalStorage = options.storage || (options.fileHost ? new ZoteroFileBatchJournalStorage(options.fileHost) : null);
  retryState = options.retryState || null;
  retryGetItem = options.retryGetItem || ((itemID) => Zotero.Items.getAsync(itemID));
  retryRunner = options.retryRunner || retryFailedBatch;
  runtimeCapabilities = Object.freeze({
    loaded: false,
    incompleteCount: 0,
    hasRetryableItems: hasRetryableItems(),
    hasUndoableBatch: false,
    hasInspectableBatches: false,
  });
  incompleteAlertShown = false;
}
