import type { CandidateCreator, CandidateEnvelope, CandidateIdentityReview, SourceEvidence, SourceIdentifier, SourceRouteId } from "./update/contracts";
import type { AttemptEvidence, TerminalOutcome } from "./update/resolution";

export const PREFLIGHT_PROGRESS_STAGES = Object.freeze([
  "batch-start",
  "item-start",
  "route-start",
  "item-complete",
  "stopping",
  "batch-complete",
  "cancelled",
] as const);

export type BatchPreflightProgressStage = typeof PREFLIGHT_PROGRESS_STAGES[number];

export interface BatchPreflightProgress {
  readonly stage: BatchPreflightProgressStage;
  readonly completed: number;
  readonly total: number;
  readonly itemID?: number;
  readonly itemKey?: string;
  readonly title?: string;
  readonly routeId?: SourceRouteId;
  readonly attempt?: number;
  readonly status?: BatchItemStatus;
  readonly message?: string;
}

export type BatchPreflightProgressListener = (event: BatchPreflightProgress) => void;

export class BatchPreflightCancelledError extends Error {
  readonly completed: number;
  readonly total: number;

  constructor(completed: number, total: number) {
    super(`预检已取消（${completed}/${total}）`);
    this.name = "BatchPreflightCancelledError";
    this.completed = completed;
    this.total = total;
  }
}

export interface BatchExcludedField {
  readonly field: string;
  readonly reason: "unknown-field" | "invalid-for-item-type" | "validation-error";
  readonly message: string;
}

export interface BatchRuntimeCapabilities {
  readonly loaded: boolean;
  readonly journalError?: string;
  readonly incompleteCount: number;
  readonly hasRetryableItems: boolean;
  readonly hasUndoableBatch: boolean;
  readonly hasInspectableBatches: boolean;
}

export type BatchItemStatus =
  | "pending"
  | "ready"
  | "blocked"
  | "skipped"
  | "failed"
  | "applied"
  | "partial"
  | "rolled-back"
  | "rollback-conflict";

export type BatchOperationStatus = "planned" | "applied" | "failed" | "rolled-back" | "rollback-conflict";

export interface BatchFieldCandidate {
  field: string;
  local: any;
  incoming: any;
  isConflict: boolean;
  defaultChecked: boolean;
}

export interface BatchCreatorsCandidate {
  readonly local: readonly CandidateCreator[];
  readonly incoming: readonly CandidateCreator[];
  readonly isConflict: boolean;
  readonly defaultChecked: boolean;
}

export interface BatchNoteCandidate {
  content: string;
  defaultChecked: boolean;
  batchOperationId?: string;
}

/** Translator 返回、等待用户审核的附件候选；首版只允许新增。 */
export interface AttachmentCandidate {
  url?: string;
  title?: string;
  mimeType?: string;
  snapshot?: boolean;
  /** 批量预检生成的稳定操作标识。 */
  batchOperationId?: string;
}

export interface BatchItemPreview {
  itemID: number;
  itemKey: string;
  libraryID: number;
  title: string;
  sourceURL: string | null;
  status: BatchItemStatus;
  message?: string;
  fields: BatchFieldCandidate[];
  /** Creator 是一个有序整体，最多一个审核选择。 */
  creators?: BatchCreatorsCandidate;
  /** 候选中不适用于当前 itemType 的字段；只读展示，不得生成写入操作。 */
  excludedFields?: readonly BatchExcludedField[];
  attachments: AttachmentCandidate[];
  notes: BatchNoteCandidate[];
  /** 内部来源候选与证据；UI 只读展示来源并透传，不修改。 */
  candidate?: CandidateEnvelope;
  /** 仅在本次预检／审核会话中保留，不写入 journal。 */
  attempts?: readonly AttemptEvidence[];
  terminalOutcome?: TerminalOutcome;
  candidateDigest?: string;
  routeId?: SourceRouteId;
  normalizedDOI?: string;
  identityReview?: CandidateIdentityReview;
}

export interface BatchItemSelection {
  itemID: number;
  itemKey: string;
  fields: BatchFieldCandidate[];
  /** 选中时以 incoming 完整替换本地 Creator 列表。 */
  creators?: BatchCreatorsCandidate;
  attachments: AttachmentCandidate[];
  notes: BatchNoteCandidate[];
  /** 从预检透传给 Planner；旧调用者可省略。 */
  candidate?: CandidateEnvelope;
  attempts?: readonly AttemptEvidence[];
  candidateDigest?: string;
  routeId?: SourceRouteId;
  normalizedDOI?: string;
  /** 仅对 identityReview.required 的候选有效；必须由审核 UI 明确产生。 */
  identityConfirmed?: boolean;
}

export interface BatchOperationResult {
  kind: "field" | "creators" | "attachment" | "note";
  identity: string;
  status: BatchOperationStatus;
  message?: string;
  recoveryRequired?: boolean;
}

export interface BatchItemResult {
  itemID: number;
  itemKey: string;
  title: string;
  status: BatchItemStatus;
  operations: BatchOperationResult[];
  message?: string;
}

export interface BatchRunResult {
  batchId: string;
  total: number;
  applied: number;
  partial: number;
  skipped: number;
  failed: number;
  items: BatchItemResult[];
}

export interface JournalFieldChange {
  field: string;
  before: any;
  after: any;
  status: BatchOperationStatus;
  message?: string;
  recoveryRequired?: boolean;
  /** 写后无法取得实际值；after仅为序列化占位，不能作为回退依据。 */
  afterUnknown?: boolean;
}

export interface JournalCreatorsChange {
  before: readonly CandidateCreator[];
  after: readonly CandidateCreator[];
  status: BatchOperationStatus;
  message?: string;
  recoveryRequired?: boolean;
  afterUnknown?: boolean;
}

export interface JournalCreatedItem {
  kind: "attachment" | "note";
  itemKey: string;
  status: BatchOperationStatus;
  message?: string;
  /** 旧日志可缺失；缺失时撤销保守保留子项。 */
  fingerprint?: string;
  /** 已有副作用但补偿未完成；不得作为普通失败自动重试。 */
  recoveryRequired?: boolean;
  /** 创建副作用存在，但未能取得真实key；itemKey仅为批次操作标识。 */
  identityUnknown?: boolean;
}

export interface JournalItemRecord {
  itemID: number;
  itemKey: string;
  libraryID: number;
  title: string;
  fields: JournalFieldChange[];
  /** 可选以兼容旧 journal；Creator 列表作为一个整体操作。 */
  creators?: JournalCreatorsChange;
  createdItems: JournalCreatedItem[];
  /** 只持久化最终被选择进入执行的候选来源；不记录失败尝试链。 */
  sourceEvidence?: SourceEvidence;
}

export interface BatchJournalRecord {
  batchId: string;
  createdAt: string;
  completedAt?: string;
  /** 单调完成顺序；旧日志可缺失。 */
  completedOrder?: number;
  status: "running" | "completed" | "partial" | "failed" | "rolled-back" | "rollback-partial";
  items: JournalItemRecord[];
}

/** journal 的只读展示合同；不暴露可修改的 BatchJournalRecord。 */
export interface BatchInspectionSource {
  readonly providerId: string;
  readonly routeId?: SourceRouteId;
  readonly sourceId?: string;
  readonly identifiers: readonly SourceIdentifier[];
}

export interface BatchInspectionOperation {
  readonly operationId: string;
  readonly kind: "field" | "creators" | "attachment" | "note";
  readonly label: string;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly status: BatchOperationStatus;
  readonly message?: string;
  readonly recoveryRequired?: boolean;
  readonly createdItemKey?: string;
  readonly identityUnknown?: boolean;
  readonly afterUnknown?: boolean;
}

export interface BatchInspectionItem {
  readonly itemID: number;
  readonly itemKey: string;
  readonly title: string;
  readonly source?: BatchInspectionSource;
  readonly operations: readonly BatchInspectionOperation[];
}

export interface BatchInspectionBatch {
  readonly batchId: string;
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly status: BatchJournalRecord["status"];
  readonly incomplete: boolean;
  readonly items: readonly BatchInspectionItem[];
}

export type BatchReviewFn = (previews: BatchItemPreview[]) => Promise<BatchItemSelection[] | null>;

export interface BatchRollbackResult {
  batchId: string;
  rolledBack: number;
  conflicts: number;
  failed: number;
  items: BatchItemResult[];
}

export const MAX_BATCH_ITEMS = 50;
