import type { AttachmentCandidate } from "../batchTypes";
import type {
  BatchExcludedField,
  BatchFieldCandidate,
  BatchItemPreview,
  BatchItemSelection,
  BatchNoteCandidate,
} from "../batchTypes";
import type {
  CandidateEnvelope,
  CandidateCreator,
  ChangeOperation,
  MetadataItemRef,
  SourceEvidence,
} from "./contracts";
import { createChangePlan, type ChangePlan } from "./contracts";
import type { ProviderItemSnapshot } from "./provider";
import { createCandidateDigest, normalizeDOI } from "./resolution";

declare const Zotero: any;

const PROVIDER_SNAPSHOT_FIELDS = Object.freeze([
  "title",
  "shortTitle",
  "publisher",
  "publicationTitle",
  "date",
  "DOI",
  "ISBN",
  "numPages",
  "abstractNote",
  "url",
  "language",
  "series",
  "edition",
  "version",
  "versionNumber",
  "place",
  "extra",
] as const);

function itemType(item: any): string {
  if (typeof item?.itemType === "string") return item.itemType;
  try {
    return String(Zotero.ItemTypes.getName(item.itemTypeID) || "");
  } catch {
    return "";
  }
}

function readField(item: any, field: string): unknown {
  try {
    return item.getField(field);
  } catch {
    return "";
  }
}

export function snapshotProviderItem(item: any): ProviderItemSnapshot {
  const scalarFields = Object.fromEntries(
    PROVIDER_SNAPSHOT_FIELDS.map((field) => [field, readField(item, field)]),
  );
  let creators: readonly unknown[] = [];
  try {
    const value = item?.getCreatorsJSON?.();
    if (Array.isArray(value)) creators = Object.freeze(value.map((entry) => Object.freeze({ ...entry })));
  } catch {
    creators = [];
  }
  const fields = Object.freeze({
    ...scalarFields,
    ...(creators.length > 0 ? { creators } : {}),
  });
  return {
    itemID: Number(item?.id),
    itemKey: String(item?.key || ""),
    libraryID: Number(item?.libraryID),
    itemType: itemType(item),
    title: String(fields.title || "（无标题）"),
    fields,
  };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeCreators(
  value: unknown,
  targetItemType: string,
): { creators?: readonly CandidateCreator[]; invalid: boolean } {
  if (value === undefined || value === null) return { invalid: false };
  if (!Array.isArray(value)) return { invalid: true };
  if (value.length === 0) return { creators: Object.freeze([]), invalid: false };

  let itemTypeID: number;
  try {
    itemTypeID = Number(Zotero.ItemTypes.getID(targetItemType));
  } catch {
    return { invalid: true };
  }
  if (!itemTypeID) return { invalid: true };

  const creators: CandidateCreator[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { invalid: true };
    const creator = entry as Record<string, unknown>;
    const creatorType = nonEmptyString(creator.creatorType);
    if (!creatorType) return { invalid: true };
    try {
      const creatorTypeID = Number(Zotero.CreatorTypes.getID(creatorType));
      if (!creatorTypeID || !Zotero.CreatorTypes.isValidForItemType(creatorTypeID, itemTypeID)) {
        return { invalid: true };
      }
    } catch {
      return { invalid: true };
    }

    const hasName = Object.prototype.hasOwnProperty.call(creator, "name");
    const hasFirstName = Object.prototype.hasOwnProperty.call(creator, "firstName");
    const hasLastName = Object.prototype.hasOwnProperty.call(creator, "lastName");
    if (hasName) {
      if (hasFirstName || hasLastName || typeof creator.name !== "string" || !creator.name.trim()) {
        return { invalid: true };
      }
      creators.push({ creatorType, name: creator.name });
      continue;
    }
    if ((!hasFirstName && !hasLastName)
      || (hasFirstName && typeof creator.firstName !== "string")
      || (hasLastName && typeof creator.lastName !== "string")
      || !`${creator.firstName ?? ""}${creator.lastName ?? ""}`.trim()) {
      return { invalid: true };
    }
    creators.push({
      creatorType,
      firstName: hasFirstName ? creator.firstName as string : "",
      lastName: hasLastName ? creator.lastName as string : "",
    });
  }
  return { creators: Object.freeze(creators), invalid: false };
}

function sameCreators(left: readonly CandidateCreator[], right: readonly CandidateCreator[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((creator, index) => {
    const other = right[index];
    return creator.creatorType === other.creatorType
      && creator.name === other.name
      && creator.firstName === other.firstName
      && creator.lastName === other.lastName;
  });
}

function isMissingValue(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

function sameFieldValue(left: unknown, right: unknown): boolean {
  return String(left ?? "") === String(right ?? "");
}

export type FieldValidationResult = "valid" | BatchExcludedField["reason"];
export type FieldValidator = (field: string, itemType: string) => FieldValidationResult;

function validateZoteroField(field: string, targetItemType: string): FieldValidationResult {
  const fieldID = Zotero.ItemFields.getID(field);
  if (!fieldID) return "unknown-field";
  const itemTypeID = Zotero.ItemTypes.getID(targetItemType);
  if (!itemTypeID) return "validation-error";
  return Zotero.ItemFields.isValidForType(fieldID, itemTypeID)
    ? "valid"
    : "invalid-for-item-type";
}

function excludedField(
  field: string,
  targetItemType: string,
  reason: BatchExcludedField["reason"],
): BatchExcludedField {
  const message = reason === "unknown-field"
    ? `未知字段“${field}”，已排除`
    : reason === "invalid-for-item-type"
      ? `字段“${field}”不适用于条目类型 ${targetItemType || "unknown"}，已排除`
      : `无法验证字段“${field}”是否适用于条目类型 ${targetItemType || "unknown"}，已排除`;
  return { field, reason, message };
}

export function candidateToBatchPreview(
  item: any,
  candidate: CandidateEnvelope,
  validateField: FieldValidator = validateZoteroField,
): BatchItemPreview {
  const localItemType = itemType(item);
  const routeId = candidate.evidence.routeId;
  const normalizedDOI = normalizeDOI(
    candidate.evidence.identifiers.find((entry) => entry.type.toLowerCase() === "doi")?.value,
  ) || undefined;
  const candidateDigest = createCandidateDigest(candidate);
  if (candidate.itemType !== localItemType || candidate.item.itemType !== localItemType) {
    return {
      itemID: candidate.item.itemID,
      itemKey: candidate.item.itemKey,
      libraryID: candidate.item.libraryID,
      title: candidate.item.title,
      sourceURL: candidate.evidence.sourceURL,
      status: "blocked",
      message: `条目类型不一致：本地 ${localItemType || "unknown"}，候选 ${candidate.itemType || "unknown"}`,
      fields: [],
      attachments: [],
      notes: [],
      candidate,
      terminalOutcome: "blocked",
      candidateDigest,
      routeId,
      normalizedDOI,
    };
  }
  const incomingCreators = normalizeCreators(candidate.creators, localItemType);
  if (incomingCreators.invalid) {
    return {
      itemID: candidate.item.itemID,
      itemKey: candidate.item.itemKey,
      libraryID: candidate.item.libraryID,
      title: candidate.item.title,
      sourceURL: candidate.evidence.sourceURL,
      status: "blocked",
      message: "候选 Creator 结构或角色不适用于当前条目类型",
      fields: [],
      attachments: [],
      notes: [],
      candidate,
      terminalOutcome: "blocked",
      candidateDigest,
      routeId,
      normalizedDOI,
    };
  }
  let creators: BatchItemPreview["creators"];
  if (incomingCreators.creators && incomingCreators.creators.length > 0) {
    let localCreators: ReturnType<typeof normalizeCreators>;
    try {
      localCreators = normalizeCreators(item?.getCreatorsJSON?.(), localItemType);
    } catch {
      localCreators = { invalid: true };
    }
    if (localCreators.invalid || !localCreators.creators) {
      return {
        itemID: candidate.item.itemID,
        itemKey: candidate.item.itemKey,
        libraryID: candidate.item.libraryID,
        title: candidate.item.title,
        sourceURL: candidate.evidence.sourceURL,
        status: "blocked",
        message: "无法读取并验证本地 Creator 列表",
        fields: [],
        attachments: [],
        notes: [],
        candidate,
        terminalOutcome: "blocked",
        candidateDigest,
        routeId,
        normalizedDOI,
      };
    }
    if (!sameCreators(localCreators.creators, incomingCreators.creators)) {
      creators = {
        local: localCreators.creators,
        incoming: incomingCreators.creators,
        isConflict: localCreators.creators.length > 0,
        defaultChecked: localCreators.creators.length === 0,
      };
    }
  }
  const fields: BatchFieldCandidate[] = [];
  const excludedFields: BatchExcludedField[] = [];
  for (const entry of candidate.fields) {
    if (entry.field === "extra") continue;
    let validation: FieldValidationResult;
    try {
      validation = validateField(entry.field, localItemType);
    } catch {
      validation = "validation-error";
    }
    if (validation !== "valid") {
      const reason = validation === "unknown-field" || validation === "invalid-for-item-type"
        ? validation
        : "validation-error";
      excludedFields.push(excludedField(entry.field, localItemType, reason));
      continue;
    }
    const local = readField(item, entry.field);
    if (sameFieldValue(local, entry.value)) continue;
    const missing = isMissingValue(local);
    fields.push({
      field: entry.field,
      local,
      incoming: entry.value,
      isConflict: !missing,
      defaultChecked: missing,
    });
  }
  const attachments: AttachmentCandidate[] = candidate.attachments.map((entry) => ({
    url: entry.url,
    title: entry.title,
    mimeType: entry.mimeType,
    snapshot: entry.snapshot,
    batchOperationId: entry.operationId,
  }));
  const notes: BatchNoteCandidate[] = candidate.notes.map((entry) => ({
    content: entry.content,
    defaultChecked: true,
    batchOperationId: entry.operationId,
  }));
  const ready = fields.length > 0 || creators !== undefined || attachments.length > 0 || notes.length > 0;
  return {
    itemID: candidate.item.itemID,
    itemKey: candidate.item.itemKey,
    libraryID: candidate.item.libraryID,
    title: candidate.item.title,
    sourceURL: candidate.evidence.sourceURL,
    status: ready ? "ready" : "skipped",
    message: ready
      ? undefined
      : excludedFields.length > 0
        ? `无可更新差异（${excludedFields.length} 个字段已排除）`
        : "无差异",
    fields,
    ...(creators ? { creators } : {}),
    ...(excludedFields.length > 0
      ? { excludedFields: Object.freeze(excludedFields) }
      : {}),
    attachments,
    notes,
    candidate,
    terminalOutcome: "candidate",
    candidateDigest,
    routeId,
    normalizedDOI,
    identityReview: candidate.identityReview,
  };
}

export function selectionSourceEvidence(selection: BatchItemSelection): SourceEvidence | undefined {
  const evidence = selection.candidate?.evidence;
  if (!evidence) return undefined;
  const review = selection.candidate?.identityReview;
  if (!review?.required) return evidence;
  if (!selection.identityConfirmed) return evidence;
  return {
    ...evidence,
    identityConfirmation: {
      method: "user-confirmed",
      matchedFields: review.matchedFields,
    },
  };
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function occurrenceId(prefix: "attachment" | "note", canonical: string, occurrences: Map<string, number>): string {
  const hash = shortHash(canonical);
  const occurrence = occurrences.get(hash) || 0;
  occurrences.set(hash, occurrence + 1);
  return `${prefix}:${hash}:${occurrence}`;
}

function fallbackItemRef(selection: BatchItemSelection): MetadataItemRef {
  return {
    itemID: selection.itemID,
    itemKey: selection.itemKey,
    libraryID: 0,
    itemType: "book",
    title: selection.itemKey || String(selection.itemID),
  };
}

function selectionOperations(selection: BatchItemSelection): ChangeOperation[] {
  const operations: ChangeOperation[] = selection.fields.map((field) => ({
    kind: "field-set",
    operationId: `field:${field.field}`,
    field: field.field,
    before: field.local,
    after: field.incoming,
  }));
  if (selection.creators) {
    operations.push({
      kind: "creators-set",
      operationId: "creators:set",
      before: selection.creators.local,
      after: selection.creators.incoming,
    });
  }
  const attachmentOccurrences = new Map<string, number>();
  for (const attachment of selection.attachments) {
    const normalized = {
      url: attachment.url,
      title: attachment.title,
      mimeType: attachment.mimeType,
      snapshot: attachment.snapshot,
    };
    operations.push({
      kind: "attachment-create",
      operationId: attachment.batchOperationId
        || occurrenceId("attachment", JSON.stringify(normalized), attachmentOccurrences),
      attachment: normalized,
    });
  }
  const noteOccurrences = new Map<string, number>();
  for (const note of selection.notes) {
    operations.push({
      kind: "note-create",
      operationId: note.batchOperationId
        || occurrenceId("note", note.content, noteOccurrences),
      content: note.content,
    });
  }
  return operations;
}

export function selectionsToChangePlan(
  planId: string,
  selections: readonly BatchItemSelection[],
  createdAt = new Date().toISOString(),
  itemRefs: ReadonlyMap<string, MetadataItemRef> = new Map(),
  fallbackEvidence: ReadonlyMap<string, SourceEvidence> = new Map(),
): ChangePlan {
  return createChangePlan({
    planId,
    createdAt,
    items: selections.map((selection) => {
      const operations = selectionOperations(selection);
      if (operations.length > 0 && selection.candidate?.identityReview?.required && !selection.identityConfirmed) {
        throw new Error(`候选身份尚未由用户确认，拒绝生成写入计划：${selection.itemKey}`);
      }
      const evidence = selectionSourceEvidence(selection) || fallbackEvidence.get(selection.itemKey);
      if (operations.length > 0 && !evidence) {
        throw new Error(`缺少来源证据，拒绝生成写入计划：${selection.itemKey}`);
      }
      return {
        item: itemRefs.get(selection.itemKey) || selection.candidate?.item || fallbackItemRef(selection),
        evidence: evidence ? [evidence] : [],
        operations,
      };
    }),
  });
}
