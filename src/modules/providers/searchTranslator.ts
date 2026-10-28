import type { TranslatorEvidence } from "../update/contracts";
import {
  normalizeDOI,
  type AttemptStage,
} from "../update/resolution";
import { debugTranslatorFailure, TranslatorAdapterError } from "./translatorFailure";

declare const Zotero: any;

export type SearchTranslatorErrorCode =
  | "fetch-failed"
  | "translator-missing"
  | "no-result"
  | "multiple-results"
  | "invalid-response";

export class SearchTranslatorError extends TranslatorAdapterError<SearchTranslatorErrorCode> {
  constructor(
    code: SearchTranslatorErrorCode,
    message: string,
    retryable: boolean,
    stage: AttemptStage,
    options?: { cause?: unknown },
  ) {
    super("SearchTranslatorError", code, message, retryable, stage, options);
  }
}

export interface SearchTranslatorInstance {
  setIdentifier(identifier: { DOI: string }): void;
  getTranslators(): Promise<readonly unknown[]>;
  setTranslator(translator: unknown): void;
  setHandler?(
    type: "itemDone",
    handler: (session: { translator?: readonly unknown[] } | null | undefined) => void,
  ): void;
  translate(settings: { libraryID: false; saveAttachments: false }): Promise<readonly unknown[]>;
}

export interface SearchTranslatorHost {
  createSearchTranslator(): SearchTranslatorInstance;
  getZoteroVersion?(): string | undefined;
}

export interface SearchTranslatorMetadata extends TranslatorEvidence {}

const UNKNOWN = "unknown";

export interface SearchTranslation {
  readonly item: Record<string, unknown>;
  readonly translator: SearchTranslatorMetadata;
  readonly sourceId: string;
}

export interface SearchTranslator {
  translateDOI(doi: string): Promise<SearchTranslation>;
}

function defaultHost(): SearchTranslatorHost {
  return {
    createSearchTranslator: () => new Zotero.Translate.Search(),
    getZoteroVersion: () => typeof Zotero.version === "string" ? Zotero.version : undefined,
  };
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readTranslatorMetadata(
  translator: unknown,
  zoteroVersion: string | undefined,
  attribution: NonNullable<SearchTranslatorMetadata["attribution"]>,
): SearchTranslatorMetadata {
  const record = translator
    && typeof translator === "object"
    && !Array.isArray(translator)
    ? translator as Record<string, unknown>
    : null;
  return {
    id: (record
      ? nonemptyString(record.translatorID) || nonemptyString(record.id)
      : undefined) || UNKNOWN,
    label: (record ? nonemptyString(record.label) : undefined) || UNKNOWN,
    updatedAt: (record
      ? nonemptyString(record.lastUpdated) || nonemptyString(record.updatedAt)
      : undefined) || UNKNOWN,
    zoteroVersion: nonemptyString(zoteroVersion) || UNKNOWN,
    attribution,
  };
}

function translatorIdentity(translator: SearchTranslatorMetadata): string | null {
  if (translator.id !== UNKNOWN) return `id:${translator.id}`;
  if (translator.label !== UNKNOWN) return `label:${translator.label}`;
  return null;
}

function toPlainItem(value: unknown): Record<string, unknown> {
  let plain: unknown;
  try {
    plain = value && typeof (value as { toJSON?: unknown }).toJSON === "function"
      ? (value as { toJSON(): unknown }).toJSON()
      : value;
  } catch (error) {
    throw new SearchTranslatorError("invalid-response", "Search Translator 结果无法转换", false, "candidate-convert", { cause: error });
  }
  if (!plain || typeof plain !== "object" || Array.isArray(plain)) {
    throw new SearchTranslatorError("invalid-response", "Search Translator 返回了无效条目", false, "candidate-convert");
  }
  return plain as Record<string, unknown>;
}

export class SearchTranslatorAdapter implements SearchTranslator {
  constructor(private readonly host: SearchTranslatorHost = defaultHost()) {}

  async translateDOI(doi: string): Promise<SearchTranslation> {
    const normalizedDOI = normalizeDOI(doi);
    if (!normalizedDOI) {
      throw new SearchTranslatorError("invalid-response", "DOI 无效", false, "route");
    }

    const search = this.host.createSearchTranslator();
    search.setIdentifier({ DOI: normalizedDOI });

    let translators: readonly unknown[];
    try {
      translators = await search.getTranslators();
    } catch (error) {
      const failure = new SearchTranslatorError("fetch-failed", "Search Translator 检测失败", true, "translator-detect", { cause: error });
      debugTranslatorFailure("doi.search", { doi: normalizedDOI }, failure);
      throw failure;
    }
    if (!translators || translators.length === 0) {
      throw new SearchTranslatorError("translator-missing", "DOI 无匹配 Search Translator", false, "translator-detect");
    }

    // Search 模式允许 Zotero 按匹配列表依次尝试；结果数量仍由下方严格检查。
    search.setTranslator(translators);
    const observed = new Map<string, SearchTranslatorMetadata>();
    if (typeof search.setHandler === "function") {
      search.setHandler("itemDone", (session) => {
        const current = Array.isArray(session?.translator) ? session.translator[0] : undefined;
        const metadata = readTranslatorMetadata(current, this.host.getZoteroVersion?.(), "observed");
        const identity = translatorIdentity(metadata);
        if (identity) observed.set(identity, metadata);
      });
    }
    let results: readonly unknown[];
    try {
      results = await search.translate({ libraryID: false, saveAttachments: false });
    } catch (error) {
      const failure = new SearchTranslatorError("fetch-failed", "Search Translator 执行失败", true, "translator-run", { cause: error });
      debugTranslatorFailure("doi.search", { doi: normalizedDOI }, failure);
      throw failure;
    }
    if (!results || results.length === 0) {
      throw new SearchTranslatorError("no-result", "Search Translator 未返回条目", false, "translator-run");
    }
    if (results.length > 1) {
      throw new SearchTranslatorError("multiple-results", "Search Translator 返回多条结果", false, "translator-run");
    }

    const item = toPlainItem(results[0]);
    let translator: SearchTranslatorMetadata;
    if (observed.size === 1) {
      translator = [...observed.values()][0];
    } else if (observed.size > 1) {
      translator = readTranslatorMetadata(null, this.host.getZoteroVersion?.(), "ambiguous");
    } else if (translators.length === 1) {
      translator = readTranslatorMetadata(translators[0], this.host.getZoteroVersion?.(), "single-match");
    } else {
      translator = readTranslatorMetadata(null, this.host.getZoteroVersion?.(), "unknown");
    }
    const catalog = nonemptyString(item.libraryCatalog);
    return {
      item,
      translator,
      // Translator 身份不能代替上游 catalog/source 身份；来源不可确认时必须 fail closed。
      sourceId: catalog || UNKNOWN,
    };
  }
}

export function createSearchTranslatorAdapter(host?: SearchTranslatorHost): SearchTranslatorAdapter {
  return new SearchTranslatorAdapter(host);
}
