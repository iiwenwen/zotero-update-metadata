import type {
  CandidateAttachment,
  CandidateCreator,
  CandidateEnvelope,
  CandidateField,
  CandidateIdentityReview,
  CandidateNote,
  IdentityMatchField,
  MetadataItemRef,
  SourceIdentifier,
  TranslatorEvidence,
} from "../update/contracts";
import {
  createCandidateDigest,
  normalizeDOI,
  normalizeHTTPURL,
  type AttemptOutcome,
  type AttemptDiagnostic,
  type ResolutionRoute,
  type RouteAttemptRequest,
  type RouteAttemptResult,
} from "../update/resolution";
import {
  WebTranslatorError,
  createWebTranslatorAdapter,
  type EvidenceWebTranslator,
  type WebTranslationResult,
} from "./webTranslator";
import { comparableText, createLocalIdentityEvidence, creatorNames, identityYear as year } from "../update/identityReview";

declare const Zotero: any;

const ROUTE_ID = "url.web" as const;
const PROVIDER_ID = "url-web";
const FILTERED_FIELDS = new Set([
  "attachments",
  "collections",
  "creators",
  "dateAdded",
  "dateModified",
  "itemID",
  "itemKey",
  "itemType",
  "key",
  "libraryID",
  "notes",
  "relations",
  "select",
  "tags",
  "uri",
  "version",
]);

export interface URLWebRouteOptions {
  readonly translator?: EvidenceWebTranslator;
  readonly now?: () => Date;
}

function validWebURL(value: unknown): string | null {
  return normalizeHTTPURL(value);
}

function metadataItemRef(request: RouteAttemptRequest): MetadataItemRef {
  return {
    itemID: request.item.itemID,
    itemKey: request.item.itemKey,
    libraryID: request.item.libraryID,
    itemType: request.item.itemType,
    title: request.item.title,
  };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sourceId(item: Record<string, unknown>): string {
  return nonEmptyString(item.libraryCatalog)
    || nonEmptyString(item.catalog)
    || "unknown";
}

function translatedDOI(item: Record<string, unknown>): string | null {
  return normalizeDOI(item.DOI ?? item.doi);
}

function normalizedVersion(value: unknown): string | null {
  const text = nonEmptyString(value);
  return text ? text.toLocaleLowerCase().replace(/\s+/g, " ") : null;
}

function hasVersionAmbiguity(local: Readonly<Record<string, unknown>>, incoming: Record<string, unknown>): boolean {
  // `version` 是 Zotero 对象修订号；出版版本使用 edition/versionNumber。
  return ["edition", "versionNumber"].some((field) => {
    const left = normalizedVersion(local[field]);
    const right = normalizedVersion(incoming[field]);
    return left !== null || right !== null ? left !== right : false;
  });
}

export function isbnValues(value: unknown): readonly string[] {
  return [...new Set(String(value ?? "")
    .split(/[\s,;]+/)
    .map((entry) => entry.replace(/[^0-9Xx]/g, "").toUpperCase())
    .filter((entry) => entry.length === 10 || entry.length === 13))];
}

function overlaps(left: readonly string[], right: readonly string[]): boolean {
  const values = new Set(left);
  return right.some((entry) => values.has(entry));
}

function identityReviewForURL(
  request: RouteAttemptRequest,
  url: string,
  incoming: Record<string, unknown>,
): { review?: CandidateIdentityReview; verifiedISBNs: readonly string[]; reject?: "identifier-conflict" | "identity-evidence-missing" } {
  const localISBNs = isbnValues(request.item.fields.ISBN);
  const incomingISBNs = isbnValues(incoming.ISBN);
  if (localISBNs.length > 0 && incomingISBNs.length > 0) {
    if (!overlaps(localISBNs, incomingISBNs)) return { verifiedISBNs: [], reject: "identifier-conflict" };
    return { verifiedISBNs: incomingISBNs };
  }

  const localTitle = comparableText(request.item.fields.title ?? request.item.title);
  const incomingTitle = comparableText(incoming.title);
  if (!localTitle || !incomingTitle || localTitle !== incomingTitle) {
    return { verifiedISBNs: [], reject: "identity-evidence-missing" };
  }

  const matchedFields: IdentityMatchField[] = ["title"];
  const localCreators = creatorNames(request.item.fields.creators);
  const incomingCreators = creatorNames(incoming.creators);
  if (localCreators.length > 0 && incomingCreators.length > 0 && overlaps(localCreators, incomingCreators)) {
    matchedFields.push("creator");
  }
  const localYear = year(request.item.fields.date);
  const incomingYear = year(incoming.date);
  if (localYear && incomingYear && localYear === incomingYear) matchedFields.push("year");

  const localPublisher = comparableText(request.item.fields.publisher ?? request.item.fields.publicationTitle);
  const incomingPublisher = comparableText(incoming.publisher ?? incoming.publicationTitle);
  if (localPublisher && incomingPublisher && localPublisher === incomingPublisher) matchedFields.push("publisher");

  const incomingURL = validWebURL(incoming.url);
  if (incomingURL && incomingURL === url) matchedFields.push("url");
  if (matchedFields.length < 2) {
    return { verifiedISBNs: [], reject: "identity-evidence-missing" };
  }
  return {
    verifiedISBNs: [],
    review: {
      required: true,
      matchedFields: Object.freeze(matchedFields),
      summary: `系统已匹配：${matchedFields.join("、")}；缺少可直接放行的强标识，请确认是同一对象`,
      localEvidence: createLocalIdentityEvidence({ ...request.item.fields, title: request.item.fields.title ?? request.item.title, url }, matchedFields),
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

function fields(item: Record<string, unknown>): CandidateField[] {
  return Object.entries(item).sort(([left], [right]) => left.localeCompare(right)).flatMap(([field, value]) => (
    FILTERED_FIELDS.has(field)
      || value === undefined
      || value === null
      || (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
      ? []
      : [{ field, value }]
  ));
}

function normalizeCreators(
  value: unknown,
  targetItemType: string,
): { creators?: CandidateCreator[]; invalid: boolean } {
  if (value === undefined || value === null) return { invalid: false };
  if (!Array.isArray(value)) return { invalid: true };
  if (value.length === 0) return { creators: [], invalid: false };

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

    let creatorTypeID: number;
    try {
      creatorTypeID = Number(Zotero.CreatorTypes.getID(creatorType));
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
  return { creators, invalid: false };
}

function attachments(item: Record<string, unknown>): CandidateAttachment[] {
  if (!Array.isArray(item.attachments)) return [];
  const occurrences = new Map<string, number>();
  return item.attachments.flatMap((entry): CandidateAttachment[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const value = entry as Record<string, unknown>;
    const normalized = {
      url: value.url === undefined ? undefined : String(value.url),
      title: value.title === undefined ? undefined : String(value.title),
      mimeType: value.mimeType === undefined ? undefined : String(value.mimeType),
      snapshot: value.snapshot === undefined ? undefined : Boolean(value.snapshot),
    };
    const hash = shortHash(JSON.stringify(normalized));
    const occurrence = occurrences.get(hash) || 0;
    occurrences.set(hash, occurrence + 1);
    return [{ operationId: `attachment:${hash}:${occurrence}`, ...normalized }];
  });
}

function notes(item: Record<string, unknown>): CandidateNote[] {
  if (!Array.isArray(item.notes)) return [];
  const occurrences = new Map<string, number>();
  return item.notes.flatMap((entry): CandidateNote[] => {
    const content = typeof entry === "string"
      ? entry
      : entry && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as Record<string, unknown>).note
          ?? (entry as Record<string, unknown>).content
          ?? (entry as Record<string, unknown>).text
        : null;
    if (typeof content !== "string" || !content) return [];
    const hash = shortHash(content);
    const occurrence = occurrences.get(hash) || 0;
    occurrences.set(hash, occurrence + 1);
    return [{ operationId: `note:${hash}:${occurrence}`, content }];
  });
}

function translatorSourceIdentifiers(url: string, doi: string | null): SourceIdentifier[] {
  return [
    { type: "url", value: url },
    ...(doi ? [{ type: "doi", value: doi }] : []),
  ];
}

function resultEvidence(
  request: RouteAttemptRequest,
  fetchedAt: string,
  outcome: AttemptOutcome,
  options: {
    returnedDOI?: string | null;
    translator?: TranslatorEvidence;
    source?: string;
    digest?: string;
    errorCode?: string;
    diagnostic?: AttemptDiagnostic;
  } = {},
) {
  const url = validWebURL(request.url);
  const localDOI = normalizeDOI(request.doi ?? request.item.fields.DOI);
  return {
    routeId: ROUTE_ID,
    attempt: request.attempt,
    inputIdentifiers: url ? translatorSourceIdentifiers(url, localDOI) : [],
    returnedIdentifiers: options.returnedDOI
      ? [{ type: "doi", value: options.returnedDOI }]
      : [],
    translator: options.translator,
    sourceId: options.source || "unknown",
    fetchedAt,
    outcome,
    candidateDigest: options.digest,
    errorCode: options.errorCode,
    diagnostic: options.diagnostic,
  } as const;
}

function failure(
  request: RouteAttemptRequest,
  fetchedAt: string,
  outcome: AttemptOutcome,
  retryable: boolean,
  options: Parameters<typeof resultEvidence>[3] = {},
): RouteAttemptResult {
  return {
    candidate: null,
    evidence: resultEvidence(request, fetchedAt, outcome, options),
    retryable,
  };
}

function errorOutcome(error: WebTranslatorError): AttemptOutcome {
  switch (error.code) {
    case "translator-missing": return "unsupported";
    case "no-result": return "no-result";
    case "multiple-results": return "multiple-results";
    case "invalid-response": return "invalid-response";
    case "fetch-failed": return "fetch-failed";
  }
}

export class URLWebRoute implements ResolutionRoute {
  readonly id = ROUTE_ID;
  private readonly translator: EvidenceWebTranslator;
  private readonly now: () => Date;

  constructor(options: URLWebRouteOptions = {}) {
    this.translator = options.translator || createWebTranslatorAdapter();
    this.now = options.now || (() => new Date());
  }

  async attempt(request: RouteAttemptRequest): Promise<RouteAttemptResult> {
    const fetchedAt = this.now().toISOString();
    const url = validWebURL(request.url);
    if (!url) return failure(request, fetchedAt, "unsupported", false, { errorCode: "unsupported" });

    const localDOI = normalizeDOI(request.doi ?? request.item.fields.DOI);

    let translated: WebTranslationResult;
    try {
      translated = await this.translator.translateDetailed(url);
    } catch (error) {
      if (error instanceof WebTranslatorError) {
        const outcome = errorOutcome(error);
        return failure(request, fetchedAt, outcome, error.retryable, {
          errorCode: error.code,
          diagnostic: error.diagnostic,
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      return failure(request, fetchedAt, "fetch-failed", true, {
        errorCode: "fetch-failed",
        diagnostic: { stage: "route", message, ...(error instanceof Error ? { errorName: error.name } : {}) },
      });
    }

    const returnedDOI = translatedDOI(translated.item);
    const actualSourceId = sourceId(translated.item);
    const evidenceOptions = {
      returnedDOI,
      translator: translated.translator,
      source: actualSourceId,
    };
    if (localDOI && !returnedDOI) {
      return failure(request, fetchedAt, "identity-evidence-missing", false, {
        ...evidenceOptions,
        errorCode: "identity-evidence-missing",
      });
    }
    if (localDOI && returnedDOI !== localDOI) {
      return failure(request, fetchedAt, "identifier-conflict", false, {
        ...evidenceOptions,
        errorCode: "identifier-conflict",
      });
    }
    if (actualSourceId === "unknown") {
      return failure(request, fetchedAt, "identity-evidence-missing", false, {
        ...evidenceOptions,
        errorCode: "identity-evidence-missing",
      });
    }

    const incomingItemType = nonEmptyString(translated.item.itemType);
    if (!incomingItemType) {
      return failure(request, fetchedAt, "invalid-response", false, {
        ...evidenceOptions,
        errorCode: "invalid-response",
      });
    }
    if (incomingItemType !== request.item.itemType) {
      return failure(request, fetchedAt, "item-type-conflict", false, {
        ...evidenceOptions,
        errorCode: "item-type-conflict",
      });
    }
    if (hasVersionAmbiguity(request.item.fields, translated.item)) {
      return failure(request, fetchedAt, "version-ambiguous", false, {
        ...evidenceOptions,
        errorCode: "version-ambiguous",
      });
    }

    const normalizedCreators = normalizeCreators(translated.item.creators, incomingItemType);
    if (normalizedCreators.invalid) {
      return failure(request, fetchedAt, "invalid-response", false, {
        ...evidenceOptions,
        errorCode: "invalid-creators",
      });
    }

    const identity = localDOI
      ? { verifiedISBNs: [] as readonly string[] }
      : identityReviewForURL(request, url, translated.item);
    if (identity.reject) {
      return failure(request, fetchedAt, identity.reject, false, {
        ...evidenceOptions,
        errorCode: identity.reject,
      });
    }

    const identifiers: SourceIdentifier[] = [
      ...(returnedDOI ? [{ type: "doi", value: returnedDOI }] : []),
      ...identity.verifiedISBNs.map((value) => ({ type: "isbn", value })),
      ...(!returnedDOI && identity.verifiedISBNs.length === 0 ? [{ type: "url", value: url }] : []),
    ];
    const candidate: CandidateEnvelope = {
      providerId: PROVIDER_ID,
      item: metadataItemRef(request),
      evidence: {
        providerId: PROVIDER_ID,
        sourceURL: url,
        identifiers,
        fetchedAt,
        routeId: ROUTE_ID,
        sourceId: actualSourceId,
        translator: translated.translator,
      },
      itemType: incomingItemType,
      fields: fields(translated.item),
      ...(normalizedCreators.creators && normalizedCreators.creators.length > 0
        ? { creators: normalizedCreators.creators }
        : {}),
      attachments: attachments(translated.item),
      notes: notes(translated.item),
      ...(identity.review ? { identityReview: identity.review } : {}),
      ...(identity.verifiedISBNs.length > 0
        ? { localIdentifiers: isbnValues(request.item.fields.ISBN).map((value) => ({ type: "isbn", value })) }
        : {}),
    };
    return {
      candidate,
      evidence: resultEvidence(request, fetchedAt, "candidate", {
        ...evidenceOptions,
        digest: createCandidateDigest(candidate),
      }),
    };
  }
}

export function createURLWebRoute(options?: URLWebRouteOptions): URLWebRoute {
  return new URLWebRoute(options);
}
