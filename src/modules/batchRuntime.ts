import {
  applyBatch,
  BatchLimitError,
  preflightBatch,
  preflightDOIBatch,
  retryFailedBatch,
  hasRetryableBatchOperations,
  type BatchOperationEvent,
} from "./batchSyncUpdate";
import { showBatchConfirmDialog } from "./batchConfirmDialog";
import { openBatchPreflightDialog } from "./batchPreflightDialog";
import { showBatchStatusDialog } from "./batchStatusDialog";
import {
  BatchJournal,
  type BatchJournalStorage,
  type JournalBatchItemInput,
} from "./batchJournal";
import {
  BatchPreflightCancelledError,
  type BatchItemPreview,
  type BatchItemSelection,
  type BatchRunResult,
  type BatchRuntimeCapabilities,
} from "./batchTypes";
import { DefaultZoteroRollbackPort } from "./update/zoteroMutationPort";
import { selectionSourceEvidence } from "./update/planner";
import { tryAcquireWorkflowActivity } from "./workflowActivity";

declare const Zotero: any;
declare const PathUtils: any;
declare const IOUtils: any;

const PLUGIN_NAME = "Zotero 元数据更新";
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
    Zotero.debug(`[zmta-runtime] 批次状态读取失败：${message}`);
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
    alertUser(win, [
      `检测到 ${capabilities.incompleteCount} 个未完成批次。`,
      "插件不会自动继续或撤销；请从“元数据更新 → 查看批次状态”检查，期间撤销入口保持禁用。",
    ].join("\n"));
  }
  return capabilities;
}

export async function inspectBatchStatus(win?: any, ztoolkit?: any) {
  const capabilities = getBatchRuntimeCapabilities();
  if (capabilities.loaded && capabilities.journalError) {
    alertUser(win, "批次日志读取失败，无法安全显示批次状态。");
    return null;
  }
  try {
    const batches = await getJournal().getInspectableBatches();
    if (batches.length === 0) {
      alertUser(win, "没有可查看的批次记录。");
      await refreshBatchRuntimeCapabilities();
      return null;
    }
    if (!ztoolkit?.Dialog) {
      alertUser(win, "批次状态窗口当前不可用。");
      return null;
    }
    await showBatchStatusDialog(batches, ztoolkit);
    return batches;
  } catch (error) {
    await refreshBatchRuntimeCapabilities();
    alertUser(win, `批次状态读取失败：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function makeBatchId(): string {
  const random = Zotero.Utilities?.randomString?.(8) || Math.random().toString(36).slice(2, 10);
  return `batch-${Date.now()}-${random}`;
}

function alertUser(win: any, message: string): void {
  Zotero.alert(win || Zotero.getMainWindow(), PLUGIN_NAME, message);
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
    `批次 ${result.batchId}`,
    `成功 ${result.applied}`,
    `部分成功 ${result.partial}`,
    `跳过 ${result.skipped}`,
    `失败 ${result.failed}`,
    recoveryRequired ? "有更新未能安全撤回，请查看批次状态并人工处理，不要重复执行这些操作。" : "",
    result.items.some(hasRetryableBatchOperations) ? "可从菜单重试其余失败项。" : "",
  ].filter(Boolean).join("\n");
}

async function executeSelections(
  selections: BatchItemSelection[],
  previews: BatchItemPreview[],
  batchId: string,
): Promise<BatchRunResult> {
  const batchJournal = getJournal();
  try {
    await batchJournal.startBatch(batchId, journalItems(selections, previews));
    const evidence = new Map(selections.flatMap((selection) => {
      const source = selectionSourceEvidence(selection);
      return source ? [[selection.itemKey, source] as const] : [];
    }));
    const result = await applyBatch(selections, {
      batchId,
      onOperationStatus: createJournalCallback(batchJournal, evidence),
    });
    await batchJournal.finalizeBatch(batchId, finalJournalStatus(result));
    retryState = { selections, result };
    return result;
  } finally {
    await refreshBatchRuntimeCapabilities();
  }
}

async function runBatchWorkflowWith(
  items: any[],
  ztoolkit: any,
  win: any,
  preflight: typeof preflightBatch,
): Promise<BatchRunResult | null> {
  const release = tryAcquireWorkflowActivity("reviewing");
  if (!release) {
    alertUser(win, "已有元数据审核、重试或撤销正在进行，请完成后再试。");
    return null;
  }
  try {
    const progress = openBatchPreflightDialog(ztoolkit, items.length);
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
      alertUser(win, "请选择至少一个普通书目条目。");
      return null;
    }
    const selections = await showBatchConfirmDialog(previews, ztoolkit);
    if (!selections || selections.every((selection) =>
      !selection.creators
      && selection.fields.length === 0 && selection.attachments.length === 0 && selection.notes.length === 0
    )) {
      return null;
    }
    const result = await executeSelections(selections, previews, makeBatchId());
    alertUser(win, resultMessage(result));
    return result;
  } catch (error) {
    if (error instanceof BatchPreflightCancelledError) return null;
    const message = error instanceof BatchLimitError
      ? error.message
      : `批量更新失败：${error instanceof Error ? error.message : String(error)}`;
    alertUser(win, message);
    return null;
  } finally {
    release();
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

export async function retryLastFailedBatch(win?: any, ztoolkit?: any): Promise<BatchRunResult | null> {
  const release = tryAcquireWorkflowActivity("retrying");
  if (!release) {
    alertUser(win, "已有元数据审核、重试或撤销正在进行，请完成后再试。");
    return null;
  }
  try {
    const capabilities = getBatchRuntimeCapabilities();
    if (capabilities.loaded && capabilities.journalError) {
      alertUser(win, "批次日志读取失败，已禁用重试以避免丢失审计记录。");
      return null;
    }
    if (!retryState) {
      alertUser(win, "当前会话没有可重试的失败批次。");
      return null;
    }
    const batchId = makeBatchId();
    const retryableSelections = retryState.selections.filter((selection) => {
      const item = retryState!.result.items.find((entry) => entry.itemKey === selection.itemKey);
      return hasRetryableBatchOperations(item);
    });
    // 这里只读取条目身份用于日志；Translator 预检由 retryFailedBatch 独占执行一次。
    const items = await Promise.all(retryableSelections.map((selection) => retryGetItem(selection.itemID)));
    const batchJournal = getJournal();
    const progress = ztoolkit
      ? openBatchPreflightDialog(ztoolkit, retryableSelections.length)
      : null;
    let resolvedSelections: BatchItemSelection[] | null = null;
    let journalCallback: ReturnType<typeof createJournalCallback> | null = null;
    const startRetryJournal = async (selections: readonly BatchItemSelection[]) => {
      if (resolvedSelections) return;
      if (progress?.signal.aborted) {
        throw new BatchPreflightCancelledError(0, retryableSelections.length);
      }
      // 关闭取消入口后才进入 journal/apply 边界；关闭本身不会触发 abort。
      progress?.close();
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
        onResolvedSelections: startRetryJournal,
        onOperationStatus: async (event) => {
          if (!journalCallback) throw new Error("重试候选尚未冻结，拒绝记录写入事件");
          await journalCallback(event);
        },
      });
    } finally {
      progress?.close();
    }
    // 测试注入的旧 runner 可能不支持 onResolvedSelections；兼容时只生成无来源的空操作日志。
    if (!resolvedSelections) await startRetryJournal(retryableSelections);
    await batchJournal.finalizeBatch(batchId, finalJournalStatus(result));
    retryState = { selections: resolvedSelections || [], result };
    await refreshBatchRuntimeCapabilities();
    alertUser(win, resultMessage(result));
    return result;
  } catch (error) {
    await refreshBatchRuntimeCapabilities();
    if (error instanceof BatchPreflightCancelledError) return null;
    alertUser(win, `重试失败：${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally {
    release();
  }
}

export async function rollbackLatestBatch(win?: any) {
  const release = tryAcquireWorkflowActivity("rolling-back");
  if (!release) {
    alertUser(win, "已有元数据审核、重试或撤销正在进行，请完成后再试。");
    return null;
  }
  try {
    const result = await getJournal().rollbackLatest(new DefaultZoteroRollbackPort());
    if (!result) {
      alertUser(win, "没有可撤销的最近批次。");
      return null;
    }
    alertUser(win, [
      `已处理最近批次 ${result.batchId} 的撤销：`,
      `已撤销 ${result.rolledBack}`,
      `冲突 ${result.conflicts}`,
      `失败 ${result.failed}`,
    ].join("\n"));
    return result;
  } catch (error) {
    alertUser(win, `撤销失败：${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally {
    try {
      await refreshBatchRuntimeCapabilities();
    } finally {
      release();
    }
  }
}

export interface BatchRuntimeTestOptions {
  journal?: BatchJournal;
  storage?: BatchJournalStorage;
  fileHost?: BatchJournalFileHost;
  retryState?: RetryState;
  retryGetItem?: (itemID: number) => Promise<any>;
  retryRunner?: typeof retryFailedBatch;
}

export function resetBatchRuntimeForTests(options: BatchRuntimeTestOptions = {}): void {
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
