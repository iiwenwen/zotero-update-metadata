export const UPDATE_OPERATION_KINDS = Object.freeze([
  "field-set",
  "creators-set",
  "attachment-create",
  "note-create",
] as const);

export type ChangeOperationKind = typeof UPDATE_OPERATION_KINDS[number];
export type JournalOperationKind = "field" | "creators" | "attachment" | "note";

export interface MetadataItemRef {
  readonly itemID: number;
  readonly itemKey: string;
  readonly libraryID: number;
  readonly itemType: string;
  readonly title: string;
}

export interface SourceIdentifier {
  readonly type: string;
  readonly value: string;
}

export type SourceRouteId = "url.web" | "doi.search";

export interface TranslatorEvidence {
  readonly id?: string;
  readonly label?: string;
  readonly updatedAt?: string;
  readonly zoteroVersion?: string;
  /** 证据如何确定：Web 显式选择、Search itemDone 观察、唯一匹配推断，或无法／冲突归因。 */
  readonly attribution?: "selected" | "observed" | "single-match" | "unknown" | "ambiguous";
}

export type IdentityMatchField = "url" | "title" | "creator" | "year" | "publisher" | "isbn";

export interface LocalIdentityEvidence {
  readonly field: IdentityMatchField;
  readonly value: string | readonly string[];
  /** publisher 的原始依赖；不在复核时改用另一个字段兜底。 */
  readonly sourceField?: "publisher" | "publicationTitle";
}

export interface CandidateIdentityReview {
  readonly required: true;
  readonly matchedFields: readonly IdentityMatchField[];
  readonly summary: string;
  /** 仅会话内使用，不持久化到 journal。 */
  readonly localEvidence: readonly LocalIdentityEvidence[];
}

export interface SourceIdentityConfirmation {
  readonly method: "user-confirmed";
  readonly matchedFields: readonly IdentityMatchField[];
}

export interface SourceEvidence {
  readonly providerId: string;
  readonly sourceURL: string;
  readonly identifiers: readonly SourceIdentifier[];
  readonly fetchedAt: string;
  /** 新路线的可选证据；旧 journal／fixture 省略时仍有效。 */
  readonly routeId?: SourceRouteId;
  readonly sourceId?: string;
  readonly translator?: TranslatorEvidence;
  /** 只有组合证据候选被用户明确确认并进入执行后才写入。 */
  readonly identityConfirmation?: SourceIdentityConfirmation;
}

export interface CandidateField {
  readonly field: string;
  readonly value: unknown;
}

/** Zotero API JSON 形态；个人使用 firstName/lastName，机构使用 name。 */
export interface CandidateCreator {
  readonly creatorType: string;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly name?: string;
}

export interface CandidateAttachment {
  readonly operationId: string;
  readonly url?: string;
  readonly title?: string;
  readonly mimeType?: string;
  readonly snapshot?: boolean;
}

export interface CandidateNote {
  readonly operationId: string;
  readonly content: string;
}

export interface CandidateEnvelope {
  readonly providerId: string;
  readonly item: MetadataItemRef;
  readonly evidence: SourceEvidence;
  readonly itemType: string;
  readonly fields: readonly CandidateField[];
  /** 省略或空数组表示本次上游没有可用 Creator，不产生清空操作。 */
  readonly creators?: readonly CandidateCreator[];
  readonly attachments: readonly CandidateAttachment[];
  readonly notes: readonly CandidateNote[];
  /** 强标识不足但组合证据达到最低门槛时，必须在字段审核前单独确认身份。 */
  readonly identityReview?: CandidateIdentityReview;
  /** 本次身份门实际依赖的本地标识符快照，只用于审核后复核。 */
  readonly localIdentifiers?: readonly SourceIdentifier[];
}

interface OperationBase {
  readonly kind: ChangeOperationKind;
  readonly operationId: string;
}

export interface FieldSetOperation extends OperationBase {
  readonly kind: "field-set";
  readonly field: string;
  readonly before: unknown;
  readonly after: unknown;
}

export interface CreatorsSetOperation extends OperationBase {
  readonly kind: "creators-set";
  /** 一个有序整体；接受后不与本地成员拼接。 */
  readonly before: readonly CandidateCreator[];
  readonly after: readonly CandidateCreator[];
}

export interface AttachmentCreateOperation extends OperationBase {
  readonly kind: "attachment-create";
  readonly attachment: Omit<CandidateAttachment, "operationId">;
}

export interface NoteCreateOperation extends OperationBase {
  readonly kind: "note-create";
  readonly content: string;
}

export type ChangeOperation =
  | FieldSetOperation
  | CreatorsSetOperation
  | AttachmentCreateOperation
  | NoteCreateOperation;

export interface ItemChangePlan {
  readonly item: MetadataItemRef;
  readonly evidence: readonly SourceEvidence[];
  readonly operations: readonly ChangeOperation[];
}

export interface ChangePlan {
  readonly planId: string;
  readonly createdAt: string;
  readonly items: readonly ItemChangePlan[];
}

export type ChangeOperationStatus = "planned" | "applied" | "failed";

export interface ChangeOperationEvent {
  readonly planId: string;
  readonly item: MetadataItemRef;
  readonly operation: ChangeOperation;
  readonly status: ChangeOperationStatus;
  readonly actualAfter?: unknown;
  readonly createdItemKey?: string;
  readonly createdItemFingerprint?: string;
  readonly message?: string;
  readonly recoveryRequired?: boolean;
}

export interface ChangeOperationResult {
  readonly operationId: string;
  readonly kind: ChangeOperationKind;
  readonly status: Exclude<ChangeOperationStatus, "planned">;
  readonly message?: string;
  readonly recoveryRequired?: boolean;
}

export interface ItemChangeResult {
  readonly item: MetadataItemRef;
  readonly status: "applied" | "partial" | "failed" | "skipped";
  readonly operations: readonly ChangeOperationResult[];
  readonly message?: string;
}

export interface ChangeExecutionResult {
  readonly planId: string;
  readonly items: readonly ItemChangeResult[];
}

export type ChangeExecutionErrorCode =
  | "invalid-plan"
  | "item-not-found"
  | "item-mismatch"
  | "conflict"
  | "write-failed"
  | "journal-failed"
  | "compensation-failed";

export class ChangeExecutionError extends Error {
  constructor(
    public readonly code: ChangeExecutionErrorCode,
    message: string,
    public readonly operationId?: string,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = "ChangeExecutionError";
    if (options && "cause" in options) (this as Error & { cause?: unknown }).cause = options.cause;
  }
}

export interface ZoteroMutationPort<TItem = unknown, TCreatedItem = unknown> {
  getItem(item: MetadataItemRef): Promise<TItem | null>;
  getField(item: TItem, field: string): unknown;
  setField(item: TItem, field: string, value: unknown): void;
  getCreators(item: TItem): readonly CandidateCreator[];
  setCreators(item: TItem, creators: readonly CandidateCreator[]): void;
  saveItem(item: TItem): Promise<void>;
  createAttachment(item: TItem, candidate: Omit<CandidateAttachment, "operationId">): Promise<TCreatedItem>;
  createNote(item: TItem, content: string): Promise<TCreatedItem>;
  trashCreatedItem(item: TCreatedItem, expectedFingerprint?: string): Promise<void>;
  getCreatedItemKey(item: TCreatedItem): string | undefined;
  getCreatedItemFingerprint?(item: TCreatedItem): string | undefined;
  /** 必须是创建边界捕获的证明；缺失时保留子项，禁止从当前指纹推导。 */
  getCreatedItemCreationFingerprint?(item: TCreatedItem): string | undefined;
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => cloneValue(entry)) as T;
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = cloneValue(entry);
    }
    return output as T;
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return Object.freeze(value);
}

export function createChangePlan(input: ChangePlan): ChangePlan {
  return deepFreeze(cloneValue(input));
}

export function isChangeOperation(value: unknown): value is ChangeOperation {
  if (!value || typeof value !== "object") return false;
  const operation = value as Record<string, unknown>;
  if (typeof operation.operationId !== "string" || operation.operationId.length === 0) return false;
  switch (operation.kind) {
    case "field-set":
      return typeof operation.field === "string" && "before" in operation && "after" in operation;
    case "creators-set":
      return Array.isArray(operation.before) && Array.isArray(operation.after);
    case "attachment-create":
      return Boolean(operation.attachment && typeof operation.attachment === "object");
    case "note-create":
      return typeof operation.content === "string";
    default:
      return false;
  }
}

export function toJournalOperationKind(kind: ChangeOperationKind): JournalOperationKind {
  switch (kind) {
    case "field-set": return "field";
    case "creators-set": return "creators";
    case "attachment-create": return "attachment";
    case "note-create": return "note";
  }
}
