import { getString } from "../utils/locale";
import { config } from "../../package.json";
import { getPref } from "../utils/prefs";
import {
  getAttachmentSaveStrategy,
  getConfiguredAttachmentSaveStrategy,
  normalizeAttachmentSaveStrategy,
  type AttachmentSaveStrategy,
} from "./attachmentPreferences";

export {
  getConfiguredAttachmentSaveStrategy,
  normalizeAttachmentSaveStrategy,
  type AttachmentSaveStrategy,
} from "./attachmentPreferences";

export function isSupportedMetadataURL(url: unknown): url is string {
  return (
    typeof url === "string" &&
    /^https?:\/\/([^/]+\.)?douban\.com(?:[/:?#]|$)/i.test(url)
  );
}

export function isNoTitleSpecifiedError(err: unknown) {
  return /no title specified/i.test(getErrorMessage(err));
}

type MetadataProviderInput = {
  url?: string;
  oldItem?: Zotero.Item;
  settings?: MetadataSaveSettings;
};

type MetadataProvider = {
  name: string;
  canTranslate: (input: MetadataProviderInput) => boolean;
  translate: (input: MetadataProviderInput) => Promise<any[]>;
};

export type MetadataProviderAttempt = {
  provider: string;
  ok: boolean;
  error?: string;
};

export type MetadataProviderResult = {
  item: any;
  provider: string;
  attempts: MetadataProviderAttempt[];
};

export type BatchUpdateSummary = {
  success: number;
  failed: number;
  skipped: number;
  canceled: number;
  fallback: number;
  reasons: Record<string, number>;
};

export type BatchUpdateSummaryLabels = {
  title: string;
  success: string;
  failed: string;
  skipped: string;
  canceled: string;
  fallback: string;
  reasons: string;
};

export const METADATA_RESULT_CLOSE_TIME_MS = 8000;

export type MetadataSaveSettings = {
  saveAttachments: boolean;
  libraryID: boolean | number;
  collections?: number[];
};

export type SaveNewMetadataItemResult = {
  status: "saved";
  item: Zotero.Item;
};

const METADATA_LOG_PREFIX = "[metadata]";
const METADATA_LOG_ALLOWED_KEYS = new Set([
  "attempts",
  "attachmentCount",
  "canceled",
  "error",
  "failed",
  "fallback",
  "inLibraryRoot",
  "itemCount",
  "itemID",
  "itemType",
  "ok",
  "provider",
  "reason",
  "reasons",
  "saveAttachments",
  "savedItemID",
  "schema",
  "selected",
  "skipped",
  "sourceItemID",
  "success",
]);

export type MetadataRunContext = {
  win?: _ZoteroTypes.MainWindow;
  items?: Zotero.Item[];
  collectionID?: number;
};

type MainWindowWithPane = _ZoteroTypes.MainWindow & {
  ZoteroPane?: _ZoteroTypes.ZoteroPane;
};

export function getItemISBN(item: Pick<Zotero.Item, "getField"> | undefined) {
  const value = item?.getField("ISBN");
  const text = cleanText(value).replace(/[^\dXx]/g, "");
  if (/^\d{9}[\dXx]$/.test(text) || /^\d{13}$/.test(text)) {
    return text.toUpperCase();
  }
  return "";
}

export function buildFallbackDoubanItem(doc: Document, url: string) {
  const title = extractDoubanTitle(doc);
  if (!title) {
    throw new Error("Unable to extract a title from Douban page");
  }

  const item: Record<string, any> = {
    __fallbackDoubanItem: true,
    itemType: "book",
    title,
    url,
  };

  const author = queryContent(doc, 'meta[property="book:author"]');
  if (author) {
    item.creators = [
      {
        creatorType: "author",
        lastName: author,
        fieldMode: 1,
      },
    ];
  }

  const isbn = queryContent(doc, 'meta[property="book:isbn"]');
  if (isbn) {
    item.ISBN = isbn;
  }

  const description = queryContent(doc, 'meta[property="og:description"]');
  if (description) {
    item.abstractNote = description;
  }

  return item;
}

export function extractDoubanTitle(doc: Document) {
  return (
    queryContent(doc, 'meta[property="og:title"]') ||
    queryJSONLDName(doc) ||
    queryText(doc, "h1 span") ||
    cleanDoubanTitle(doc.title)
  );
}

export async function getMeta(context: MetadataRunContext = {}) {
  const items = (context.items ?? []).filter((item) => {
    return item.isRegularItem();
  });
  const settings = getSettings(context.collectionID);
  const schema = getPref("schema");
  const translationSettings =
    schema === "save" ? buildMetadataTranslationSettings(settings) : settings;
  const popWin = new ztoolkit.ProgressWindow(
    getString("itemmenu-updateMetadata-label"),
    {
      closeOnClick: true,
      closeTime: METADATA_RESULT_CLOSE_TIME_MS,
    },
  );

  popWin
    .createLine({
      type: "default",
      text: getString("message-getMeta-into"),
      progress: 0,
      idx: 0,
    })
    .show();

  if (!items.length) {
    popWin
      .changeLine({
        type: "error",
        progress: 0,
        text: getString("message-getMeta-error"),
        idx: 1,
      })
      .startCloseTimer(3000);
    return;
  }

  const summary = createBatchUpdateSummary();
  logMetadataEvent("batch-start", {
    schema,
    itemCount: items.length,
    collectionID: context.collectionID,
  });

  for (const [index, item] of items.entries()) {
    const current = `${index + 1}/${items.length}`;

    try {
      const url = item.getField("url");
      if (!cleanText(url)) {
        recordSkipped(summary, "missing URL");
        popWin.changeLine({
          type: "default",
          progress: 0,
          text: `${current}${getString("message-updateItem-skip")}: missing URL`,
          idx: 1,
        });
        continue;
      }

      if (!isSupportedMetadataURL(url)) {
        recordSkipped(summary, "unsupported URL");
        popWin.changeLine({
          type: "default",
          progress: 0,
          text: `${current}${getString("message-updateItem-skip")}: unsupported URL`,
          idx: 1,
        });
        continue;
      }

      const translatedResult = await translateMetadataForItem(
        url,
        item,
        translationSettings,
      );
      const translatedItem = translatedResult.item;
      if (!translatedItem) {
        throw new Error("No translated metadata found");
      }
      logMetadataEvent("translation-selected", {
        schema,
        itemID: item.id,
        provider: translatedResult.provider,
        attempts: translatedResult.attempts,
      });

      if (schema === "save") {
        const saveResult = await saveNewMetadataItem(translatedItem, settings);
        await revealSavedMetadataItem(saveResult.item, context.win);
        summary.success += 1;
        if (translatedResult.provider !== "douban-url") {
          summary.fallback += 1;
        }
        logMetadataEvent("save-new-result", {
          sourceItemID: item.id,
          savedItemID: saveResult.item.id,
          provider: translatedResult.provider,
        });
        popWin.changeLine({
          type: "success",
          progress: 0,
          text: `${current}${getString("message-saveItem-success")}`,
          idx: 1,
        });
        continue;
      }

      const startTime = Date.now();
      const updateResult = await updateItem(translatedItem, item, context.win);
      const endTime = Date.now();
      ztoolkit.log(`updateItem took ${endTime - startTime} milliseconds`);
      if (updateResult.status === "applied") {
        summary.success += 1;
      } else if (updateResult.status === "canceled") {
        summary.canceled += 1;
      } else {
        recordSkipped(summary, updateResult.reason || NO_SAFE_CHANGES_REASON);
      }
      if (translatedResult.provider !== "douban-url") {
        summary.fallback += 1;
      }
      popWin.changeLine({
        type: updateResult.status === "applied" ? "success" : "default",
        progress: 0,
        text: `${current}${formatUpdateResultMessage(updateResult)}`,
        idx: 1,
      });
    } catch (err) {
      ztoolkit.log(err);
      logMetadataEvent("item-error", {
        itemID: item.id,
        error: getErrorMessage(err),
      });
      summary.failed += 1;
      recordReason(summary, getErrorMessage(err));
      popWin
        .changeLine({
          type: "error",
          progress: 0,
          text: `${current}${getString("message-getMeta-error")}, ${err}`,
          idx: 1,
        })
        .startCloseTimer(3000);
    }
  }

  const summaryLines = formatBatchUpdateSummaryLines(
    summary,
    getBatchUpdateSummaryLabels(),
  );
  summaryLines.forEach((text, offset) => {
    popWin.changeLine({
      type: summary.failed ? "default" : "success",
      progress: offset === 0 ? 100 : 0,
      text,
      idx: 2 + offset,
    });
  });
  logMetadataEvent("batch-finish", summary);
  popWin.startCloseTimer(METADATA_RESULT_CLOSE_TIME_MS);
}

function getSettings(collectionID?: number): MetadataSaveSettings {
  const options = getPref("schema");
  const attachmentSaveStrategy = getAttachmentSaveStrategy();

  // 创建返回对象的基本结构
  const settings: MetadataSaveSettings = {
    saveAttachments: attachmentSaveStrategy !== "none",
    libraryID: options === "save" ? Zotero.Libraries.userLibraryID : false,
  };

  // 如果 coll 存在，才添加到 settings 中
  if (typeof collectionID === "number") {
    settings.collections = [collectionID];
  }

  return settings;
}

export function buildMetadataTranslationSettings(
  settings: MetadataSaveSettings,
): MetadataSaveSettings {
  const translationSettings: MetadataSaveSettings = {
    ...settings,
    saveAttachments: false,
    libraryID: false,
  };

  delete translationSettings.collections;
  return translationSettings;
}

async function translateDoubanDocument(
  doc: Document,
  url: string,
  settings: MetadataSaveSettings,
) {
  const translate = new Zotero.Translate.Web();
  translate.setDocument(doc);
  const translators = await translate.getTranslators();

  if (!translators.length) {
    throw new Error("No Zotero translator found for this Douban URL");
  }

  ztoolkit.log(
    `Matched translators: ${translators
      .map((translator: any) => translator.label || translator.translatorID)
      .join(", ")}`,
  );

  translate.setTranslator(translators[0]);

  try {
    const translatedItems = await translate.translate(settings);
    if (!Array.isArray(translatedItems)) {
      throw new Error("Translator did not return an item list");
    }

    return translatedItems.map((item) =>
      normalizeTranslatedItem(item, doc, url),
    );
  } catch (err) {
    ztoolkit.log(err);
    if (isNoTitleSpecifiedError(err)) {
      return [buildFallbackDoubanItem(doc, url)];
    }
    throw new Error(`Zotero translator failed: ${getErrorMessage(err)}`, {
      cause: err,
    });
  }
}

async function translateURL(url: string, settings: MetadataSaveSettings) {
  let key = url;
  try {
    const uri = Services.io.newURI(url);
    key = uri.host;
  } catch (e) {
    ztoolkit.log(e);
  }
  // Limit to two requests per second per host
  const caller = _getConcurrentCaller(key, 500);
  return caller.start(() => _translateURLNow(url, settings));
}

const _concurrentCallers = new Map();

function _getConcurrentCaller(key: string, interval: number) {
  if (_concurrentCallers.has(key)) {
    return _concurrentCallers.get(key);
  }

  const { ConcurrentCaller } = importConcurrentCaller();

  const caller = new ConcurrentCaller({
    numConcurrent: 1,
    interval,
    onError: (e: any) => ztoolkit.log(e),
  });
  _concurrentCallers.set(key, caller);
  return caller;
}

function importConcurrentCaller() {
  const chromeUtils = (globalThis as unknown as { ChromeUtils?: any })
    .ChromeUtils;

  if (chromeUtils?.importESModule) {
    return chromeUtils.importESModule("resource://zotero/concurrentCaller.mjs");
  }

  return Components.utils.import("resource://zotero/concurrentCaller.js");
}

async function _translateURLNow(url: string, settings: MetadataSaveSettings) {
  const doc = (await Zotero.HTTP.processDocuments(url, (doc) => doc))[0];
  if (!doc) {
    throw new Error("Unable to load metadata URL");
  }

  const newItems = await translateDoubanDocument(doc, url, settings);
  if (!newItems.length) {
    throw new Error("Zotero translator returned no metadata items");
  }

  return newItems[0];
}

async function translateDoubanURLProvider(input: MetadataProviderInput) {
  if (!input.url) {
    throw new Error("Douban provider requires a URL");
  }
  return [await translateURL(input.url, input.settings ?? getSettings())];
}

async function translateISBNProvider(input: MetadataProviderInput) {
  const isbn = getItemISBN(input.oldItem);
  if (!isbn) {
    throw new Error("ISBN provider requires an existing ISBN");
  }

  const translate = new Zotero.Translate.Search();
  translate.setIdentifier(isbn);
  const translators = await translate.getTranslators();

  if (!translators.length) {
    throw new Error(`No Zotero search translator found for ISBN ${isbn}`);
  }

  ztoolkit.log(
    `Matched ISBN translators: ${translators
      .map((translator: any) => translator.label || translator.translatorID)
      .join(", ")}`,
  );

  translate.setTranslator(translators[0]);

  const translatedItems = await translate.translate(
    input.settings ?? getSettings(),
  );

  if (!Array.isArray(translatedItems) || !translatedItems.length) {
    throw new Error(`ISBN fallback returned no metadata for ${isbn}`);
  }

  return translatedItems.map((item: any) =>
    typeof item?.toJSON === "function" ? item.toJSON() : item,
  );
}

function createMetadataProviders(): MetadataProvider[] {
  return [
    {
      name: "douban-url",
      canTranslate: (input) => isSupportedMetadataURL(input.url),
      translate: translateDoubanURLProvider,
    },
    {
      name: "isbn",
      canTranslate: (input) => Boolean(getItemISBN(input.oldItem)),
      translate: translateISBNProvider,
    },
  ];
}

export async function translateWithMetadataProviders(
  input: MetadataProviderInput,
  providers: MetadataProvider[],
): Promise<MetadataProviderResult> {
  const attempts: MetadataProviderAttempt[] = [];

  for (const provider of providers) {
    if (!provider.canTranslate(input)) {
      continue;
    }

    try {
      const items = await provider.translate(input);
      if (!items.length) {
        throw new Error(`${provider.name} returned no metadata`);
      }
      attempts.push({ provider: provider.name, ok: true });
      return {
        item: items[0],
        provider: provider.name,
        attempts,
      };
    } catch (err) {
      attempts.push({
        provider: provider.name,
        ok: false,
        error: getErrorMessage(err),
      });
    }
  }

  throw new Error(formatProviderFailure(attempts));
}

async function translateMetadataForItem(
  url: string,
  oldItem: Zotero.Item,
  settings: MetadataSaveSettings,
) {
  return translateWithMetadataProviders(
    {
      url,
      oldItem,
      settings,
    },
    createMetadataProviders(),
  );
}

function formatProviderFailure(attempts: MetadataProviderAttempt[]) {
  if (!attempts.length) {
    return "No metadata provider can handle this item";
  }

  return `Metadata providers failed: ${attempts
    .map((attempt) => `${attempt.provider}: ${attempt.error || "failed"}`)
    .join("; ")}`;
}

function createBatchUpdateSummary(): BatchUpdateSummary {
  return {
    success: 0,
    failed: 0,
    skipped: 0,
    canceled: 0,
    fallback: 0,
    reasons: {},
  };
}

function recordSkipped(summary: BatchUpdateSummary, reason: string) {
  summary.skipped += 1;
  recordReason(summary, reason);
}

function recordReason(summary: BatchUpdateSummary, reason: string) {
  summary.reasons[reason] = (summary.reasons[reason] || 0) + 1;
}

const DEFAULT_BATCH_UPDATE_SUMMARY_LABELS: BatchUpdateSummaryLabels = {
  title: "Summary",
  success: "success",
  failed: "failed",
  skipped: "skipped",
  canceled: "canceled",
  fallback: "fallback",
  reasons: "reasons",
};

function getBatchUpdateSummaryLabels(): BatchUpdateSummaryLabels {
  return {
    title: getString("batch-summary-title"),
    success: getString("batch-summary-success"),
    failed: getString("batch-summary-failed"),
    skipped: getString("batch-summary-skipped"),
    canceled: getString("batch-summary-canceled"),
    fallback: getString("batch-summary-fallback"),
    reasons: getString("batch-summary-reasons"),
  };
}

export function formatBatchUpdateSummary(
  summary: BatchUpdateSummary,
  labels: BatchUpdateSummaryLabels = DEFAULT_BATCH_UPDATE_SUMMARY_LABELS,
) {
  const reasonText = formatBatchUpdateReasonText(summary);

  return [
    `${labels.title}: ${labels.success} ${summary.success}`,
    summary.failed ? `${labels.failed} ${summary.failed}` : "",
    summary.skipped ? `${labels.skipped} ${summary.skipped}` : "",
    summary.canceled ? `${labels.canceled} ${summary.canceled}` : "",
    summary.fallback ? `${labels.fallback} ${summary.fallback}` : "",
    reasonText ? `${labels.reasons}: ${reasonText}` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

export function formatBatchUpdateSummaryLines(
  summary: BatchUpdateSummary,
  labels: BatchUpdateSummaryLabels = DEFAULT_BATCH_UPDATE_SUMMARY_LABELS,
) {
  const reasonText = formatBatchUpdateReasonText(summary);

  return [
    `${labels.title}:`,
    `${labels.success} ${summary.success}`,
    summary.failed ? `${labels.failed} ${summary.failed}` : "",
    summary.skipped ? `${labels.skipped} ${summary.skipped}` : "",
    summary.canceled ? `${labels.canceled} ${summary.canceled}` : "",
    summary.fallback ? `${labels.fallback} ${summary.fallback}` : "",
    reasonText ? `${labels.reasons}: ${reasonText}` : "",
  ].filter(Boolean);
}

function formatBatchUpdateReasonText(summary: BatchUpdateSummary) {
  return Object.entries(summary.reasons)
    .map(([reason, count]) => `${reason} x${count}`)
    .join("; ");
}

export function shouldTryAttachmentSave(
  newItem: any,
  oldItem: Zotero.Item,
  strategy: AttachmentSaveStrategy,
) {
  if (strategy === "none") {
    return false;
  }

  if (!getFirstAttachment(newItem)) {
    return false;
  }

  if (strategy === "always") {
    return true;
  }

  const attachmentIDs =
    typeof oldItem.getAttachments === "function"
      ? oldItem.getAttachments() || []
      : [];
  return attachmentIDs.length === 0;
}

export function buildAttachmentImportOptions(
  newItem: any,
  oldItem: Zotero.Item,
) {
  const attachment = getFirstAttachment(newItem);
  if (!attachment) {
    return {
      ok: false as const,
      reason: "missing attachment",
    };
  }

  const url = cleanText(attachment.url);
  if (!url) {
    return {
      ok: false as const,
      reason: "missing attachment URL",
    };
  }

  const contentType = cleanText(attachment.mimeType);
  if (!contentType) {
    return {
      ok: false as const,
      reason: "missing attachment mimeType",
    };
  }

  const title = cleanText(attachment.title) || cleanText(newItem.title);
  if (!title) {
    return {
      ok: false as const,
      reason: "missing attachment title",
    };
  }

  return {
    ok: true as const,
    options: {
      url,
      contentType,
      title,
      parentItemID: oldItem.id,
      libraryID: (oldItem as any).libraryID || Zotero.Libraries.userLibraryID,
      fileBaseName: buildAttachmentFileBaseName(newItem),
    },
  };
}

function getFirstAttachment(newItem: any) {
  return Array.isArray(newItem.attachments) ? newItem.attachments[0] : null;
}

function buildAttachmentFileBaseName(newItem: any) {
  const creator = Array.isArray(newItem.creators)
    ? cleanText(newItem.creators[0]?.lastName)
    : "";
  const year = cleanText(newItem.date).slice(0, 4);
  const title = cleanText(newItem.title).replace(/\//g, "");
  return [creator, year, title].filter(Boolean).join(" - ") || "metadata";
}

function getErrorMessage(err: unknown) {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function normalizeTranslatedItem(item: any, doc: Document, url: string) {
  if (!item || typeof item !== "object") {
    return item;
  }

  const itemJSON = typeof item.toJSON === "function" ? item.toJSON() : item;
  if (itemJSON.title) {
    return item;
  }

  return {
    ...buildFallbackDoubanItem(doc, url),
    ...itemJSON,
    title: extractDoubanTitle(doc),
  };
}

function queryContent(doc: Document, selector: string) {
  const element = doc.querySelector(selector);
  const content = (element as HTMLMetaElement | null)?.content;
  return cleanText(content);
}

function queryText(doc: Document, selector: string) {
  return cleanText(doc.querySelector(selector)?.textContent);
}

function queryJSONLDName(doc: Document) {
  const scripts: Element[] = Array.from(
    doc.querySelectorAll('script[type="application/ld+json"]'),
  );

  for (const script of scripts) {
    if (!script) {
      continue;
    }

    try {
      const data = JSON.parse(script.textContent || "");
      const name = Array.isArray(data) ? data[0]?.name : data?.name;
      const title = cleanText(name);
      if (title) {
        return title;
      }
    } catch (err) {
      ztoolkit.log(err);
    }
  }

  return "";
}

function cleanDoubanTitle(title: unknown) {
  return cleanText(String(title || "").replace(/\s*\(豆瓣\)\s*$/i, ""));
}

function cleanText(value: unknown) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

async function saveNote(newItem: any, oldItem: Zotero.Item) {
  const note = new Zotero.Item("note");
  note.setNote(newItem["notes"].join(""));
  note.parentID = oldItem.id;
  await note.saveTx();
  ztoolkit.log("save Note successful");
}

async function saveAttachments(newItem: any, oldItem: Zotero.Item) {
  const attachment = buildAttachmentImportOptions(newItem, oldItem);
  if (!attachment.ok) {
    ztoolkit.log(`Skip attachment save: ${attachment.reason}`);
    return attachment;
  }

  await Zotero.Attachments.importFromURL(attachment.options);
  ztoolkit.log("save Attachments successful");
  return attachment;
}

export async function saveNewMetadataItem(
  newItem: any,
  settings: MetadataSaveSettings,
): Promise<SaveNewMetadataItemResult> {
  const itemJSON = normalizeSaveableMetadataItem(newItem);
  const itemType = (cleanText(itemJSON.itemType) || "book") as any;
  const item = new Zotero.Item(itemType);
  const libraryID =
    typeof settings.libraryID === "number"
      ? settings.libraryID
      : Zotero.Libraries.userLibraryID;

  logMetadataEvent("save-new-start", {
    itemType,
    title: itemJSON.title,
    libraryID,
    saveAttachments: settings.saveAttachments,
    attachmentCount: Array.isArray(itemJSON.attachments)
      ? itemJSON.attachments.length
      : 0,
  });

  (item as any).libraryID = libraryID;
  item.fromJSON(getPrimaryMetadataForSave(itemJSON), { strict: false });

  if (Array.isArray(settings.collections) && settings.collections.length) {
    item.setCollections(settings.collections);
  }

  await item.saveTx();
  await saveSupplementalMetadata(itemJSON, item, {
    saveAttachments: settings.saveAttachments,
  });

  logMetadataEvent("save-new-finish", {
    savedItemID: item.id,
    title: itemJSON.title,
    libraryID,
    attachmentCount:
      typeof item.getAttachments === "function"
        ? item.getAttachments().length
        : undefined,
  });

  return {
    status: "saved",
    item,
  };
}

export async function revealSavedMetadataItem(
  item: Zotero.Item,
  win?: _ZoteroTypes.MainWindow,
) {
  const pane =
    (win as MainWindowWithPane | undefined)?.ZoteroPane ??
    Zotero.getActiveZoteroPane?.();

  if (!item.id || !pane?.selectItems) {
    logMetadataEvent("save-new-reveal-skipped", {
      savedItemID: item.id,
      reason: "missing ZoteroPane selection API",
    });
    return false;
  }

  try {
    const collectionIDs =
      typeof item.getCollections === "function" ? item.getCollections() : [];
    const selected = await pane.selectItems([item.id], !collectionIDs.length);
    logMetadataEvent("save-new-reveal-finish", {
      savedItemID: item.id,
      selected,
      inLibraryRoot: !collectionIDs.length,
    });
    return selected !== false;
  } catch (err) {
    logMetadataEvent("save-new-reveal-error", {
      savedItemID: item.id,
      error: getErrorMessage(err),
    });
    return false;
  }
}

function normalizeSaveableMetadataItem(newItem: any) {
  const itemJSON = normalizeTranslatedMetadataItem(newItem);
  const title = cleanText(itemJSON.title);

  if (!title) {
    throw new Error("Translated metadata has no title");
  }

  return {
    ...itemJSON,
    itemType: cleanText(itemJSON.itemType) || "book",
    title,
  };
}

function getPrimaryMetadataForSave(newItem: any) {
  const {
    __fallbackDoubanItem: _fallback,
    attachments: _attachments,
    collections: _collections,
    key: _key,
    libraryID: _libraryID,
    notes: _notes,
    version: _version,
    ...metadata
  } = newItem;

  return metadata;
}

export function sanitizeMetadataLogData(data: unknown): unknown {
  if (Array.isArray(data)) {
    return data.map(sanitizeMetadataLogData);
  }

  if (!data || typeof data !== "object") {
    return data;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!METADATA_LOG_ALLOWED_KEYS.has(key)) {
      continue;
    }
    sanitized[key] = sanitizeMetadataLogData(value);
  }
  return sanitized;
}

function logMetadataEvent(event: string, data?: unknown) {
  try {
    ztoolkit.log(
      `${METADATA_LOG_PREFIX} ${event}`,
      sanitizeMetadataLogData(data),
    );
  } catch {
    // Logging must never affect metadata writes.
  }
}

async function updateItem(
  newItem: any,
  oldItem: Zotero.Item,
  win?: _ZoteroTypes.MainWindow,
) {
  const itemJSON = normalizeTranslatedMetadataItem(newItem);
  ztoolkit.log(`Update item from translated ${itemJSON.itemType ?? "item"}`);
  const result = await applyMetadataUpdateWithConfirmation(
    itemJSON,
    oldItem,
    shouldConfirmBeforeMetadataUpdate()
      ? (preview) => confirmMetadataUpdate(preview, win)
      : () => true,
  );
  ztoolkit.log(
    `Applied ${result.update.applied.length} metadata changes, skipped ${result.update.skipped.length}`,
  );

  if (result.confirmed) {
    await saveSupplementalMetadata(itemJSON, oldItem);
  }

  return result;
}

async function saveSupplementalMetadata(
  newItem: any,
  oldItem: Zotero.Item,
  options: { saveAttachments?: boolean } = {},
) {
  if (getPref("saveNotes") === true) {
    await saveMetadataNote(newItem, oldItem);
  }

  const strategy = getAttachmentSaveStrategy(options.saveAttachments);
  if (shouldTryAttachmentSave(newItem, oldItem, strategy)) {
    await saveAttachments(newItem, oldItem);
  }
}

async function saveMetadataNote(newItem: any, oldItem: Zotero.Item) {
  if (!Array.isArray(newItem.notes) || !newItem.notes.length) {
    return;
  }

  const noteIDs =
    typeof oldItem.getNotes === "function" ? oldItem.getNotes() || [] : [];
  if (noteIDs.length > 0) {
    return;
  }

  await saveNote(newItem, oldItem);
}

type MetadataChange = {
  field: string;
  oldValue: unknown;
  newValue: unknown;
};

type MetadataSkip = {
  field: string;
  reason: string;
};

export type SafeMetadataUpdateResult = {
  applied: MetadataChange[];
  skipped: MetadataSkip[];
};

type ApplySafeMetadataUpdateOptions = {
  dryRun?: boolean;
};

export type MetadataUpdateResult = {
  confirmed: boolean;
  status: "applied" | "canceled" | "skipped";
  reason?: string;
  update: SafeMetadataUpdateResult;
  item: Zotero.Item;
};

const NO_SAFE_CHANGES_REASON = "no safe metadata changes";

export function shouldConfirmBeforeMetadataUpdate() {
  const value = getPref("confirmBeforeUpdate");
  return value === true || value === "true";
}

const PREVIEW_FIELDS = [
  "title",
  "creators",
  "ISBN",
  "publisher",
  "date",
  "abstractNote",
  "extra",
  "tags",
];

export function applySafeMetadataUpdate(
  newItem: any,
  oldItem: Zotero.Item,
  options: ApplySafeMetadataUpdateOptions = {},
): SafeMetadataUpdateResult {
  const result: SafeMetadataUpdateResult = {
    applied: [],
    skipped: [],
  };

  applySafeItemType(newItem, oldItem, result, options);
  applySafeCreators(newItem, oldItem, result, options);
  applySafeFields(newItem, oldItem, result, options);
  applySafeTags(newItem, oldItem, result, options);

  return result;
}

export function buildMetadataUpdatePreview(newItem: any, oldItem: Zotero.Item) {
  return applySafeMetadataUpdate(
    normalizeTranslatedMetadataItem(newItem),
    oldItem,
    {
      dryRun: true,
    },
  );
}

export function formatMetadataUpdatePreview(result: SafeMetadataUpdateResult) {
  const lines: string[] = [];

  for (const change of result.applied) {
    if (!PREVIEW_FIELDS.includes(change.field)) {
      continue;
    }
    lines.push(
      `${change.field}: ${formatPreviewValue(
        change.oldValue,
      )} -> ${formatPreviewValue(change.newValue)}`,
    );
  }

  for (const skip of result.skipped) {
    if (!PREVIEW_FIELDS.includes(skip.field)) {
      continue;
    }
    lines.push(`${skip.field}: skipped (${skip.reason})`);
  }

  return lines.length ? lines.join("\n") : "No safe metadata changes.";
}

export async function applyMetadataUpdateWithConfirmation(
  newItem: any,
  oldItem: Zotero.Item,
  confirmUpdate: (preview: SafeMetadataUpdateResult) => boolean,
): Promise<MetadataUpdateResult> {
  const itemJSON = normalizeTranslatedMetadataItem(newItem);
  const preview = buildMetadataUpdatePreview(itemJSON, oldItem);

  if (!preview.applied.length) {
    return {
      confirmed: false,
      status: "skipped",
      reason: NO_SAFE_CHANGES_REASON,
      update: preview,
      item: oldItem,
    };
  }

  if (!confirmUpdate(preview)) {
    return {
      confirmed: false,
      status: "canceled",
      update: preview,
      item: oldItem,
    };
  }

  const update = applySafeMetadataUpdate(itemJSON, oldItem);
  if (!update.applied.length) {
    return {
      confirmed: false,
      status: "skipped",
      reason: NO_SAFE_CHANGES_REASON,
      update,
      item: oldItem,
    };
  }

  await oldItem.saveTx();
  return {
    confirmed: true,
    status: "applied",
    update,
    item: oldItem,
  };
}

function formatUpdateResultMessage(result: MetadataUpdateResult) {
  if (result.status === "applied") {
    return getString("message-updateItem-success");
  }

  if (result.status === "canceled") {
    return getString("message-updateItem-cancel");
  }

  return `${getString("message-updateItem-skip")}: ${
    result.reason || NO_SAFE_CHANGES_REASON
  }`;
}

function normalizeTranslatedMetadataItem(newItem: any) {
  if (!newItem) {
    throw new Error("No translated metadata found");
  }

  const itemJSON =
    typeof newItem.toJSON === "function" ? newItem.toJSON() : newItem;

  if (!itemJSON || typeof itemJSON !== "object") {
    throw new Error("Translated metadata is not a valid item object");
  }

  return itemJSON;
}

function confirmMetadataUpdate(
  preview: SafeMetadataUpdateResult,
  win?: _ZoteroTypes.MainWindow,
) {
  const message = formatMetadataUpdatePreview(preview);
  const promptService = (globalThis as unknown as { Services?: any }).Services
    ?.prompt;
  const promptWindow = win ?? addon.data.mainWindow;

  if (promptService?.confirm) {
    return promptService.confirm(
      promptWindow,
      getString("metadata-preview-title"),
      message,
    );
  }

  if (typeof promptWindow?.confirm === "function") {
    return promptWindow.confirm(
      `${getString("metadata-preview-title")}\n\n${message}`,
    );
  }

  return false;
}

function formatPreviewValue(value: unknown) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (entry && typeof entry === "object") {
          return (
            (entry as any).tag ||
            (entry as any).lastName ||
            JSON.stringify(entry)
          );
        }
        return String(entry);
      })
      .join(", ");
  }

  return cleanText(value) || "(empty)";
}

function applySafeItemType(
  newItem: any,
  oldItem: Zotero.Item,
  result: SafeMetadataUpdateResult,
  options: ApplySafeMetadataUpdateOptions,
) {
  if (!newItem.itemType) {
    return;
  }

  if (newItem.itemType === "webpage") {
    result.skipped.push({
      field: "itemType",
      reason: "skip webpage fallback item type",
    });
    return;
  }

  const itemTypeID = Zotero.ItemTypes.getID(newItem.itemType);
  if (!itemTypeID || itemTypeID === oldItem.itemTypeID) {
    return;
  }

  const oldItemTypeID = oldItem.itemTypeID;
  if (!options.dryRun) {
    oldItem.setType(itemTypeID);
  }
  result.applied.push({
    field: "itemType",
    oldValue: oldItemTypeID,
    newValue: newItem.itemType,
  });
}

function applySafeCreators(
  newItem: any,
  oldItem: Zotero.Item,
  result: SafeMetadataUpdateResult,
  options: ApplySafeMetadataUpdateOptions,
) {
  if (Array.isArray(newItem.creators) && newItem.creators.length) {
    const oldCreators =
      typeof (oldItem as any).getCreators === "function"
        ? (oldItem as any).getCreators() || []
        : [];
    if (JSON.stringify(oldCreators) === JSON.stringify(newItem.creators)) {
      result.skipped.push({
        field: "creators",
        reason: "skip unchanged creators",
      });
      return;
    }

    if (!options.dryRun) {
      oldItem.setCreators(newItem.creators);
    }
    result.applied.push({
      field: "creators",
      oldValue: undefined,
      newValue: newItem.creators,
    });
  } else if ("creators" in newItem) {
    result.skipped.push({
      field: "creators",
      reason: "skip empty creators",
    });
  }
}

function applySafeFields(
  newItem: any,
  oldItem: Zotero.Item,
  result: SafeMetadataUpdateResult,
  options: ApplySafeMetadataUpdateOptions,
) {
  const fields = [
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
  ];

  for (const field of fields) {
    if (!(field in newItem)) {
      continue;
    }

    const fieldID = Zotero.ItemFields.getID(field);
    if (!fieldID) {
      continue;
    }

    if (
      !Zotero.ItemFields.isValidForType(
        fieldID,
        getEffectiveItemTypeID(newItem, oldItem, options),
      )
    ) {
      continue;
    }

    const oldValue = oldItem.getField(field);
    const safeValue = getSafeFieldValue(field, newItem[field], oldValue);
    if (safeValue.skip) {
      result.skipped.push({
        field,
        reason: safeValue.reason,
      });
      continue;
    }

    if (safeValue.value === oldValue) {
      result.skipped.push({
        field,
        reason: "skip unchanged value",
      });
      continue;
    }

    if (!options.dryRun) {
      oldItem.setField(field, safeValue.value);
    }
    result.applied.push({
      field,
      oldValue,
      newValue: safeValue.value,
    });
  }
}

function getEffectiveItemTypeID(
  newItem: any,
  oldItem: Zotero.Item,
  options: ApplySafeMetadataUpdateOptions,
) {
  if (!options.dryRun || !newItem.itemType || newItem.itemType === "webpage") {
    return oldItem.itemTypeID;
  }

  return Zotero.ItemTypes.getID(newItem.itemType) || oldItem.itemTypeID;
}

function getSafeFieldValue(
  field: string,
  newValue: unknown,
  oldValue: unknown,
) {
  if (field === "extra") {
    if (!splitExtraLines(newValue).length) {
      return {
        skip: true as const,
        reason: "skip empty value",
      };
    }
    return {
      skip: false as const,
      value: mergeExtra(oldValue, newValue),
    };
  }

  const oldText = cleanText(oldValue);
  const newText = cleanText(newValue);

  if (!newText) {
    return {
      skip: true as const,
      reason: "skip empty value",
    };
  }

  if (field === "title" && oldText && !isRelatedTitle(oldText, newText)) {
    return {
      skip: true as const,
      reason: "skip unrelated title",
    };
  }

  if (field === "date" && lowersDatePrecision(oldText, newText)) {
    return {
      skip: true as const,
      reason: "skip lower precision date",
    };
  }

  return {
    skip: false as const,
    value: newText,
  };
}

export function mergeExtra(oldExtra: unknown, newExtra: unknown) {
  const oldLines = splitExtraLines(oldExtra);
  const mergedLines = [...oldLines];
  const existingKeys = new Set(
    oldLines
      .map((line) => getExtraKey(line))
      .filter((key): key is string => typeof key === "string"),
  );

  for (const line of splitExtraLines(newExtra)) {
    const key = getExtraKey(line);
    if (key) {
      if (!existingKeys.has(key)) {
        mergedLines.push(line);
        existingKeys.add(key);
      }
      continue;
    }

    if (!mergedLines.includes(line)) {
      mergedLines.push(line);
    }
  }

  return mergedLines.join("\n");
}

function splitExtraLines(extra: unknown) {
  return String(extra || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function getExtraKey(line: string) {
  const match = /^([^:\n]+):\s*.*$/.exec(line);
  return match?.[1]?.trim().toLowerCase();
}

function applySafeTags(
  newItem: any,
  oldItem: Zotero.Item,
  result: SafeMetadataUpdateResult,
  options: ApplySafeMetadataUpdateOptions,
) {
  if (!Array.isArray(newItem.tags)) {
    return;
  }

  if (!newItem.tags.length) {
    result.skipped.push({
      field: "tags",
      reason: "skip empty tags",
    });
    return;
  }

  const oldTags =
    typeof oldItem.getTags === "function" ? oldItem.getTags() || [] : [];
  const manualTags = oldTags.filter((tag: any) => tag?.type !== 1);
  const oldTagNames = new Set(
    oldTags.map((tag: any) => tag?.tag).filter(Boolean),
  );
  const newAutomaticTags = newItem.tags
    .filter((tag: any) => tag?.tag && !oldTagNames.has(tag.tag))
    .map((tag: any) => ({
      ...tag,
      type: 1,
    }));
  if (!newAutomaticTags.length) {
    result.skipped.push({
      field: "tags",
      reason: "skip unchanged tags",
    });
    return;
  }

  if (!options.dryRun) {
    oldItem.setTags([...manualTags, ...newAutomaticTags]);
  }
  result.applied.push({
    field: "tags",
    oldValue: oldTags,
    newValue: [...manualTags, ...newAutomaticTags],
  });
}

export function lowersDatePrecision(oldDate: unknown, newDate: unknown) {
  const oldPrecision = getDatePrecision(cleanText(oldDate));
  const newPrecision = getDatePrecision(cleanText(newDate));
  return oldPrecision > 0 && newPrecision > 0 && newPrecision < oldPrecision;
}

function getDatePrecision(date: string) {
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(date)) {
    return 3;
  }
  if (/^\d{4}-\d{1,2}$/.test(date)) {
    return 2;
  }
  if (/^\d{4}$/.test(date)) {
    return 1;
  }
  return 0;
}

export function isRelatedTitle(oldTitle: unknown, newTitle: unknown) {
  const oldNormalized = normalizeTitle(oldTitle);
  const newNormalized = normalizeTitle(newTitle);

  if (!oldNormalized || !newNormalized) {
    return true;
  }

  if (
    oldNormalized === newNormalized ||
    oldNormalized.includes(newNormalized) ||
    newNormalized.includes(oldNormalized)
  ) {
    return true;
  }

  const oldTokens = titleTokens(oldNormalized);
  const newTokens = titleTokens(newNormalized);
  const overlap = oldTokens.filter((token) => newTokens.includes(token)).length;
  return overlap / Math.min(oldTokens.length, newTokens.length) >= 0.35;
}

function normalizeTitle(title: unknown) {
  return cleanText(title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function titleTokens(title: string) {
  return title.split(/\s+/).filter(Boolean);
}
