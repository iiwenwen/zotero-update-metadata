import { diffFields, fetchFromTranslator, getItemURL } from "./metadataSource";
import { localized } from "../utils/locale";
import {
  BatchPreflightCancelledError,
  MAX_BATCH_ITEMS,
  type BatchFieldCandidate,
  type BatchItemPreview,
  type BatchItemResult,
  type BatchItemSelection,
  type BatchNoteCandidate,
  type BatchOperationResult,
  type BatchOperationStatus,
  type BatchPreflightProgress,
  type BatchPreflightProgressListener,
  type BatchRunResult,
  type AttachmentCandidate,
} from "./batchTypes";
import { createDoubanProvider, extractDoubanSubject } from "./providers/doubanProvider";
import { createDOISearchRoute } from "./providers/doiSearchRoute";
import { createURLWebRoute, isbnValues } from "./providers/urlWebRoute";
import { createMockMetadataResolver } from "./providers/mockMetadataResolver";
import { ChangeExecutor } from "./update/changeExecutor";
import type {
  ChangeExecutionResult,
  ChangeOperation,
  ChangeOperationEvent,
  CandidateCreator,
  MetadataItemRef,
  SourceEvidence,
  ZoteroMutationPort,
} from "./update/contracts";
import { toJournalOperationKind } from "./update/contracts";
import { assertLocalIdentityEvidence } from "./update/identityReview";
import {
  candidateToBatchPreview,
  selectionSourceEvidence,
  selectionsToChangePlan,
  snapshotProviderItem,
} from "./update/planner";
import {
  fetchProviderCandidate,
  ProviderError,
  type MetadataProvider,
} from "./update/provider";
import {
  createDOIFallbackResolver,
  type DOIFallbackResolver,
} from "./update/doiFallbackResolver";
import {
  createCandidateDigest,
  createAttemptDiagnostic,
  normalizeDOI,
  normalizeHTTPURL,
  type AttemptEvidence,
  type ResolutionRoute,
  type RouteAttemptRequest,
  type RouteAttemptResult,
} from "./update/resolution";
import {
  DefaultZoteroMutationPort,
  DelegatingZoteroMutationPort,
} from "./update/zoteroMutationPort";

declare const Zotero: any;
declare const __testBuild__: boolean;
declare const __mockAcquisition__: boolean;

export interface BatchOperationEvent {
  batchId: string;
  itemID: number;
  itemKey: string;
  kind: BatchOperationResult["kind"];
  identity: string;
  status: BatchOperationStatus;
  before?: unknown;
  after?: unknown;
  createdItemKey?: string;
  createdItemFingerprint?: string;
  message?: string;
  recoveryRequired?: boolean;
}

export interface BatchPreflightDependencies {
  fetch?: typeof fetchFromTranslator;
  provider?: MetadataProvider;
  resolver?: DOIFallbackResolver;
  signal?: AbortSignal;
  onProgress?: BatchPreflightProgressListener;
}

export interface BatchApplyDependencies {
  getItem?: (itemID: number) => Promise<any> | any;
  addAttachment?: (item: any, attachment: AttachmentCandidate) => Promise<any>;
  createNote?: (item: any, note: BatchNoteCandidate) => Promise<any>;
  trashCreatedItem?: (created: any) => Promise<void>;
  onOperationStatus?: (event: BatchOperationEvent) => Promise<void> | void;
  port?: ZoteroMutationPort<any, any>;
  batchId?: string;
  onItemComplete?: (result: BatchItemResult, completed: number, total: number) => void;
}

export interface BatchRetryDependencies extends BatchApplyDependencies, BatchPreflightDependencies {
  /** retry 重新预检后、任何 planned/applied 事件前，交付本次真正进入 apply 的候选。 */
  onResolvedSelections?: (selections: readonly BatchItemSelection[]) => Promise<void> | void;
  review?: (previews: BatchItemPreview[]) => Promise<BatchItemSelection[] | null>;
}

export class BatchLimitError extends Error {
  constructor(public readonly count: number) {
    super(`单批最多处理 ${MAX_BATCH_ITEMS} 个书目条目，当前为 ${count} 个`);
    this.name = "BatchLimitError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function itemType(item: any): string {
  if (typeof item?.itemType === "string") return item.itemType;
  try {
    return String(Zotero.ItemTypes.getName(item.itemTypeID) || "");
  } catch {
    return "";
  }
}

function isBibliographicItem(item: any): boolean {
  if (!item) return false;
  try {
    if (typeof item.isRegularItem === "function") return Boolean(item.isRegularItem());
    return !item.isNote?.()
      && !item.isAttachment?.()
      && !item.isAnnotation?.()
      && !item.isFeedItem?.();
  } catch {
    return false;
  }
}

function itemTitle(item: any): string {
  try {
    return String(item.getField("title") || "（无标题）");
  } catch {
    return "（无标题）";
  }
}

function itemRef(item: any): MetadataItemRef {
  return {
    itemID: Number(item.id),
    itemKey: String(item.key || ""),
    libraryID: Number(item.libraryID),
    itemType: itemType(item),
    title: itemTitle(item),
  };
}

function emptyPreview(
  item: any,
  sourceURL: string | null,
  status: "skipped" | "failed" | "blocked",
  message: string,
  resolution: {
    attempts?: readonly AttemptEvidence[];
    terminalOutcome?: BatchItemPreview["terminalOutcome"];
    normalizedDOI?: string;
  } = {},
): BatchItemPreview {
  return {
    ...itemRef(item),
    sourceURL,
    status,
    message,
    fields: [],
    attachments: [],
    notes: [],
    ...resolution,
  };
}

export function isSameDoubanBook(localURL: string, incomingURL: unknown): boolean {
  const localSubject = extractDoubanSubject(localURL);
  return localSubject !== null && localSubject === extractDoubanSubject(incomingURL);
}

function isMissingValue(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

export function buildFieldCandidates(item: any, incoming: any): BatchFieldCandidate[] {
  return diffFields(item, incoming)
    .filter((diff) => diff.field !== "extra")
    .map((diff) => {
      const missing = isMissingValue(diff.local);
      return {
        field: diff.field,
        local: diff.local,
        incoming: diff.incoming,
        isConflict: !missing,
        defaultChecked: missing,
      };
    });
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function buildAttachmentCandidates(incoming: any): AttachmentCandidate[] {
  if (!Array.isArray(incoming?.attachments)) return [];
  const occurrences = new Map<string, number>();
  return incoming.attachments.flatMap((candidate: any): AttachmentCandidate[] => {
    if (!candidate || typeof candidate !== "object") return [];
    const normalized = {
      url: candidate.url === undefined ? undefined : String(candidate.url),
      title: candidate.title === undefined ? undefined : String(candidate.title),
      mimeType: candidate.mimeType === undefined ? undefined : String(candidate.mimeType),
      snapshot: candidate.snapshot === undefined ? undefined : Boolean(candidate.snapshot),
    };
    const hash = shortHash(JSON.stringify(normalized));
    const occurrence = occurrences.get(hash) || 0;
    occurrences.set(hash, occurrence + 1);
    return [{ ...normalized, batchOperationId: `attachment:${hash}:${occurrence}` }];
  });
}

export function buildNoteCandidates(incoming: any): BatchNoteCandidate[] {
  if (!Array.isArray(incoming?.notes)) return [];
  const occurrences = new Map<string, number>();
  return incoming.notes.flatMap((candidate: any): BatchNoteCandidate[] => {
    const content = typeof candidate === "string"
      ? candidate
      : candidate?.note ?? candidate?.content ?? candidate?.text;
    if (typeof content !== "string" || content.length === 0) return [];
    const hash = shortHash(content);
    const occurrence = occurrences.get(hash) || 0;
    occurrences.set(hash, occurrence + 1);
    return [{ content, defaultChecked: true, batchOperationId: `note:${hash}:${occurrence}` }];
  });
}

function resolveProvider(dependencies: BatchPreflightDependencies): MetadataProvider {
  if (dependencies.provider) return dependencies.provider;
  return createDoubanProvider(dependencies.fetch
    ? { translator: { translate: dependencies.fetch } }
    : undefined);
}

function doubanAttemptOutcome(error: ProviderError): AttemptEvidence["outcome"] {
  switch (error.code) {
    case "not-applicable":
    case "translator-missing": return "unsupported";
    case "no-result": return "no-result";
    case "source-mismatch": return "identifier-conflict";
    case "invalid-response": return "invalid-response";
    case "fetch-failed": return "fetch-failed";
    default: return "invalid-response";
  }
}

function createDefaultWebRoute(): ResolutionRoute {
  const genericRoute = createURLWebRoute();
  const doubanProvider = createDoubanProvider();
  return {
    id: "url.web",
    async attempt(request: RouteAttemptRequest): Promise<RouteAttemptResult> {
      const subject = extractDoubanSubject(request.url);
      if (!subject) return genericRoute.attempt(request);
      if (!doubanProvider.applies(request.item)) return genericRoute.attempt(request);
      const identifiers = doubanProvider.resolveIdentifiers(request.item);
      try {
        const providerRequest = { item: request.item, identifiers };
        const source = await doubanProvider.fetch(providerRequest);
        const rawCandidate = doubanProvider.transform(source, providerRequest);
        await doubanProvider.verify(rawCandidate, providerRequest);
        const candidate = {
          ...rawCandidate,
          evidence: {
            ...rawCandidate.evidence,
            routeId: "url.web" as const,
            sourceId: "douban",
          },
        };
        return {
          candidate,
          evidence: {
            routeId: "url.web",
            attempt: request.attempt,
            inputIdentifiers: identifiers,
            returnedIdentifiers: [{ type: "douban-subject", value: subject }],
            sourceId: "douban",
            fetchedAt: candidate.evidence.fetchedAt,
            outcome: "candidate",
            candidateDigest: createCandidateDigest(candidate),
          },
        };
      } catch (error) {
        const classified = doubanProvider.classifyError(error);
        // 旧豆瓣Provider包装了抓取错误；保留原阶段/原因，不能统统退化成网络失败。
        const causeDiagnostic = (classified as Error & {
          cause?: { diagnostic?: import("./update/resolution").AttemptDiagnostic };
        }).cause?.diagnostic;
        return {
          candidate: null,
          retryable: classified.retryable,
          evidence: {
            routeId: "url.web",
            attempt: request.attempt,
            inputIdentifiers: identifiers,
            returnedIdentifiers: [],
            sourceId: "douban",
            fetchedAt: new Date().toISOString(),
            outcome: doubanAttemptOutcome(classified),
            errorCode: classified.code,
            diagnostic: causeDiagnostic
              ? createAttemptDiagnostic(causeDiagnostic.stage, causeDiagnostic.message, classified)
              : createAttemptDiagnostic("route", classified.message, classified),
          },
        };
      }
    },
  };
}

function resolveBatchResolver(dependencies: BatchPreflightDependencies): DOIFallbackResolver {
  if (dependencies.resolver) return dependencies.resolver;
  if (__mockAcquisition__) {
    Zotero.debug("[zmta:mock] npm start 使用离线 Mock 元数据；npm run start:live 才访问真实上游");
    return createMockMetadataResolver();
  }
  return createDOIFallbackResolver({
    urlWebRoute: createDefaultWebRoute(),
    doiSearchRoute: createDOISearchRoute(),
    locale: Zotero.locale,
  });
}

function providerFailureMessage(error: unknown): string {
  if (error instanceof ProviderError) {
    if (error.code === "source-mismatch") return "同源验证失败";
    if (error.code === "no-result" || error.code === "translator-missing") return "Translator 未返回结果";
    return `Translator 获取失败：${error.message}`;
  }
  return `Translator 获取失败：${errorMessage(error)}`;
}

type ResolveForPreflight = (
  resolver: DOIFallbackResolver,
  request: Parameters<DOIFallbackResolver["resolve"]>[0],
) => ReturnType<DOIFallbackResolver["resolve"]>;

async function preflightBatchWith(
  selectedItems: any[],
  dependencies: BatchPreflightDependencies,
  resolveForItem: ResolveForPreflight,
): Promise<BatchItemPreview[]> {
  const items = (Array.isArray(selectedItems) ? selectedItems : []).filter(isBibliographicItem);
  if (items.length > MAX_BATCH_ITEMS) throw new BatchLimitError(items.length);
  const total = items.length;
  const previews: BatchItemPreview[] = [];
  let completed = 0;
  let stoppingEmitted = false;
  let cancelledEmitted = false;
  let settled = false;
  const emit = (event: Omit<BatchPreflightProgress, "completed" | "total">): void => {
    dependencies.onProgress?.({ ...event, completed, total });
  };
  const emitStopping = (): void => {
    if (stoppingEmitted) return;
    stoppingEmitted = true;
    emit({ stage: "stopping", message: "正在停止查找" });
  };
  const onAbort = (): void => {
    if (!settled) emitStopping();
  };
  const throwIfCancelled = (): void => {
    if (!dependencies.signal?.aborted) return;
    emitStopping();
    if (!cancelledEmitted) {
      cancelledEmitted = true;
      emit({ stage: "cancelled", message: "已取消查找" });
    }
    throw new BatchPreflightCancelledError(completed, total);
  };
  // 此处仅等待只读候选：取消后不再等失去响应的来源，也不让迟到结果进入审核/写入。
  // 仍监听原Promise的成功和失败，避免后台来源稍后拒绝时产生未处理异常。
  const awaitCandidate = <T>(pending: Promise<T>): Promise<T> => {
    const signal = dependencies.signal;
    if (!signal) return pending;
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const finish = (settle: () => void) => {
        if (finished) return;
        finished = true;
        signal.removeEventListener("abort", cancel);
        settle();
      };
      const cancel = () => {
        try { throwIfCancelled(); }
        catch (error) { finish(() => reject(error)); }
      };
      signal.addEventListener("abort", cancel, { once: true });
      Promise.resolve(pending).then(
        value => finish(() => resolve(value)),
        error => finish(() => reject(error)),
      );
      if (signal.aborted) cancel();
    });
  };
  const completeItem = (preview: BatchItemPreview): void => {
    previews.push(preview);
    completed += 1;
    emit({
      stage: "item-complete",
      itemID: preview.itemID,
      itemKey: preview.itemKey,
      title: preview.title,
      status: preview.status,
      message: preview.message,
    });
  };

  emit({ stage: "batch-start" });
  dependencies.signal?.addEventListener("abort", onAbort, { once: true });
  const legacyProvider = dependencies.provider || dependencies.fetch
    ? resolveProvider(dependencies)
    : null;
  const resolver = legacyProvider ? null : resolveBatchResolver(dependencies);
  try {
    throwIfCancelled();
    for (const item of items) {
      throwIfCancelled();
      const snapshot = snapshotProviderItem(item);
      const sourceURL = typeof snapshot.fields.url === "string" ? snapshot.fields.url : null;
      emit({
        stage: "item-start",
        itemID: snapshot.itemID,
        itemKey: snapshot.itemKey,
        title: snapshot.title,
      });
      let editable = true;
      try { if (typeof item.isEditable === "function") editable = item.isEditable() === true; }
      catch { editable = false; }
      if (!editable || item.deleted || item.isFeedItem === true) {
        completeItem(emptyPreview(item, sourceURL, "skipped", localized(
          "当前条目只读或不可用，未获取来源，也不会更新。",
          "This item is read-only or unavailable. No source was retrieved and nothing was updated.",
        )));
        continue;
      }
      if (legacyProvider) {
        if (!legacyProvider.applies(snapshot)) {
          completeItem(emptyPreview(item, sourceURL, "skipped", localized(
            "来源不适用于该条目，本条目未更新。",
            "This source does not apply to this item. Nothing was updated.",
          )));
          continue;
        }
        try {
          throwIfCancelled();
          emit({
            stage: "route-start",
            itemID: snapshot.itemID,
            itemKey: snapshot.itemKey,
            title: snapshot.title,
            routeId: "url.web",
            attempt: 1,
          });
          throwIfCancelled();
          const candidate = await awaitCandidate(fetchProviderCandidate(legacyProvider, snapshot));
          throwIfCancelled();
          completeItem(candidateToBatchPreview(item, candidate));
        } catch (error) {
          throwIfCancelled();
          if (error instanceof BatchPreflightCancelledError) throw error;
          completeItem(emptyPreview(item, sourceURL, "failed", providerFailureMessage(error)));
        }
        continue;
      }

      const localDOI = normalizeDOI(snapshot.fields.DOI) || undefined;
      try {
        const resolved = await awaitCandidate(resolveForItem(resolver!, {
          item: snapshot,
          url: sourceURL,
          doi: localDOI,
          beforeAttempt: (routeId, attempt) => {
            throwIfCancelled();
            emit({
              stage: "route-start",
              itemID: snapshot.itemID,
              itemKey: snapshot.itemKey,
              title: snapshot.title,
              routeId,
              attempt,
            });
            throwIfCancelled();
          },
        }));
        throwIfCancelled();
        if (resolved.candidate) {
          completeItem({
            ...candidateToBatchPreview(item, resolved.candidate),
            attempts: resolved.attempts,
            terminalOutcome: resolved.terminalOutcome,
            candidateDigest: resolved.attempts.at(-1)?.candidateDigest
              || createCandidateDigest(resolved.candidate),
            routeId: resolved.candidate.evidence.routeId,
            normalizedDOI: localDOI,
          });
          continue;
        }
        const status = resolved.terminalOutcome === "blocked"
          ? "blocked"
          : resolved.terminalOutcome === "not-applicable" ? "skipped" : "failed";
        completeItem(emptyPreview(item, sourceURL, status, resolved.message || "没有可核对的更新内容", {
          attempts: resolved.attempts,
          terminalOutcome: resolved.terminalOutcome,
          normalizedDOI: localDOI,
        }));
      } catch (error) {
        throwIfCancelled();
        if (error instanceof BatchPreflightCancelledError) throw error;
        Zotero.debug(`[zmta] 候选解析失败：${errorMessage(error)}`);
        const message = localized(
          "无法获取或解析来源信息，本条目未更新。请检查来源或稍后重试。",
          "Could not retrieve or interpret the source. This item was not updated. Check the source or try again later.",
        );
        completeItem(emptyPreview(item, sourceURL, "failed", message, {
          terminalOutcome: "no-safe-candidate",
          normalizedDOI: localDOI,
        }));
      }
    }
    settled = true;
    dependencies.signal?.removeEventListener("abort", onAbort);
    emit({ stage: "batch-complete" });
    return previews;
  } finally {
    dependencies.signal?.removeEventListener("abort", onAbort);
  }
}

export function preflightBatch(
  selectedItems: any[],
  dependencies: BatchPreflightDependencies = {},
): Promise<BatchItemPreview[]> {
  return preflightBatchWith(selectedItems, dependencies, (resolver, request) => resolver.resolve(request));
}

export function preflightDOIBatch(
  selectedItems: any[],
  dependencies: BatchPreflightDependencies = {},
): Promise<BatchItemPreview[]> {
  return preflightBatchWith(selectedItems, dependencies, (resolver, request) => resolver.resolveDOI(request));
}

function makeBatchId(): string {
  try {
    const random = Zotero.Utilities?.randomString?.(8);
    if (random) return `batch-${Date.now()}-${random}`;
  } catch {
    // 非 Zotero 测试环境走回退值。
  }
  return `batch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function defaultGetItem(itemID: number): Promise<any> {
  return Zotero.Items.getAsync(itemID);
}

function validateSelectionItem(selection: BatchItemSelection, item: any, appliedFields: ReadonlyMap<string, unknown> = new Map(), appliedCreators?: readonly CandidateCreator[]): void {
  if (!item || Number(item.id) !== selection.itemID || String(item.key || "") !== selection.itemKey) {
    throw new Error("条目不存在或身份不匹配");
  }
  if (!isBibliographicItem(item) || item.deleted || item.isFeedItem === true) throw new Error("条目已不可用");
  if (typeof item.isEditable === "function" && item.isEditable() !== true) {
    throw new Error("条目已变为只读，未写入");
  }
  if (selection.candidate) {
    if (selection.candidate.identityReview?.required && !selection.identityConfirmed) {
      throw new Error("候选身份尚未由用户确认，未写入");
    }
    if (selection.candidate.identityReview?.required) {
      assertLocalIdentityEvidence(selection.candidate.identityReview, snapshotProviderItem(item).fields, appliedFields, appliedCreators);
    }
    const currentType = itemType(item);
    if (
      selection.candidate.item.itemID !== selection.itemID
      || selection.candidate.item.itemKey !== selection.itemKey
      || selection.candidate.item.libraryID !== Number(item.libraryID)
    ) {
      throw new Error("候选与当前条目身份不匹配");
    }
    if (
      selection.candidate.itemType !== currentType
      || selection.candidate.item.itemType !== currentType
    ) {
      throw new Error("审核后条目类型已变化，未写入");
    }
    const candidateRoute = selection.candidate.evidence.routeId;
    if (selection.routeId && candidateRoute !== selection.routeId) {
      throw new Error("候选路线与审核时不一致，未写入");
    }
    const digest = createCandidateDigest(selection.candidate);
    if (selection.candidateDigest && digest !== selection.candidateDigest) {
      throw new Error("候选内容与审核时不一致，未写入");
    }
    const evidenceDOI = normalizeDOI(selection.candidate.evidence.identifiers
      .find((entry) => entry.type.toLowerCase() === "doi")?.value);
    const expectedDOI = appliedFields.has("DOI")
      ? normalizeDOI(appliedFields.get("DOI"))
      : selection.normalizedDOI || evidenceDOI;
    const expectedISBNs = selection.candidate.evidence.identifiers
      .filter((entry) => entry.type.toLowerCase() === "isbn")
      .flatMap((entry) => isbnValues(entry.value));
    if (expectedISBNs.length > 0) {
      const currentISBNs = isbnValues(item.getField?.("ISBN"));
      const localISBNs = appliedFields.has("ISBN") ? isbnValues(appliedFields.get("ISBN")) : selection.candidate.localIdentifiers
        ?.filter((entry) => entry.type.toLowerCase() === "isbn")
        .flatMap((entry) => isbnValues(entry.value));
      if (!currentISBNs.some((value) => expectedISBNs.includes(value))
        || (localISBNs && JSON.stringify([...localISBNs].sort()) !== JSON.stringify([...currentISBNs].sort()))) {
        throw new Error("审核后 ISBN 已变化或来源 ISBN 不一致，未写入");
      }
    }
    if (expectedDOI) {
      const currentDOI = normalizeDOI(item.getField?.("DOI"));
      if (currentDOI !== expectedDOI || (evidenceDOI && evidenceDOI !== expectedDOI)) {
        throw new Error("审核后 DOI 已变化或来源 DOI 不一致，未写入");
      }
    }
  }
  const currentURL = getItemURL(item);
  if (!selection.candidate || selection.candidate.providerId === "douban") {
    const expectedURL = appliedFields.has("url") ? String(appliedFields.get("url")) : selection.candidate?.evidence.sourceURL;
    if (!currentURL || !extractDoubanSubject(currentURL)) throw new Error("条目不再具有豆瓣图书 URL");
    if (expectedURL && !isSameDoubanBook(expectedURL, currentURL)) {
      throw new Error("审核后豆瓣 subject 已变化，未写入");
    }
  } else if (selection.candidate.evidence.routeId === "url.web") {
    if (
      !currentURL
      || normalizeHTTPURL(currentURL) !== normalizeHTTPURL(appliedFields.has("url") ? appliedFields.get("url") : selection.candidate.evidence.sourceURL)
    ) {
      throw new Error("审核后来源 URL 已变化，未写入");
    }
  }
}

function testFallbackEvidence(selection: BatchItemSelection, item: any): SourceEvidence | null {
  if (selection.candidate) return null;
  if (!__testBuild__) throw new Error(`缺少来源候选，拒绝写入：${selection.itemKey}`);
  if (itemType(item) !== "book") throw new Error("旧测试 fixture 仅允许豆瓣图书条目");
  const sourceURL = getItemURL(item);
  const subject = sourceURL ? extractDoubanSubject(sourceURL) : null;
  if (!sourceURL || !subject) throw new Error("无法建立已验证的豆瓣来源证据");
  return {
    providerId: "douban",
    sourceURL,
    identifiers: [{ type: "douban-subject", value: subject }],
    fetchedAt: new Date().toISOString(),
  };
}

function mutationPort(item: any, dependencies: BatchApplyDependencies): ZoteroMutationPort<any, any> {
  const overrides: Partial<ZoteroMutationPort<any, any>> = { getItem: async () => item };
  if (dependencies.addAttachment) {
    overrides.createAttachment = (target, candidate) => dependencies.addAttachment!(target, candidate);
  }
  if (dependencies.createNote) {
    overrides.createNote = (target, content) => dependencies.createNote!(target, { content, defaultChecked: true });
  }
  if (dependencies.trashCreatedItem) overrides.trashCreatedItem = dependencies.trashCreatedItem;
  return new DelegatingZoteroMutationPort(
    overrides,
    dependencies.port || new DefaultZoteroMutationPort(),
  );
}

function legacyEvent(event: ChangeOperationEvent): BatchOperationEvent {
  const operation = event.operation;
  const field = operation.kind === "field-set";
  const creators = operation.kind === "creators-set";
  const after = field
    ? (event.status === "planned" ? operation.after : event.actualAfter)
    : creators
      ? (event.status === "planned" ? operation.after : event.actualAfter)
      : operation.kind === "attachment-create" ? operation.attachment : operation.content;
  return {
    batchId: event.planId,
    itemID: event.item.itemID,
    itemKey: event.item.itemKey,
    kind: toJournalOperationKind(operation.kind),
    identity: field ? operation.field : operation.operationId,
    status: event.status,
    before: field || creators ? operation.before : undefined,
    after,
    createdItemKey: event.createdItemKey,
    createdItemFingerprint: event.createdItemFingerprint,
    message: event.message,
    ...(event.recoveryRequired ? { recoveryRequired: true } : {}),
  };
}

function oldIdentity(operation: ChangeOperation): string {
  return operation.kind === "field-set" ? operation.field : operation.operationId;
}

function mapItemResult(
  itemResult: ChangeExecutionResult["items"][number],
  operations: readonly ChangeOperation[],
): BatchItemResult {
  const byId = new Map(operations.map((operation) => [operation.operationId, operation]));
  return {
    itemID: itemResult.item.itemID,
    itemKey: itemResult.item.itemKey,
    title: itemResult.item.title,
    status: itemResult.status,
    operations: itemResult.operations.map((result) => {
      const operation = byId.get(result.operationId)!;
      return {
        kind: toJournalOperationKind(result.kind),
        identity: oldIdentity(operation),
        status: result.status,
        message: result.message,
        ...(result.recoveryRequired ? { recoveryRequired: true } : {}),
      };
    }),
    message: itemResult.message,
  };
}

function summarize(batchId: string, items: BatchItemResult[]): BatchRunResult {
  return {
    batchId,
    total: items.length,
    applied: items.filter((item) => item.status === "applied").length,
    partial: items.filter((item) => item.status === "partial").length,
    skipped: items.filter((item) => item.status === "skipped").length,
    failed: items.filter((item) => item.status === "failed").length,
    items,
  };
}

export async function applyBatch(
  selections: BatchItemSelection[],
  dependencies: BatchApplyDependencies = {},
): Promise<BatchRunResult> {
  if (selections.length > MAX_BATCH_ITEMS) throw new BatchLimitError(selections.length);
  const batchId = dependencies.batchId || makeBatchId();
  const getItem = dependencies.getItem || defaultGetItem;
  const results: BatchItemResult[] = [];
  // 私有快照不与UI或异步日志回调共享可变引用；后续 guard 与冻结计划使用同一份审核输入。
  const executionSelections: BatchItemSelection[] = JSON.parse(JSON.stringify(selections));
  const complete = (result: BatchItemResult) => {
    results.push(result);
    try { dependencies.onItemComplete?.(JSON.parse(JSON.stringify(result)), results.length, executionSelections.length); }
    catch (error) { Zotero.debug(`[zmta] 进度显示失败：${error}`); }
  };
  for (const selection of executionSelections) {
    let item: any;
    try {
      item = await getItem(selection.itemID);
      validateSelectionItem(selection, item);
    } catch (error) {
      complete({
        itemID: selection.itemID,
        itemKey: selection.itemKey,
        title: selection.itemKey || String(selection.itemID),
        status: "failed",
        operations: [],
        message: errorMessage(error),
      });
      continue;
    }
    const ref = itemRef(item);
    try {
      // 旧 fixture 在测试构建中可补最小证据；生产构建必须透传 Provider candidate。
      const evidence = testFallbackEvidence(selection, item);
      const plan = selectionsToChangePlan(
        batchId,
        [selection],
        new Date().toISOString(),
        new Map([[selection.itemKey, ref]]),
        evidence ? new Map([[selection.itemKey, evidence]]) : new Map(),
      );
      const executor = new ChangeExecutor(
        mutationPort(item, dependencies),
        dependencies.onOperationStatus
          ? async (event) => dependencies.onOperationStatus!(legacyEvent(event))
          : undefined,
        (_ref, currentItem, appliedFields, appliedCreators) => validateSelectionItem(selection, currentItem, appliedFields, appliedCreators),
      );
      const execution = await executor.execute(plan);
      complete(mapItemResult(execution.items[0], plan.items[0].operations));
    } catch (error) {
      complete({
        itemID: ref.itemID,
        itemKey: ref.itemKey,
        title: ref.title,
        status: "failed",
        operations: [],
        message: errorMessage(error),
      });
    }
  }
  return summarize(batchId, results);
}

function failedIdentities(result: BatchItemResult): Set<string> {
  return new Set(result.operations
    .filter((entry) => entry.status === "failed" && !entry.recoveryRequired)
    .map((entry) => `${entry.kind}:${entry.identity}`));
}

export function hasRetryableBatchOperations(result: BatchItemResult | undefined): boolean {
  return Boolean(result && (result.status === "failed" || result.status === "partial")
    && (result.operations.length === 0 || result.operations.some((entry) => entry.status === "failed" && !entry.recoveryRequired)));
}

function retrySelection(
  original: BatchItemSelection,
  preview: BatchItemPreview,
  previous: BatchItemResult,
): BatchItemSelection | null {
  if (preview.status !== "ready") return null;
  const review = original.candidate?.identityReview;
  if (review?.required && (!original.identityConfirmed || !review.localEvidence
    || JSON.stringify(review.localEvidence) !== JSON.stringify(preview.candidate?.identityReview?.localEvidence))) return null;
  const failed = failedIdentities(previous);
  const fields = preview.fields.filter((candidate) => failed.has(`field:${candidate.field}`));
  const creators = failed.has("creators:creators:set")
    && original.creators
    && preview.creators
    && JSON.stringify(original.creators.local) === JSON.stringify(preview.creators.local)
    && JSON.stringify(original.creators.incoming) === JSON.stringify(preview.creators.incoming)
    ? preview.creators
    : undefined;
  const attachments = preview.attachments.filter((candidate) =>
    failed.has(`attachment:${candidate.batchOperationId}`));
  const notes = preview.notes.filter((candidate) => failed.has(`note:${candidate.batchOperationId}`));
  const originalFields = new Map(original.fields.map((candidate) => [candidate.field, candidate]));
  const originalAttachments = new Set(original.attachments.map((candidate) => candidate.batchOperationId));
  const originalNotes = new Set(original.notes.map((candidate) => candidate.batchOperationId));
  const filteredFields = fields.filter((candidate) => {
    const before = originalFields.get(candidate.field);
    return before
      && String(before.local ?? "") === String(candidate.local ?? "")
      && String(before.incoming ?? "") === String(candidate.incoming ?? "");
  });
  const filteredAttachments = attachments.filter((candidate) => originalAttachments.has(candidate.batchOperationId));
  const filteredNotes = notes.filter((candidate) => originalNotes.has(candidate.batchOperationId));
  if (
    original.routeId && preview.routeId !== original.routeId
    || original.normalizedDOI && preview.normalizedDOI !== original.normalizedDOI
    || original.candidateDigest && preview.candidateDigest !== original.candidateDigest
  ) return null;
  if (!creators && filteredFields.length === 0 && filteredAttachments.length === 0 && filteredNotes.length === 0) return null;
  return {
    itemID: original.itemID,
    itemKey: original.itemKey,
    fields: filteredFields,
    creators,
    attachments: filteredAttachments,
    notes: filteredNotes,
    candidate: preview.candidate,
    attempts: preview.attempts,
    candidateDigest: preview.candidateDigest,
    routeId: preview.routeId,
    normalizedDOI: preview.normalizedDOI,
    identityConfirmed: original.identityConfirmed,
  };
}

/** 只将原失败且原先选择的操作交给再次审核；成功操作和新字段永不出现。 */
export function buildRetryReviewPreview(original: BatchItemSelection, preview: BatchItemPreview, previous: BatchItemResult): BatchItemPreview {
  const failed = failedIdentities(previous);
  const wholeItem = previous.status === "failed" && previous.operations.length === 0;
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const fields = preview.fields.filter(field => original.fields.some(old => old.field === field.field)
    && (wholeItem || failed.has(`field:${field.field}`))).map(field => ({ ...field,
      defaultChecked: original.fields.some(old => old.field === field.field && same(old.local, field.local) && same(old.incoming, field.incoming)),
    }));
  const creators = original.creators && preview.creators && (wholeItem || failed.has("creators:creators:set"))
    ? { ...preview.creators, defaultChecked: same(original.creators.local, preview.creators.local) && same(original.creators.incoming, preview.creators.incoming) } : undefined;
  const attachments = preview.attachments.filter(candidate => original.attachments.some(old => old.batchOperationId === candidate.batchOperationId && same(old, candidate))
    && (wholeItem || failed.has(`attachment:${candidate.batchOperationId}`)));
  const notes = preview.notes.filter(candidate => original.notes.some(old => old.batchOperationId === candidate.batchOperationId && same(old, candidate))
    && (wholeItem || failed.has(`note:${candidate.batchOperationId}`)));
  if (preview.status === "ready" && !fields.length && !creators && !attachments.length && !notes.length) {
    return { ...preview, status: "skipped", message: "此前失败的内容已变化或无需更新，无法安全匹配。请从原条目重新查看可更新内容。", fields, creators, attachments, notes };
  }
  return { ...preview, fields, creators, attachments, notes };
}

function bindRetrySelections(previews: BatchItemPreview[], selected: BatchItemSelection[]): BatchItemSelection[] {
  const seen = new Set<string>();
  return selected.map(selection => {
    const preview = previews.find(p => p.itemID === selection.itemID && p.itemKey === selection.itemKey && p.status === "ready");
    if (!preview || seen.has(selection.itemKey) || preview.candidateDigest !== selection.candidateDigest
      || (preview.identityReview?.required && !selection.identityConfirmed)) throw new Error("重试选择不属于本次审核");
    seen.add(selection.itemKey);
    const bind = <T>(available: T[], chosen: T[]): T[] => {
      const used = new Set<number>();
      return chosen.map(value => {
        const index = available.findIndex(candidate => JSON.stringify(candidate) === JSON.stringify(value));
        if (index < 0 || used.has(index)) throw new Error("重试选择超出了原失败内容范围");
        used.add(index);
        return available[index];
      });
    };
    if (selection.creators && JSON.stringify(selection.creators) !== JSON.stringify(preview.creators)) throw new Error("重试作者选择超出范围");
    return { ...selection, fields: bind(preview.fields, selection.fields),
      creators: selection.creators ? preview.creators : undefined,
      attachments: bind(preview.attachments, selection.attachments), notes: bind(preview.notes, selection.notes),
      candidate: preview.candidate, attempts: preview.attempts, routeId: preview.routeId, normalizedDOI: preview.normalizedDOI };
  }).filter(s => s.fields.length || s.creators || s.attachments.length || s.notes.length);
}

export async function retryFailedBatch(
  originalSelections: BatchItemSelection[],
  previousResult: BatchRunResult,
  dependencies: BatchRetryDependencies = {},
): Promise<BatchRunResult> {
  const getItem = dependencies.getItem || defaultGetItem;
  const previousByKey = new Map(previousResult.items.map((item) => [item.itemKey, item]));
  const retryableOriginals = originalSelections.filter((selection) => {
    const previous = previousByKey.get(selection.itemKey);
    return hasRetryableBatchOperations(previous);
  });
  const items: any[] = [];
  for (const selection of retryableOriginals) {
    if (dependencies.signal?.aborted) break;
    try {
      const item = await getItem(selection.itemID);
      if (item) items.push(item);
    } catch {
      // 无法读取的条目不会进入重新预检。
    }
  }
  const originalsByKey = new Map(retryableOriginals.map((selection) => [selection.itemKey, selection]));
  const preflightDependencies = {
    fetch: dependencies.fetch,
    provider: dependencies.provider,
    resolver: dependencies.resolver,
    signal: dependencies.signal,
    onProgress: dependencies.onProgress,
  };
  const previews = dependencies.fetch || dependencies.provider
    ? await preflightBatch(items, preflightDependencies)
    : await preflightBatchWith(items, preflightDependencies, (resolver, request) => {
      const original = originalsByKey.get(request.item.itemKey);
      return original?.routeId === "doi.search"
        ? resolver.resolveDOI(request)
        : resolver.resolve(request);
    });
  if (dependencies.signal?.aborted) {
    throw new BatchPreflightCancelledError(previews.length, items.length);
  }
  const previewsByKey = new Map(previews.map((preview) => [preview.itemKey, preview]));
  let retries: BatchItemSelection[] = [];
  if (dependencies.review) {
    const eligible = retryableOriginals.flatMap(original => {
      const preview = previewsByKey.get(original.itemKey);
      const previous = previousByKey.get(original.itemKey);
      return preview && previous ? [buildRetryReviewPreview(original, preview, previous)] : [];
    });
    const reviewed = await dependencies.review(JSON.parse(JSON.stringify(eligible)));
    if (reviewed === null) throw new BatchPreflightCancelledError(previews.length, items.length);
    retries = bindRetrySelections(eligible, reviewed);
    if (!retries.length) throw new BatchPreflightCancelledError(previews.length, items.length);
  } else {
    for (const original of retryableOriginals) {
      const previous = previousByKey.get(original.itemKey);
      const preview = previewsByKey.get(original.itemKey);
      if (!previous || !preview) continue;
      const selection = retrySelection(original, preview, previous);
      if (selection) retries.push(selection);
    }
  }
  await dependencies.onResolvedSelections?.(retries);
  if (dependencies.signal?.aborted) {
    throw new BatchPreflightCancelledError(previews.length, items.length);
  }
  return applyBatch(retries, {
    ...dependencies,
    getItem,
    batchId: dependencies.batchId || previousResult.batchId,
  });
}
