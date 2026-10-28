import type {
  CandidateAttachment,
  CandidateCreator,
  CandidateEnvelope,
  CandidateField,
  CandidateNote,
  SourceIdentifier,
} from "../update/contracts";
import type { ProviderItemSnapshot } from "../update/provider";
import {
  createCandidateDigest,
  normalizeDOI,
  type AttemptEvidence,
  type AttemptOutcome,
  type ResolutionRoute,
  type RouteAttemptRequest,
  type RouteAttemptResult,
} from "../update/resolution";
import {
  createSearchTranslatorAdapter,
  SearchTranslatorError,
  type SearchTranslation,
  type SearchTranslator,
} from "./searchTranslator";

declare const Zotero: any;

const PROVIDER_ID = "zotero-search";
const ROUTE_ID = "doi.search" as const;

const RESERVED_FIELDS = new Set([
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

export interface DOISearchRouteOptions {
  readonly translator?: SearchTranslator;
  readonly now?: () => Date;
}

function nonemptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalizeFields(item: Record<string, unknown>): CandidateField[] {
  return Object.keys(item)
    .filter((field) => !RESERVED_FIELDS.has(field))
    .sort()
    .flatMap((field): CandidateField[] => {
      const value = item[field];
      return value === undefined
        || value === null
        || (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
        ? []
        : [{ field, value }];
    });
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
    const creatorType = nonemptyString(creator.creatorType);
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

function normalizeAttachments(item: Record<string, unknown>): CandidateAttachment[] {
  if (!Array.isArray(item.attachments)) return [];
  const occurrences = new Map<string, number>();
  return item.attachments.flatMap((candidate): CandidateAttachment[] => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const attachment = candidate as Record<string, unknown>;
    const normalized = {
      url: attachment.url === undefined ? undefined : String(attachment.url),
      title: attachment.title === undefined ? undefined : String(attachment.title),
      mimeType: attachment.mimeType === undefined ? undefined : String(attachment.mimeType),
      snapshot: attachment.snapshot === undefined ? undefined : Boolean(attachment.snapshot),
    };
    const hash = shortHash(JSON.stringify(normalized));
    const occurrence = occurrences.get(hash) || 0;
    occurrences.set(hash, occurrence + 1);
    return [{ operationId: `attachment:${hash}:${occurrence}`, ...normalized }];
  });
}

function normalizeNotes(item: Record<string, unknown>): CandidateNote[] {
  if (!Array.isArray(item.notes)) return [];
  const occurrences = new Map<string, number>();
  return item.notes.flatMap((candidate): CandidateNote[] => {
    let content: unknown;
    if (typeof candidate === "string") content = candidate;
    else if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      const note = candidate as Record<string, unknown>;
      content = note.note ?? note.content ?? note.text;
    }
    if (typeof content !== "string" || content.length === 0) return [];
    const hash = shortHash(content);
    const occurrence = occurrences.get(hash) || 0;
    occurrences.set(hash, occurrence + 1);
    return [{ operationId: `note:${hash}:${occurrence}`, content }];
  });
}

function inputIdentifiers(doi: string | null): readonly SourceIdentifier[] {
  const normalized = normalizeDOI(doi);
  return normalized ? [{ type: "doi", value: normalized }] : [];
}

function returnedDOI(item: Record<string, unknown>): { raw: string | null; normalized: string | null } {
  const raw = nonemptyString(item.DOI) || nonemptyString(item.doi);
  return { raw, normalized: normalizeDOI(raw) };
}

function returnedIdentifiers(item: Record<string, unknown>): readonly SourceIdentifier[] {
  const doi = returnedDOI(item).raw;
  return doi ? [{ type: "doi", value: doi }] : [];
}

function comparableVersion(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim().toLocaleLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function hasVersionAmbiguity(local: ProviderItemSnapshot, translated: Record<string, unknown>): boolean {
  // `version` 是 Zotero 同步修订号，不是出版版本；只比较可写的出版 edition/versionNumber。
  return ["edition", "versionNumber"].some((field) => {
    const left = comparableVersion(local.fields[field]);
    const right = comparableVersion(translated[field]);
    return (left !== null || right !== null) && left !== right;
  });
}

function evidenceBase(
  request: RouteAttemptRequest,
  fetchedAt: string,
  outcome: AttemptEvidence["outcome"],
  options: {
    returned?: readonly SourceIdentifier[];
    translation?: SearchTranslation;
    errorCode?: string;
    diagnostic?: AttemptEvidence["diagnostic"];
  } = {},
): AttemptEvidence {
  return {
    routeId: ROUTE_ID,
    attempt: request.attempt,
    inputIdentifiers: inputIdentifiers(request.doi),
    returnedIdentifiers: options.returned || [],
    translator: options.translation?.translator,
    sourceId: options.translation?.sourceId || "unknown",
    fetchedAt,
    outcome,
    errorCode: options.errorCode,
    diagnostic: options.diagnostic,
  };
}

function failure(
  evidence: AttemptEvidence,
  retryable = false,
): RouteAttemptResult {
  return { candidate: null, evidence, retryable };
}

function metadataItem(item: ProviderItemSnapshot) {
  return {
    itemID: item.itemID,
    itemKey: item.itemKey,
    libraryID: item.libraryID,
    itemType: item.itemType,
    title: item.title,
  };
}

function classifySearchError(error: unknown): SearchTranslatorError {
  if (error instanceof SearchTranslatorError) return error;
  if (error && typeof error === "object") {
    const candidate = error as { code?: unknown; retryable?: unknown; message?: unknown };
    if (["fetch-failed", "translator-missing", "no-result", "multiple-results", "invalid-response"].includes(String(candidate.code))) {
      return new SearchTranslatorError(
        candidate.code as SearchTranslatorError["code"],
        typeof candidate.message === "string" ? candidate.message : String(candidate.code),
        candidate.retryable === true,
        "route",
        { cause: error },
      );
    }
  }
  return new SearchTranslatorError(
    "fetch-failed",
    error instanceof Error ? error.message : String(error),
    true,
    "route",
    { cause: error },
  );
}

function attemptOutcomeForError(code: SearchTranslatorError["code"]): AttemptOutcome {
  return code === "translator-missing" ? "unsupported" : code;
}

export class DOISearchRoute implements ResolutionRoute {
  readonly id = ROUTE_ID;
  private readonly translator: SearchTranslator;
  private readonly now: () => Date;

  constructor(options: DOISearchRouteOptions = {}) {
    this.translator = options.translator || createSearchTranslatorAdapter();
    this.now = options.now || (() => new Date());
  }

  async attempt(request: RouteAttemptRequest): Promise<RouteAttemptResult> {
    const fetchedAt = this.now().toISOString();
    const doi = normalizeDOI(request.doi);
    if (!doi) {
      return failure(evidenceBase(request, fetchedAt, "identity-evidence-missing", {
        errorCode: "identifier-missing",
      }));
    }

    let translation: SearchTranslation;
    try {
      translation = await this.translator.translateDOI(doi);
    } catch (error) {
      const typed = classifySearchError(error);
      const outcome = attemptOutcomeForError(typed.code);
      return failure(evidenceBase(request, fetchedAt, outcome, {
        errorCode: typed.code,
        diagnostic: typed.diagnostic,
      }), typed.retryable);
    }

    const returned = returnedIdentifiers(translation.item);
    const translatedDOI = returnedDOI(translation.item).normalized;
    if (!translatedDOI) {
      return failure(evidenceBase(request, fetchedAt, "identity-evidence-missing", {
        returned,
        translation,
        errorCode: "identity-evidence-missing",
      }));
    }
    if (translatedDOI !== doi) {
      return failure(evidenceBase(request, fetchedAt, "identifier-conflict", {
        returned,
        translation,
        errorCode: "identifier-conflict",
      }));
    }

    const itemType = nonemptyString(translation.item.itemType);
    if (!itemType) {
      return failure(evidenceBase(request, fetchedAt, "invalid-response", {
        returned,
        translation,
        errorCode: "invalid-response",
      }));
    }
    if (itemType !== request.item.itemType) {
      return failure(evidenceBase(request, fetchedAt, "item-type-conflict", {
        returned,
        translation,
        errorCode: "item-type-conflict",
      }));
    }
    if (hasVersionAmbiguity(request.item, translation.item)) {
      return failure(evidenceBase(request, fetchedAt, "version-ambiguous", {
        returned,
        translation,
        errorCode: "version-ambiguous",
      }));
    }
    const normalizedCreators = normalizeCreators(translation.item.creators, itemType);
    if (normalizedCreators.invalid) {
      return failure(evidenceBase(request, fetchedAt, "invalid-response", {
        returned,
        translation,
        errorCode: "invalid-creators",
      }));
    }
    if (translation.sourceId === "unknown") {
      return failure(evidenceBase(request, fetchedAt, "identity-evidence-missing", {
        returned,
        translation,
        errorCode: "source-unknown",
      }));
    }

    const candidate: CandidateEnvelope = {
      providerId: PROVIDER_ID,
      item: metadataItem(request.item),
      evidence: {
        providerId: PROVIDER_ID,
        sourceURL: `https://doi.org/${doi}`,
        identifiers: returned,
        fetchedAt,
        routeId: ROUTE_ID,
        sourceId: translation.sourceId,
        translator: translation.translator,
      },
      itemType,
      fields: normalizeFields(translation.item),
      ...(normalizedCreators.creators && normalizedCreators.creators.length > 0
        ? { creators: normalizedCreators.creators }
        : {}),
      attachments: normalizeAttachments(translation.item),
      notes: normalizeNotes(translation.item),
    };
    const evidence: AttemptEvidence = {
      ...evidenceBase(request, fetchedAt, "candidate", { returned, translation }),
      candidateDigest: createCandidateDigest(candidate),
    };
    return { candidate, evidence };
  }
}

export function createDOISearchRoute(options?: DOISearchRouteOptions): DOISearchRoute {
  return new DOISearchRoute(options);
}
