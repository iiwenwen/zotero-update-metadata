import type {
  CandidateAttachment,
  CandidateCreator,
  CandidateEnvelope,
  CandidateField,
  CandidateNote,
  MetadataItemRef,
  SourceIdentifier,
} from "../update/contracts";
import {
  ProviderError,
  type MetadataProvider,
  type ProviderCapabilities,
  type ProviderErrorCode,
  type ProviderFetchRequest,
  type ProviderItemSnapshot,
} from "../update/provider";
import {
  WebTranslatorError,
  createWebTranslatorAdapter,
  type WebTranslator,
} from "./webTranslator";

declare const Zotero: any;

const DOUBAN_PROVIDER_ID = "douban";
const DOUBAN_IDENTIFIER_TYPE = "douban-subject";

const DOUBAN_FIELDS = Object.freeze([
  "title",
  "shortTitle",
  "publisher",
  "date",
  "ISBN",
  "numPages",
  "abstractNote",
  "url",
  "language",
  "series",
  "edition",
  "place",
  "extra",
] as const);

export const DOUBAN_PROVIDER_CAPABILITIES: ProviderCapabilities = Object.freeze({
  itemTypes: Object.freeze(["book"]),
  identifierTypes: Object.freeze([DOUBAN_IDENTIFIER_TYPE]),
  fields: true,
  attachments: "create-only",
  notes: "create-only",
});

export interface DoubanProviderOptions {
  readonly translator?: WebTranslator;
  readonly now?: () => Date;
}

export interface DoubanSource {
  readonly translatedItem: Record<string, unknown>;
  readonly fetchedAt: string;
}

export function isDoubanBookURL(value: unknown): value is string {
  return typeof value === "string"
    && /^https:\/\/book\.douban\.com\/subject\/\d+\//.test(value);
}

export function extractDoubanSubject(value: unknown): string | null {
  if (!isDoubanBookURL(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "book.douban.com") return null;
    return url.pathname.match(/^\/subject\/(\d+)\/?$/)?.[1] || null;
  } catch {
    return null;
  }
}

function sourceURL(item: ProviderItemSnapshot): string | null {
  const value = item.fields.url;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function metadataItemRef(item: ProviderItemSnapshot): MetadataItemRef {
  return {
    itemID: item.itemID,
    itemKey: item.itemKey,
    libraryID: item.libraryID,
    itemType: item.itemType,
    title: item.title,
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

function normalizeFields(item: Record<string, unknown>): CandidateField[] {
  return DOUBAN_FIELDS.flatMap((field) => {
    const value = item[field];
    return value === undefined || value === null ? [] : [{ field, value }];
  });
}

function normalizeCreators(value: unknown): readonly CandidateCreator[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new ProviderError(DOUBAN_PROVIDER_ID, "invalid-response", "Translator 返回了无效 Creator 列表", false);
  }
  if (value.length === 0) return undefined;

  let itemTypeID: number;
  try {
    itemTypeID = Number(Zotero.ItemTypes.getID("book"));
  } catch {
    itemTypeID = 0;
  }
  if (!itemTypeID) {
    throw new ProviderError(DOUBAN_PROVIDER_ID, "invalid-response", "无法验证 Creator 条目类型", false);
  }

  const creators: CandidateCreator[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ProviderError(DOUBAN_PROVIDER_ID, "invalid-response", "Translator 返回了无效 Creator", false);
    }
    const creator = entry as Record<string, unknown>;
    const creatorType = typeof creator.creatorType === "string" && creator.creatorType.trim()
      ? creator.creatorType.trim()
      : null;
    if (!creatorType) {
      throw new ProviderError(DOUBAN_PROVIDER_ID, "invalid-response", "Creator 缺少 creatorType", false);
    }
    try {
      const creatorTypeID = Number(Zotero.CreatorTypes.getID(creatorType));
      if (!creatorTypeID || !Zotero.CreatorTypes.isValidForItemType(creatorTypeID, itemTypeID)) {
        throw new Error("invalid creator type");
      }
    } catch {
      throw new ProviderError(
        DOUBAN_PROVIDER_ID,
        "invalid-response",
        `Creator 角色 ${creatorType} 不适用于 book`,
        false,
      );
    }

    const hasName = Object.prototype.hasOwnProperty.call(creator, "name");
    const hasFirstName = Object.prototype.hasOwnProperty.call(creator, "firstName");
    const hasLastName = Object.prototype.hasOwnProperty.call(creator, "lastName");
    if (hasName) {
      if (hasFirstName || hasLastName || typeof creator.name !== "string" || !creator.name.trim()) {
        throw new ProviderError(DOUBAN_PROVIDER_ID, "invalid-response", "机构 Creator 姓名结构无效", false);
      }
      creators.push({ creatorType, name: creator.name });
      continue;
    }
    if ((!hasFirstName && !hasLastName)
      || (hasFirstName && typeof creator.firstName !== "string")
      || (hasLastName && typeof creator.lastName !== "string")
      || !`${creator.firstName ?? ""}${creator.lastName ?? ""}`.trim()) {
      throw new ProviderError(DOUBAN_PROVIDER_ID, "invalid-response", "个人 Creator 姓名结构无效", false);
    }
    creators.push({
      creatorType,
      firstName: hasFirstName ? creator.firstName as string : "",
      lastName: hasLastName ? creator.lastName as string : "",
    });
  }
  return creators;
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
    return [{
      operationId: `attachment:${hash}:${occurrence}`,
      ...normalized,
    }];
  });
}

function normalizeNotes(item: Record<string, unknown>): CandidateNote[] {
  if (!Array.isArray(item.notes)) return [];
  const occurrences = new Map<string, number>();
  return item.notes.flatMap((candidate): CandidateNote[] => {
    let content: unknown;
    if (typeof candidate === "string") {
      content = candidate;
    } else if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
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

function webTranslatorCode(error: unknown): ProviderErrorCode | null {
  const code = error && typeof error === "object"
    ? (error as { code?: unknown }).code
    : null;
  switch (code) {
    case "fetch-failed":
    case "translator-missing":
    case "no-result":
    case "invalid-response":
      return code;
    default:
      return null;
  }
}

export class DoubanProvider implements MetadataProvider<DoubanSource> {
  readonly id = DOUBAN_PROVIDER_ID;
  readonly capabilities = DOUBAN_PROVIDER_CAPABILITIES;
  private readonly translator: WebTranslator;
  private readonly now: () => Date;

  constructor(options: DoubanProviderOptions = {}) {
    this.translator = options.translator || createWebTranslatorAdapter();
    this.now = options.now || (() => new Date());
  }

  applies(item: ProviderItemSnapshot): boolean {
    return item.itemType === "book" && isDoubanBookURL(sourceURL(item));
  }

  resolveIdentifiers(item: ProviderItemSnapshot): readonly SourceIdentifier[] {
    const subject = extractDoubanSubject(sourceURL(item));
    return subject ? [{ type: DOUBAN_IDENTIFIER_TYPE, value: subject }] : [];
  }

  async fetch(request: ProviderFetchRequest): Promise<DoubanSource> {
    const url = sourceURL(request.item);
    const subject = request.identifiers.find((entry) => entry.type === DOUBAN_IDENTIFIER_TYPE)?.value;
    if (!url || !subject) {
      throw new ProviderError(this.id, "identifier-missing", "条目缺少有效豆瓣 subject", false);
    }
    try {
      return {
        translatedItem: await this.translator.translate(url),
        fetchedAt: this.now().toISOString(),
      };
    } catch (error) {
      throw this.classifyError(error);
    }
  }

  transform(source: DoubanSource, request: ProviderFetchRequest): CandidateEnvelope {
    if (!source?.translatedItem || typeof source.translatedItem !== "object" || Array.isArray(source.translatedItem)) {
      throw new ProviderError(this.id, "invalid-response", "Translator 返回了无效条目", false);
    }
    const url = sourceURL(request.item);
    if (!url) {
      throw new ProviderError(this.id, "identifier-missing", "条目缺少豆瓣来源 URL", false);
    }
    const translatedItemType = typeof source.translatedItem.itemType === "string"
      ? source.translatedItem.itemType.trim()
      : "";
    if (!translatedItemType) {
      throw new ProviderError(this.id, "invalid-response", "Translator 未返回 itemType", false);
    }
    const creators = normalizeCreators(source.translatedItem.creators);
    return {
      providerId: this.id,
      item: metadataItemRef(request.item),
      evidence: {
        providerId: this.id,
        sourceURL: url,
        identifiers: request.identifiers,
        fetchedAt: source.fetchedAt,
      },
      itemType: translatedItemType,
      fields: normalizeFields(source.translatedItem),
      ...(creators ? { creators } : {}),
      attachments: normalizeAttachments(source.translatedItem),
      notes: normalizeNotes(source.translatedItem),
    };
  }

  verify(candidate: CandidateEnvelope, request: ProviderFetchRequest): void {
    const expectedSubject = request.identifiers
      .find((entry) => entry.type === DOUBAN_IDENTIFIER_TYPE)?.value;
    const translatedURL = candidate.fields.find((entry) => entry.field === "url")?.value;
    const actualSubject = extractDoubanSubject(translatedURL);
    if (!expectedSubject || actualSubject !== expectedSubject) {
      throw new ProviderError(this.id, "source-mismatch", "Translator 结果与本地豆瓣 subject 不一致", false);
    }
  }

  classifyError(error: unknown): ProviderError {
    if (error instanceof ProviderError) return error;
    const code = webTranslatorCode(error);
    if (error instanceof WebTranslatorError || code) {
      const retryable = Boolean((error as { retryable?: unknown }).retryable);
      const message = error instanceof Error
        ? error.message
        : String((error as { message?: unknown }).message || "Translator 失败");
      return new ProviderError(this.id, code || "unknown", message, retryable, { cause: error });
    }
    if (error instanceof Error) {
      return new ProviderError(this.id, "fetch-failed", error.message, true, { cause: error });
    }
    return new ProviderError(this.id, "unknown", String(error), false, { cause: error });
  }
}

export function createDoubanProvider(options?: DoubanProviderOptions): DoubanProvider {
  return new DoubanProvider(options);
}
