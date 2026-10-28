import type {
  BatchInspectionBatch,
  BatchInspectionItem,
  BatchInspectionOperation,
  BatchInspectionSource,
  BatchItemResult,
  BatchJournalRecord,
  BatchOperationResult,
  BatchRollbackResult,
  JournalCreatedItem,
  JournalCreatorsChange,
  JournalFieldChange,
  JournalItemRecord,
} from "./batchTypes";
import type { CandidateCreator, SourceEvidence } from "./update/contracts";

export interface BatchJournalStorage {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
}

export interface BatchRollbackAPI {
  getItem(libraryID: number, itemKey: string): Promise<any | null> | any | null;
  getField(item: any, field: string): any;
  setField(item: any, field: string, value: any): void;
  getCreators(item: any): readonly CandidateCreator[];
  setCreators(item: any, creators: readonly CandidateCreator[]): void;
  saveItem(item: any): Promise<void>;
  trashItem(libraryID: number, itemKey: string, expectedFingerprint?: string): Promise<void>;
  getCreatedItemFingerprint?(item: any): string | undefined;
}

export interface JournalBatchItemInput {
  itemID: number;
  itemKey: string;
  libraryID: number;
  title: string;
}

export interface PlanCreatedItemInput {
  kind: "attachment" | "note";
  /** 写入前可用的批次内唯一标识；创建成功后会被真实 Zotero item key 替换。 */
  operationId: string;
}

interface JournalCreatedItemWithIdentity extends JournalCreatedItem {
  /** 批次内稳定操作标识；itemKey 在 applied 后会变成 Zotero 子条目 key。 */
  operationId?: string;
}

type FinalBatchStatus = "completed" | "partial" | "failed";
type OperationResolution = "applied" | "failed";

export class IncompleteBatchBlocksRollbackError extends Error {
  constructor(public readonly batchIds: string[]) {
    super(`存在更新且未完成的批次，拒绝撤销较早批次：${batchIds.join(", ")}`);
    this.name = "IncompleteBatchBlocksRollbackError";
  }
}

const TERMINAL_BATCH_STATUSES = new Set<BatchJournalRecord["status"]>([
  "completed",
  "partial",
  "failed",
  "rolled-back",
  "rollback-partial",
]);

const BATCH_STATUSES = new Set<BatchJournalRecord["status"]>([
  "running",
  ...TERMINAL_BATCH_STATUSES,
]);

const OPERATION_STATUSES = new Set([
  "planned",
  "applied",
  "failed",
  "rolled-back",
  "rollback-conflict",
]);

const PRIVATE_URL_VALUE = "（URL 值已隐藏）";

function clone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return Object.freeze(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameValue(left: any, right: any): boolean {
  return Object.is(left, right);
}

function sameCreators(left: readonly CandidateCreator[], right: readonly CandidateCreator[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((creator, index) => {
    const other = right[index];
    return creator.creatorType === other.creatorType &&
      creator.firstName === other.firstName &&
      creator.lastName === other.lastName &&
      creator.name === other.name;
  });
}

/** 只清理仍能归属于本次回退的内存值；失败清理本身不再写库。 */
async function rollbackSavedValue<T>(
  read: () => T,
  set: (value: T) => void,
  save: () => Promise<void>,
  before: T,
  after: T,
  same: (left: T, right: T) => boolean,
): Promise<{ status: "rolled-back" | "rollback-conflict" | "failed"; message?: string }> {
  let written = false;
  let captured = false;
  let owned: T;
  try {
    set(before);
    written = true;
    owned = clone(read());
    captured = true;
    const saving = save();
    let captureError: unknown;
    try { owned = clone(read()); }
    catch (error) { captured = false; captureError = error; }
    await saving;
    if (captureError) throw captureError;
    if (!captured || !same(read(), owned!)) {
      return { status: "rollback-conflict", message: "回退保存等待期间内容已变化，保留当前值" };
    }
    return { status: "rolled-back" };
  } catch (error) {
    const message = `回退保存失败：${errorMessage(error)}`;
    if (written) {
      try {
        if (!captured || !same(read(), owned!)) {
          return { status: "rollback-conflict", message: `${message}；内容已变化或无法确认归属，保留当前值` };
        }
        set(after);
      } catch (cleanupError) {
        return { status: "failed", message: `${message}；内存恢复失败：${errorMessage(cleanupError)}` };
      }
    }
    return { status: "failed", message };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isTranslatorAttribution(value: unknown): boolean {
  return value === undefined || ["selected", "observed", "single-match", "unknown", "ambiguous"].includes(String(value));
}

function isIdentityConfirmation(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value) || value.method !== "user-confirmed" || !Array.isArray(value.matchedFields)) return false;
  const allowed = new Set(["url", "title", "creator", "year", "publisher", "isbn"]);
  return value.matchedFields.length > 0
    && value.matchedFields.every((field) => typeof field === "string" && allowed.has(field));
}

function isOperationStatus(value: unknown): boolean {
  return typeof value === "string" && OPERATION_STATUSES.has(value);
}

function isSourceEvidence(value: unknown): value is SourceEvidence {
  if (!isRecord(value)) return false;
  if (!isIdentityConfirmation(value.identityConfirmation)) return false;
  if (
    typeof value.providerId !== "string" ||
    typeof value.sourceURL !== "string" ||
    typeof value.fetchedAt !== "string" ||
    !isOptionalString(value.routeId) ||
    !isOptionalString(value.sourceId) ||
    !Array.isArray(value.identifiers) ||
    !value.identifiers.every((identifier) => (
      isRecord(identifier) &&
      typeof identifier.type === "string" &&
      typeof identifier.value === "string"
    ))
  ) return false;
  if (value.translator === undefined) return true;
  if (!isRecord(value.translator)) return false;
  if (!isTranslatorAttribution(value.translator.attribution)) return false;
  return ["id", "label", "updatedAt", "zoteroVersion"]
    .every((key) => isOptionalString(value.translator![key]));
}

function isFieldChange(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.field === "string" &&
    "before" in value &&
    "after" in value &&
    isOperationStatus(value.status) &&
    isOptionalString(value.message) && isOptionalBoolean(value.recoveryRequired) && isOptionalBoolean(value.afterUnknown);
}

function isCreator(value: unknown): value is CandidateCreator {
  if (!isRecord(value) || typeof value.creatorType !== "string" || value.creatorType.length === 0) return false;
  if (!isOptionalString(value.firstName) || !isOptionalString(value.lastName) || !isOptionalString(value.name)) return false;
  const hasSingleFieldName = typeof value.name === "string" && value.name.trim().length > 0;
  const hasTwoFieldName = typeof value.firstName === "string" || typeof value.lastName === "string";
  const hasNonEmptyTwoFieldName = hasTwoFieldName && `${value.firstName ?? ""}${value.lastName ?? ""}`.trim().length > 0;
  return hasSingleFieldName !== hasTwoFieldName && (hasSingleFieldName || hasNonEmptyTwoFieldName);
}

function isCreatorsChange(value: unknown): value is JournalCreatorsChange {
  return isRecord(value) &&
    Array.isArray(value.before) && value.before.every(isCreator) &&
    Array.isArray(value.after) && value.after.every(isCreator) &&
    isOperationStatus(value.status) &&
    isOptionalString(value.message) && isOptionalBoolean(value.recoveryRequired) && isOptionalBoolean(value.afterUnknown);
}

function isCreatedItem(value: unknown): boolean {
  return isRecord(value) &&
    (value.kind === "attachment" || value.kind === "note") &&
    typeof value.itemKey === "string" &&
    isOperationStatus(value.status) &&
    isOptionalString(value.message) &&
    isOptionalString(value.operationId) &&
    isOptionalString(value.fingerprint) && isOptionalBoolean(value.recoveryRequired) && isOptionalBoolean(value.identityUnknown);
}

function isJournalItem(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.itemID === "number" && Number.isFinite(value.itemID) &&
    typeof value.itemKey === "string" &&
    typeof value.libraryID === "number" && Number.isFinite(value.libraryID) &&
    typeof value.title === "string" &&
    Array.isArray(value.fields) && value.fields.every(isFieldChange) &&
    (value.creators === undefined || isCreatorsChange(value.creators)) &&
    Array.isArray(value.createdItems) && value.createdItems.every(isCreatedItem) &&
    (value.sourceEvidence === undefined || isSourceEvidence(value.sourceEvidence));
}

function isJournalRecord(value: unknown): value is BatchJournalRecord {
  return isRecord(value) &&
    typeof value.batchId === "string" &&
    typeof value.createdAt === "string" &&
    isOptionalString(value.completedAt) &&
    (value.completedOrder === undefined || (Number.isSafeInteger(value.completedOrder) && Number(value.completedOrder) > 0)) &&
    typeof value.status === "string" &&
    BATCH_STATUSES.has(value.status as BatchJournalRecord["status"]) &&
    Array.isArray(value.items) && value.items.every(isJournalItem);
}

function parseRecords(raw: string | null): BatchJournalRecord[] {
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every(isJournalRecord)) {
    throw new Error("批次日志格式无效");
  }
  return parsed;
}

export class MemoryBatchJournalStorage implements BatchJournalStorage {
  private value: string | null;

  constructor(initialValue: string | null = null) {
    this.value = initialValue;
  }

  async read(): Promise<string | null> {
    return this.value;
  }

  async write(value: string): Promise<void> {
    this.value = value;
  }
}

/**
 * 插件本地批次日志。持久化与 Zotero API 均由调用方注入，本模块不直接访问
 * Zotero SQLite，也不决定日志在插件数据目录中的具体文件名。
 */
export class BatchJournal {
  private queue: Promise<void> = Promise.resolve();
  private pendingSerialized: string | null = null;

  constructor(
    private readonly storage: BatchJournalStorage,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async startBatch(batchId: string, items: JournalBatchItemInput[]): Promise<BatchJournalRecord> {
    return this.mutate(async (records) => {
      if (records.some((record) => record.batchId === batchId)) {
        throw new Error(`批次已存在：${batchId}`);
      }
      const record: BatchJournalRecord = {
        batchId,
        createdAt: this.now(),
        status: "running",
        items: items.map((item) => ({ ...item, fields: [], createdItems: [] })),
      };
      records.push(record);
      return clone(record);
    });
  }

  async recordSourceEvidence(
    batchId: string,
    itemKey: string,
    evidence: SourceEvidence,
  ): Promise<void> {
    await this.mutate(async (records) => {
      const item = this.getMutableItem(records, batchId, itemKey);
      if (item.sourceEvidence) {
        if (JSON.stringify(item.sourceEvidence) !== JSON.stringify(evidence)) {
          throw new Error(`条目来源证据已存在且不一致：${itemKey}`);
        }
        return;
      }
      item.sourceEvidence = clone(evidence);
    }, true);
  }

  async planField(
    batchId: string,
    itemKey: string,
    change: Omit<JournalFieldChange, "status" | "message">,
  ): Promise<void> {
    await this.mutate(async (records) => {
      const item = this.getMutableItem(records, batchId, itemKey);
      if (item.fields.some((field) => field.field === change.field)) {
        throw new Error(`字段操作已存在：${itemKey}/${change.field}`);
      }
      item.fields.push({ ...change, status: "planned" });
    });
  }

  async resolveField(
    batchId: string,
    itemKey: string,
    fieldName: string,
    status: OperationResolution,
    message?: string,
    preserveApplied = false,
    resolvedAfter?: any,
    recoveryRequired = false,
  ): Promise<void> {
    await this.mutate(async (records) => {
      const item = this.getMutableItem(records, batchId, itemKey);
      const field = item.fields.find((entry) => entry.field === fieldName);
      if (!field) throw new Error(`找不到字段操作：${itemKey}/${fieldName}`);
      if (field.status !== "planned" && field.status !== "failed" && !(field.status === "applied" && status === "failed")) {
        throw new Error(`字段状态不可更新：${field.status}`);
      }
      field.status = preserveApplied && field.status === "applied" ? "applied" : status;
      if ((status === "applied" || recoveryRequired) && resolvedAfter !== undefined) field.after = resolvedAfter;
      if (recoveryRequired && resolvedAfter === undefined) {
        field.after = null;
        field.afterUnknown = true;
      }
      if (recoveryRequired) field.recoveryRequired = true;
      field.message = message;
    }, true);
  }

  async planCreatedItem(batchId: string, parentItemKey: string, input: PlanCreatedItemInput): Promise<void> {
    await this.mutate(async (records) => {
      const item = this.getMutableItem(records, batchId, parentItemKey);
      if (item.createdItems.some((entry) =>
        entry.itemKey === input.operationId || (entry as JournalCreatedItemWithIdentity).operationId === input.operationId
      )) {
        throw new Error(`子条目操作已存在：${input.operationId}`);
      }
      item.createdItems.push({
        kind: input.kind,
        itemKey: input.operationId,
        operationId: input.operationId,
        status: "planned",
      } as JournalCreatedItemWithIdentity);
    });
  }

  async planCreators(
    batchId: string,
    itemKey: string,
    change: Pick<JournalCreatorsChange, "before" | "after">,
  ): Promise<void> {
    await this.mutate(async (records) => {
      const item = this.getMutableItem(records, batchId, itemKey);
      if (item.creators) throw new Error(`Creator 操作已存在：${itemKey}`);
      item.creators = { before: clone(change.before), after: clone(change.after), status: "planned" };
    });
  }

  async resolveCreators(
    batchId: string,
    itemKey: string,
    status: OperationResolution,
    message?: string,
    preserveApplied = false,
    actualAfter?: readonly CandidateCreator[],
    recoveryRequired = false,
  ): Promise<void> {
    await this.mutate(async (records) => {
      const item = this.getMutableItem(records, batchId, itemKey);
      const creators = item.creators;
      if (!creators) throw new Error(`找不到 Creator 操作：${itemKey}`);
      if (creators.status !== "planned" && creators.status !== "failed" && !(creators.status === "applied" && status === "failed")) {
        throw new Error(`Creator 状态不可更新：${creators.status}`);
      }
      creators.status = preserveApplied && creators.status === "applied" ? "applied" : status;
      if ((status === "applied" || recoveryRequired) && actualAfter !== undefined) creators.after = clone(actualAfter);
      if (recoveryRequired && actualAfter === undefined) {
        creators.after = [];
        creators.afterUnknown = true;
      }
      if (recoveryRequired) creators.recoveryRequired = true;
      creators.message = message;
    }, true);
  }

  async resolveCreatedItem(
    batchId: string,
    parentItemKey: string,
    operationId: string,
    status: OperationResolution,
    createdItemKey?: string,
    message?: string,
    preserveApplied = false,
    fingerprint?: string,
    recoveryRequired = false,
  ): Promise<void> {
    await this.mutate(async (records) => {
      const item = this.getMutableItem(records, batchId, parentItemKey);
      const created = item.createdItems.find((entry) =>
        entry.itemKey === operationId || (entry as JournalCreatedItemWithIdentity).operationId === operationId
      );
      if (!created) throw new Error(`找不到子条目操作：${operationId}`);
      if (
        created.status !== "planned" &&
        created.status !== "failed" &&
        !(created.status === "applied" && status === "failed")
      ) {
        throw new Error(`子条目状态不可更新：${created.status}`);
      }
      if (status === "applied" && !createdItemKey) {
        throw new Error("已创建的子条目必须记录 Zotero item key");
      }
      const resolvedKey = createdItemKey || (created.status === "applied" && !created.identityUnknown ? created.itemKey : undefined);
      if (!(preserveApplied && created.status === "applied")) {
        created.status = status;
        created.itemKey = (status === "applied" || recoveryRequired) && resolvedKey ? resolvedKey : operationId;
      }
      if (recoveryRequired && !resolvedKey) created.identityUnknown = true;
      else if (resolvedKey) delete created.identityUnknown;
      created.message = message;
      if ((status === "applied" || recoveryRequired) && fingerprint) created.fingerprint = fingerprint;
      if (recoveryRequired) created.recoveryRequired = true;
    }, true);
  }

  async finalizeBatch(batchId: string, status: FinalBatchStatus): Promise<BatchJournalRecord> {
    return this.mutate(async (records) => {
      const record = this.getMutableBatch(records, batchId);
      if (record.status !== "running") throw new Error(`批次已结束：${batchId}`);
      if (record.items.some((item) =>
        item.fields.some((field) => field.status === "planned") ||
        item.creators?.status === "planned" ||
        item.createdItems.some((created) => created.status === "planned")
      )) {
        throw new Error(`批次仍有未完成操作：${batchId}`);
      }
      record.status = status;
      record.completedAt = this.now();
      const order = records.reduce((max, entry) => Math.max(max, entry.completedOrder || 0), 0);
      if (order >= Number.MAX_SAFE_INTEGER) throw new Error("批次完成顺序超出安全范围");
      record.completedOrder = order + 1;
      return clone(record);
    }, true);
  }

  async listIncompleteBatches(): Promise<BatchJournalRecord[]> {
    const records = await this.readRecords();
    return records
      .filter((record) => record.status === "running" || !record.completedAt)
      .map(clone);
  }

  async getLatestCompletedBatch(): Promise<BatchJournalRecord | null> {
    const records = await this.readRecords();
    const latest = this.latestTerminal(records);
    return latest ? clone(latest) : null;
  }

  async getInspectableBatches(): Promise<BatchInspectionBatch[]> {
    await this.queue;
    const records = parseRecords(
      this.pendingSerialized !== null ? this.pendingSerialized : await this.storage.read(),
    );
    const selected = records
      .map((record, index) => ({ record, index }))
      .filter(({ record }) => record.status === "running" || !record.completedAt);
    const latestTerminal = this.latestTerminal(records);
    if (latestTerminal) {
      selected.push({ record: latestTerminal, index: records.indexOf(latestTerminal) });
    }

    selected.sort((left, right) => {
      const byCreatedAt = right.record.createdAt.localeCompare(left.record.createdAt);
      return byCreatedAt || left.index - right.index;
    });

    const seen = new Set<string>();
    const inspections: BatchInspectionBatch[] = [];
    for (const { record } of selected) {
      if (seen.has(record.batchId)) continue;
      seen.add(record.batchId);
      inspections.push(this.toInspectionBatch(record));
    }
    return deepFreeze(inspections);
  }

  async getLatestUndoableBatch(): Promise<BatchJournalRecord | null> {
    const records = await this.readRecords();
    const latest = this.latestTerminal(records);
    this.assertNoNewerIncomplete(records, latest);
    if (!latest || latest.status === "rolled-back" || latest.status === "rollback-partial") return null;
    return this.hasAppliedOperations(latest) ? clone(latest) : null;
  }

  async rollbackLatest(api: BatchRollbackAPI): Promise<BatchRollbackResult | null> {
    return this.mutate(async (records, persist) => {
      const record = this.latestTerminal(records);
      this.assertNoNewerIncomplete(records, record);
      if (
        !record ||
        record.status === "rolled-back" ||
        record.status === "rollback-partial" ||
        !this.hasAppliedOperations(record)
      ) return null;

      const result: BatchRollbackResult = {
        batchId: record.batchId,
        rolledBack: 0,
        conflicts: 0,
        failed: 0,
        items: [],
      };

      for (const journalItem of record.items) {
        const operations: BatchOperationResult[] = [];
        let item: any | null = null;
        // 未补偿的副作用不能自动重放，但也不能从“全部撤销”计数中消失。
        const manualRecovery = [
          ...journalItem.fields.filter((field) => field.status !== "rolled-back" &&
            (field.afterUnknown || (field.recoveryRequired && field.status !== "applied"))).map((field) => this.fieldResult(field)),
          ...(journalItem.creators && journalItem.creators.status !== "rolled-back" &&
            (journalItem.creators.afterUnknown || (journalItem.creators.recoveryRequired && journalItem.creators.status !== "applied"))
            ? [this.creatorsResult(journalItem.creators)] : []),
          ...journalItem.createdItems.filter((created) => created.recoveryRequired &&
            created.status !== "applied" && created.status !== "rolled-back").map((created) => this.createdItemResult(created)),
        ];
        for (const operation of manualRecovery) {
          operations.push({ ...operation, status: "rollback-conflict", recoveryRequired: true,
            message: `${operation.message || "未完成安全补偿"}；仍需人工处理，未自动回退` });
          result.conflicts += 1;
        }
        const appliedFields = journalItem.fields.filter((field) => field.status === "applied" && !field.afterUnknown);
        const appliedCreators = journalItem.creators?.status === "applied" && !journalItem.creators.afterUnknown ? journalItem.creators : undefined;

        if (appliedFields.length > 0 || appliedCreators) {
          try {
            item = await api.getItem(journalItem.libraryID, journalItem.itemKey);
          } catch (error) {
            for (const field of appliedFields) {
              this.markRollbackFailure(field, error, operations);
              result.failed += 1;
            }
            if (appliedCreators) {
              this.markCreatorsRollbackFailure(appliedCreators, error, operations);
              result.failed += 1;
            }
            await persist();
          }

          if (!item) {
            for (const field of appliedFields.filter((field) => field.status === "applied")) {
              this.markRollbackFailure(field, new Error("找不到原条目"), operations);
              result.failed += 1;
            }
            if (appliedCreators?.status === "applied") {
              this.markCreatorsRollbackFailure(appliedCreators, new Error("找不到原条目"), operations);
              result.failed += 1;
            }
            if (appliedFields.some((field) => field.status === "failed") || appliedCreators?.status === "failed") await persist();
          } else {
            for (const field of appliedFields) {
              let current: any;
              try {
                current = api.getField(item, field.field);
              } catch (error) {
                this.markRollbackFailure(field, error, operations);
                result.failed += 1;
                await persist();
                continue;
              }

              if (!sameValue(current, field.after)) {
                field.status = "rollback-conflict";
                field.message = "当前值已变化，未覆盖";
                operations.push(this.fieldResult(field));
                result.conflicts += 1;
                await persist();
                continue;
              }

              const outcome = await rollbackSavedValue(
                () => api.getField(item, field.field),
                (value) => api.setField(item, field.field, value),
                () => api.saveItem(item), field.before, field.after, sameValue,
              );
              field.status = outcome.status;
              field.message = outcome.message;
              if (outcome.status === "rolled-back") delete field.recoveryRequired;
              operations.push(this.fieldResult(field));
              if (outcome.status === "rolled-back") result.rolledBack += 1;
              else if (outcome.status === "rollback-conflict") result.conflicts += 1;
              else result.failed += 1;
              await persist();
            }

            if (appliedCreators?.status === "applied") {
              let current: readonly CandidateCreator[];
              try {
                current = api.getCreators(item);
              } catch (error) {
                this.markCreatorsRollbackFailure(appliedCreators, error, operations);
                result.failed += 1;
                await persist();
                current = [];
              }

              if (appliedCreators.status === "applied") {
                if (!sameCreators(current, appliedCreators.after)) {
                  appliedCreators.status = "rollback-conflict";
                  appliedCreators.message = "当前 Creator 列表已变化，未覆盖";
                  operations.push(this.creatorsResult(appliedCreators));
                  result.conflicts += 1;
                } else {
                  const outcome = await rollbackSavedValue(
                    () => api.getCreators(item),
                    (value) => api.setCreators(item, value),
                    () => api.saveItem(item), appliedCreators.before, appliedCreators.after, sameCreators,
                  );
                  appliedCreators.status = outcome.status;
                  appliedCreators.message = outcome.message;
                  if (outcome.status === "rolled-back") delete appliedCreators.recoveryRequired;
                  operations.push(this.creatorsResult(appliedCreators));
                  if (outcome.status === "rolled-back") result.rolledBack += 1;
                  else if (outcome.status === "rollback-conflict") result.conflicts += 1;
                  else result.failed += 1;
                }
                await persist();
              }
            }
          }
        }

        for (const created of journalItem.createdItems.filter((entry) => entry.status === "applied")) {
          try {
            const child = await api.getItem(journalItem.libraryID, created.itemKey);
            if (!created.fingerprint || !child || api.getCreatedItemFingerprint?.(child) !== created.fingerprint) {
              created.status = "rollback-conflict";
              created.message = "新增子项已变化或缺少创建状态，保留未回收";
              operations.push(this.createdItemResult(created));
              result.conflicts += 1;
              await persist();
              continue;
            }
            await api.trashItem(journalItem.libraryID, created.itemKey, created.fingerprint);
            created.status = "rolled-back";
            created.message = undefined;
            delete created.recoveryRequired;
            operations.push(this.createdItemResult(created));
            result.rolledBack += 1;
          } catch (error) {
            const conflict = (error as { code?: unknown })?.code === "conflict";
            created.status = conflict ? "rollback-conflict" : "failed";
            created.message = errorMessage(error);
            operations.push(this.createdItemResult(created));
            if (conflict) result.conflicts += 1;
            else result.failed += 1;
          }
          await persist();
        }

        if (operations.length > 0) result.items.push(this.rollbackItemResult(journalItem, operations));
      }

      record.status = result.conflicts === 0 && result.failed === 0 ? "rolled-back" : "rollback-partial";
      await persist();
      return clone(result);
    }, true);
  }

  private async readRecords(): Promise<BatchJournalRecord[]> {
    await this.queue;
    return this.loadRecords();
  }

  private async loadRecords(): Promise<BatchJournalRecord[]> {
    let raw: string | null;
    if (this.pendingSerialized !== null) {
      // applied/failed 状态的落盘若瞬时失败，保留完整快照并在任何后续操作前强制重刷。
      // 持续失败会继续抛错，调用层不能把批次误报为已完成。
      await this.storage.write(this.pendingSerialized);
      raw = this.pendingSerialized;
      this.pendingSerialized = null;
    } else {
      raw = await this.storage.read();
    }
    return parseRecords(raw);
  }

  private mutate<T>(
    action: (
      records: BatchJournalRecord[],
      persist: () => Promise<void>,
    ) => Promise<T>,
    retainOnWriteFailure = false,
  ): Promise<T> {
    const run = this.queue.then(async () => {
      const records = await this.loadRecords();
      const persist = async () => {
        const serialized = JSON.stringify(records);
        try {
          await this.storage.write(serialized);
          if (this.pendingSerialized === serialized) this.pendingSerialized = null;
        } catch (error) {
          if (retainOnWriteFailure) this.pendingSerialized = serialized;
          throw error;
        }
      };
      const result = await action(records, persist);
      await persist();
      return result;
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private getMutableBatch(records: BatchJournalRecord[], batchId: string): BatchJournalRecord {
    const record = records.find((entry) => entry.batchId === batchId);
    if (!record) throw new Error(`找不到批次：${batchId}`);
    return record;
  }

  private getMutableItem(records: BatchJournalRecord[], batchId: string, itemKey: string): JournalItemRecord {
    const record = this.getMutableBatch(records, batchId);
    if (record.status !== "running") throw new Error(`批次已结束：${batchId}`);
    const item = record.items.find((entry) => entry.itemKey === itemKey);
    if (!item) throw new Error(`找不到批次条目：${itemKey}`);
    return item;
  }

  private latestTerminal(records: BatchJournalRecord[]): BatchJournalRecord | null {
    const terminal = records.filter((record) => record.completedAt && TERMINAL_BATCH_STATUSES.has(record.status));
    if (terminal.length === 0) return null;
    return terminal.reduce((latest, record) => {
      const order = (record.completedOrder || 0) - (latest.completedOrder || 0);
      if (order) return order > 0 ? record : latest;
      // 旧日志没有序号时保留时间排序，相同毫秒优先后写入记录。
      return String(record.completedAt) >= String(latest.completedAt) ? record : latest;
    });
  }

  private toInspectionBatch(record: BatchJournalRecord): BatchInspectionBatch {
    return {
      batchId: record.batchId,
      createdAt: record.createdAt,
      ...(record.completedAt ? { completedAt: record.completedAt } : {}),
      status: record.status,
      incomplete: record.status === "running" || !record.completedAt,
      items: record.items.map((item) => this.toInspectionItem(item)),
    };
  }

  private toInspectionItem(item: JournalItemRecord): BatchInspectionItem {
    const operations: BatchInspectionOperation[] = [
      ...item.fields.map((field) => ({
        operationId: `field:${field.field}`,
        kind: "field" as const,
        label: field.field,
        before: field.field.toLowerCase() === "url" ? PRIVATE_URL_VALUE : clone(field.before),
        after: field.afterUnknown ? undefined : field.field.toLowerCase() === "url" ? PRIVATE_URL_VALUE : clone(field.after),
        status: field.status,
        ...(field.message ? { message: field.message } : {}),
        ...(field.recoveryRequired ? { recoveryRequired: true } : {}),
        ...(field.afterUnknown ? { afterUnknown: true,
          message: [field.message, "实际值未知，请人工核对"].filter(Boolean).join("；") } : {}),
      })),
      ...(item.creators ? [{
        operationId: "creators:set",
        kind: "creators" as const,
        label: "Creator 列表",
        before: clone(item.creators.before),
        after: item.creators.afterUnknown ? undefined : clone(item.creators.after),
        status: item.creators.status,
        ...(item.creators.message ? { message: item.creators.message } : {}),
        ...(item.creators.recoveryRequired ? { recoveryRequired: true } : {}),
        ...(item.creators.afterUnknown ? { afterUnknown: true,
          message: [item.creators.message, "实际值未知，请人工核对"].filter(Boolean).join("；") } : {}),
      }] : []),
      ...item.createdItems.map((created) => ({
        operationId: (created as JournalCreatedItemWithIdentity).operationId || created.itemKey,
        kind: created.kind,
        label: created.kind === "attachment" ? "附件" : "Note",
        status: created.status,
        ...(created.message ? { message: created.message } : {}),
        ...(created.recoveryRequired ? { recoveryRequired: true } : {}),
        ...(!created.identityUnknown && created.itemKey !== (created as JournalCreatedItemWithIdentity).operationId &&
          ((created as JournalCreatedItemWithIdentity).operationId || created.status === "applied" || created.status === "rolled-back" || created.fingerprint)
          ? { createdItemKey: created.itemKey } : {}),
        ...(created.identityUnknown ? { identityUnknown: true } : {}),
        ...(created.recoveryRequired ? {
          message: [created.message, created.identityUnknown
            ? "新增子项身份未知，请人工核对本批次父条目下的子项"
            : `新增子项 ${created.itemKey} 仍需人工处理`].filter(Boolean).join("；"),
        } : {}),
      })),
    ];
    const source = item.sourceEvidence ? this.toInspectionSource(item.sourceEvidence) : undefined;
    return {
      itemID: item.itemID,
      itemKey: item.itemKey,
      title: item.title,
      ...(source ? { source } : {}),
      operations,
    };
  }

  private toInspectionSource(evidence: SourceEvidence): BatchInspectionSource {
    return {
      providerId: evidence.providerId,
      ...(evidence.routeId ? { routeId: evidence.routeId } : {}),
      ...(evidence.sourceId ? {
        sourceId: /^https?:\/\//i.test(evidence.sourceId) ? PRIVATE_URL_VALUE : evidence.sourceId,
      } : {}),
      identifiers: evidence.identifiers.map((identifier) => ({
        type: identifier.type,
        value: /url/i.test(identifier.type) || /^https?:\/\//i.test(identifier.value)
          ? PRIVATE_URL_VALUE
          : identifier.value,
      })),
    };
  }

  private assertNoNewerIncomplete(
    records: BatchJournalRecord[],
    latestTerminal: BatchJournalRecord | null,
  ): void {
    const terminalIndex = latestTerminal ? records.indexOf(latestTerminal) : -1;
    const blockers = records.filter((record, index) => {
      const incomplete = record.status === "running" || !record.completedAt;
      if (!incomplete) return false;
      if (!latestTerminal) return true;
      return index > terminalIndex;
    });
    if (blockers.length > 0) {
      throw new IncompleteBatchBlocksRollbackError(blockers.map((record) => record.batchId));
    }
  }

  private hasAppliedOperations(record: BatchJournalRecord): boolean {
    return record.items.some((item) =>
      item.fields.some((field) => field.status === "applied") ||
      item.creators?.status === "applied" ||
      item.createdItems.some((created) => created.status === "applied")
    );
  }

  private markRollbackFailure(
    field: JournalFieldChange,
    error: unknown,
    operations: BatchOperationResult[],
  ): void {
    field.status = "failed";
    field.message = errorMessage(error);
    operations.push(this.fieldResult(field));
  }

  private fieldResult(field: JournalFieldChange): BatchOperationResult {
    return { kind: "field", identity: field.field, status: field.status, message: field.message };
  }

  private markCreatorsRollbackFailure(
    creators: JournalCreatorsChange,
    error: unknown,
    operations: BatchOperationResult[],
  ): void {
    creators.status = "failed";
    creators.message = errorMessage(error);
    operations.push(this.creatorsResult(creators));
  }

  private creatorsResult(creators: JournalCreatorsChange): BatchOperationResult {
    return { kind: "creators", identity: "creators:set", status: creators.status, message: creators.message };
  }

  private createdItemResult(created: JournalCreatedItem): BatchOperationResult {
    return { kind: created.kind, identity: created.itemKey, status: created.status, message: created.message };
  }

  private rollbackItemResult(item: JournalItemRecord, operations: BatchOperationResult[]): BatchItemResult {
    const hasConflict = operations.some((operation) => operation.status === "rollback-conflict");
    const hasFailure = operations.some((operation) => operation.status === "failed");
    const hasSuccess = operations.some((operation) => operation.status === "rolled-back");
    const status = hasConflict
      ? "rollback-conflict"
      : hasFailure && hasSuccess
        ? "partial"
        : hasFailure
          ? "failed"
          : "rolled-back";
    return { itemID: item.itemID, itemKey: item.itemKey, title: item.title, status, operations };
  }
}
