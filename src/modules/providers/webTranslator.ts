declare const Zotero: any;

import type { TranslatorEvidence } from "../update/contracts";
import type { AttemptStage } from "../update/resolution";
import { debugTranslatorFailure, TranslatorAdapterError } from "./translatorFailure";

export type WebTranslatorErrorCode =
  | "fetch-failed"
  | "translator-missing"
  | "no-result"
  | "multiple-results"
  | "invalid-response";

export class WebTranslatorError extends TranslatorAdapterError<WebTranslatorErrorCode> {
  constructor(
    code: WebTranslatorErrorCode,
    message: string,
    retryable: boolean,
    stage: AttemptStage,
    options?: { cause?: unknown },
  ) {
    super("WebTranslatorError", code, message, retryable, stage, options);
  }
}

export interface WebTranslatorInstance {
  setDocument(document: unknown): void;
  getTranslators(): Promise<readonly unknown[]>;
  setTranslator(translator: unknown): void;
  translate(settings: { libraryID: false; saveAttachments: false }): Promise<readonly unknown[]>;
}

export interface WebTranslatorHost {
  processDocuments(
    url: string,
    visitor: (document: unknown) => unknown,
  ): Promise<readonly unknown[]>;
  createWebTranslator(): WebTranslatorInstance;
  getZoteroVersion?(): string | undefined;
}

export interface WebTranslator {
  translate(url: string): Promise<Record<string, unknown>>;
}

export interface WebTranslationResult {
  readonly item: Record<string, unknown>;
  readonly translator?: TranslatorEvidence;
}

export interface EvidenceWebTranslator extends WebTranslator {
  translateDetailed(url: string): Promise<WebTranslationResult>;
}

function defaultHost(): WebTranslatorHost {
  return {
    processDocuments: (url, visitor) => Zotero.HTTP.processDocuments(url, visitor),
    createWebTranslator: () => new Zotero.Translate.Web(),
    getZoteroVersion: () => typeof Zotero?.version === "string" ? Zotero.version : undefined,
  };
}

function stringProperty(value: unknown, names: readonly string[]): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const name of names) {
    const entry = record[name];
    if (typeof entry === "string" && entry.trim()) return entry.trim();
  }
  return undefined;
}

function translatorEvidence(translator: unknown, zoteroVersion?: string): TranslatorEvidence | undefined {
  const evidence: TranslatorEvidence = {
    id: stringProperty(translator, ["translatorID", "id"]),
    label: stringProperty(translator, ["label"]),
    updatedAt: stringProperty(translator, ["lastUpdated", "updatedAt", "updated"]),
    zoteroVersion: zoteroVersion?.trim() || undefined,
    attribution: "selected",
  };
  return Object.values(evidence).some(Boolean) ? evidence : undefined;
}

export class WebTranslatorAdapter implements EvidenceWebTranslator {
  constructor(private readonly host: WebTranslatorHost = defaultHost()) {}

  async translate(url: string): Promise<Record<string, unknown>> {
    return (await this.translateDetailed(url)).item;
  }

  async translateDetailed(url: string): Promise<WebTranslationResult> {
    let callbackDocument: unknown = null;
    let documents: readonly unknown[];
    try {
      documents = await this.host.processDocuments(url, (document) => {
        callbackDocument = document;
        return document;
      });
    } catch (error) {
      const failure = new WebTranslatorError("fetch-failed", "页面获取失败", true, "document-fetch", { cause: error });
      debugTranslatorFailure("url.web", { url }, failure);
      throw failure;
    }

    const document = documents?.[0] || callbackDocument;
    if (!document) {
      const failure = new WebTranslatorError("fetch-failed", "页面获取未返回 Document", true, "document-fetch");
      debugTranslatorFailure("url.web", { url }, failure);
      throw failure;
    }

    const translator = this.host.createWebTranslator();
    translator.setDocument(document);

    let translators: readonly unknown[];
    try {
      translators = await translator.getTranslators();
    } catch (error) {
      const failure = new WebTranslatorError("fetch-failed", "Translator 检测失败", true, "translator-detect", { cause: error });
      debugTranslatorFailure("url.web", { url }, failure);
      throw failure;
    }
    if (!translators || translators.length === 0) {
      throw new WebTranslatorError("translator-missing", "页面无匹配 Translator", false, "translator-detect");
    }

    const selectedTranslator = translators[0];
    translator.setTranslator(selectedTranslator);
    let translatedItems: readonly unknown[];
    try {
      translatedItems = await translator.translate({
        libraryID: false,
        saveAttachments: false,
      });
    } catch (error) {
      const failure = new WebTranslatorError("fetch-failed", "Translator 执行失败", true, "translator-run", { cause: error });
      debugTranslatorFailure("url.web", { url }, failure);
      throw failure;
    }

    if (!translatedItems || translatedItems.length === 0) {
      throw new WebTranslatorError("no-result", "Translator 未返回条目", false, "translator-run");
    }
    if (translatedItems.length > 1) {
      throw new WebTranslatorError("multiple-results", "Translator 返回多个条目，不能默认选择第一条", false, "translator-run");
    }
    const translated = translatedItems[0];

    let plain: unknown;
    try {
      plain = typeof (translated as { toJSON?: unknown }).toJSON === "function"
        ? (translated as { toJSON(): unknown }).toJSON()
        : translated;
    } catch (error) {
      throw new WebTranslatorError("invalid-response", "Translator 结果无法转换", false, "candidate-convert", { cause: error });
    }
    if (!plain || typeof plain !== "object" || Array.isArray(plain)) {
      throw new WebTranslatorError("invalid-response", "Translator 返回了无效条目", false, "candidate-convert");
    }
    return {
      item: plain as Record<string, unknown>,
      translator: translatorEvidence(selectedTranslator, this.host.getZoteroVersion?.()),
    };
  }
}

export function createWebTranslatorAdapter(host?: WebTranslatorHost): WebTranslatorAdapter {
  return new WebTranslatorAdapter(host);
}
