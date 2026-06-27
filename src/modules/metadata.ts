import { getString } from "../utils/locale";
import { config } from "../../package.json";
import { getPref } from "../utils/prefs";

export function isSupportedMetadataURL(url: unknown): url is string {
  return (
    typeof url === "string"
    && /^https?:\/\/([^/]+\.)?douban\.com(?:[/:?#]|$)/i.test(url)
  );
}

export function isNoTitleSpecifiedError(err: unknown) {
  return /no title specified/i.test(getErrorMessage(err));
}

type MetadataProviderInput = {
  url?: string;
  oldItem?: Zotero.Item;
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
    queryContent(doc, 'meta[property="og:title"]')
    || queryJSONLDName(doc)
    || queryText(doc, "h1 span")
    || cleanDoubanTitle(doc.title)
  );
}

export async function getMeta() {
  const items = ZoteroPane.getSelectedItems().filter((item) => {
    return item.isRegularItem();
  });
  const popWin = new ztoolkit.ProgressWindow(config.addonName, {
    closeOnClick: true,
    closeTime: -1,
  });

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

  for (const [index, item] of items.entries()) {
    const current = `${index + 1}/${items.length}`;

    try {
      const url = item.getField("url");
      if (!isSupportedMetadataURL(url)) {
        throw new Error("Unsupported or missing Douban URL");
      }

      const translatedResult = await translateMetadataForItem(url, item);
      const translatedItem = translatedResult.item;
      if (!translatedItem) {
        throw new Error("No translated metadata found");
      }

      if (getPref("schema") === "save") {
        popWin.changeLine({
          type: "success",
          progress: 0,
          text: `${current}${getString("message-saveItem-success")}`,
          idx: 1,
        });
        continue;
      }

      const startTime = Date.now();
      const updateResult = await updateItem(translatedItem, item);
      const endTime = Date.now();
      ztoolkit.log(`updateItem took ${endTime - startTime} milliseconds`);
      popWin.changeLine({
        type: updateResult.confirmed ? "success" : "default",
        progress: 0,
        text: `${current}${getString(
          updateResult.confirmed
            ? "message-updateItem-success"
            : "message-updateItem-cancel",
        )}`,
        idx: 1,
      });
    } catch (err) {
      ztoolkit.log(err);
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
}

function getSettings(): {
  saveAttachments: boolean;
  libraryID: boolean | number;
  collections?: number[];
} {
  const coll = ZoteroPane.getSelectedCollection()?.id;
  const options = getPref("schema");

  // 创建返回对象的基本结构
  const settings: {
    saveAttachments: boolean;
    libraryID: boolean | number;
    collections?: number[];
  } = {
    saveAttachments: getPref("saveAttachments") as boolean,
    libraryID: options === "save" ? Zotero.Libraries.userLibraryID : false,
  };

  // 如果 coll 存在，才添加到 settings 中
  if (typeof coll === "number") {
    settings.collections = [coll];
  }

  return settings;
}

async function translateDoubanDocument(doc: Document, url: string) {
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

  const options = getSettings();
  try {
    const translatedItems = await translate.translate(options);
    if (!Array.isArray(translatedItems)) {
      throw new Error("Translator did not return an item list");
    }

    return translatedItems.map((item) => normalizeTranslatedItem(item, doc, url));
  } catch (err) {
    ztoolkit.log(err);
    if (isNoTitleSpecifiedError(err)) {
      return [buildFallbackDoubanItem(doc, url)];
    }
    throw new Error(`Zotero translator failed: ${getErrorMessage(err)}`);
  }
}

async function translateURL(url: string) {
  let key = url;
  try {
    const uri = Services.io.newURI(url);
    key = uri.host;
  } catch (e) {
    ztoolkit.log(e);
  }
  // Limit to two requests per second per host
  const caller = _getConcurrentCaller(key, 500);
  return caller.start(() => _translateURLNow(url));
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

async function _translateURLNow(url: string) {
  const doc = (await Zotero.HTTP.processDocuments(url, (doc) => doc))[0];
  if (!doc) {
    throw new Error("Unable to load metadata URL");
  }

  const newItems = await translateDoubanDocument(doc, url);
  if (!newItems.length) {
    throw new Error("Zotero translator returned no metadata items");
  }

  return newItems[0];
}

async function translateDoubanURLProvider(input: MetadataProviderInput) {
  if (!input.url) {
    throw new Error("Douban provider requires a URL");
  }
  return [await translateURL(input.url)];
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

  const translatedItems = await translate.translate(getSettings());

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

async function translateMetadataForItem(url: string, oldItem: Zotero.Item) {
  return translateWithMetadataProviders(
    {
      url,
      oldItem,
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
  const scripts = Array.from(
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
  const options = {
    url: newItem["attachments"][0]["url"],
    contentType: newItem["attachments"][0]["mimeType"],
    title: newItem["attachments"][0]["title"],
    parentItemID: oldItem.id,
    libraryID: Zotero.Libraries.userLibraryID,
    fileBaseName: `${newItem.creators[0].lastName} - ${newItem.date.slice(0, 4)} - ${newItem.title.replace(/\//g, "")}`,
  };
  Zotero.Attachments.importFromURL(options);
  ztoolkit.log("save Attachments successful");
}

async function updateItem(newItem: any, oldItem: Zotero.Item) {
  // for (const field of Object.keys(newItem)) {
  //   switch (field) {
  //     case "notes":
  //       {
  //         if (newItem["notes"].length === 0) break;
  //         if (getPref("saveAttachments") === true) {
  //           const noteIDs = oldItem.getNotes();
  //           if (noteIDs.length === 0) {
  //             saveNote(newItem, oldItem);
  //           } else {
  //             const results = [];
  //             for (const noteID of noteIDs) {
  //               const noteItem = Zotero.Items.get(noteID);
  //               const noteTitle = noteItem.getNoteTitle();
  //               const regex = /目录/;
  //               const result = regex.test(noteTitle);
  //               results.push(result);
  //             }
  //             if (!results.some((result) => result === true)) {
  //               saveNote(newItem, oldItem);
  //             }
  //           }
  //         }
  //       }
  //       break;
  //     case "attachments":
  //       {
  //         if (newItem["attachments"].length === 0) break;
  //         if (getPref("saveAttachments") === true) {
  //           const attachmentIDs = oldItem.getAttachments();
  //           if (attachmentIDs.length === 0) {
  //             saveAttachments(newItem, oldItem);
  //           } else {
  //             const results = [];
  //             for (const attachmentID of attachmentIDs) {
  //               const attachmentItem = Zotero.Items.get(attachmentID);
  //               if (attachmentItem.getField("title") === newItem["title"]) {
  //                 results.push(true);
  //               }
  //             }
  //             if (!results.some((result) => result === true)) {
  //               saveAttachments(newItem, oldItem);
  //             }
  //           }
  //         }
  //       }
  //       break;
  //     case "tags":
  //     case "seeAlso":
  //     case "itemType":
  //       break;
  //     case "creators":
  //       oldItem.setCreators(newItem["creators"]);
  //       ztoolkit.log("Update creators");
  //       break;
  //     default: {
  //       const newFieldValue = newItem[field] ?? "",
  //         // @ts-ignore field 已为 Zotero.Item.ItemField
  //         oldFieldValue = oldItem.getField(field);
  //       ztoolkit.log(
  //         `Update ${field} from ${oldFieldValue} to ${newFieldValue}`,
  //       );
  //       // @ts-ignore field 已为 Zotero.Item.ItemField
  //       oldItem.setField(field, newFieldValue);
  //       break;
  //     }
  //   }
  // }
  // await oldItem.saveTx();
  // return oldItem;
  const itemJSON = normalizeTranslatedMetadataItem(newItem);
  ztoolkit.log(`Update item from translated ${itemJSON.itemType ?? "item"}`);
  const result = await applyMetadataUpdateWithConfirmation(
    itemJSON,
    oldItem,
    getPref("confirmBeforeUpdate") === true
      ? (preview) => confirmMetadataUpdate(preview)
      : () => true,
  );
  ztoolkit.log(
    `Applied ${result.update.applied.length} metadata changes, skipped ${result.update.skipped.length}`,
  );

  return result;
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
  update: SafeMetadataUpdateResult;
  item: Zotero.Item;
};

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

export function buildMetadataUpdatePreview(
  newItem: any,
  oldItem: Zotero.Item,
) {
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

  if (!confirmUpdate(preview)) {
    return {
      confirmed: false,
      update: preview,
      item: oldItem,
    };
  }

  const update = applySafeMetadataUpdate(itemJSON, oldItem);
  await oldItem.saveTx();
  return {
    confirmed: true,
    update,
    item: oldItem,
  };
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

function confirmMetadataUpdate(preview: SafeMetadataUpdateResult) {
  const message = formatMetadataUpdatePreview(preview);
  const promptService = (globalThis as unknown as { Services?: any }).Services
    ?.prompt;

  if (promptService?.confirm) {
    return promptService.confirm(
      window,
      getString("metadata-preview-title"),
      message,
    );
  }

  if (typeof window.confirm === "function") {
    return window.confirm(
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
            (entry as any).tag || (entry as any).lastName || JSON.stringify(entry)
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

function getSafeFieldValue(field: string, newValue: unknown, oldValue: unknown) {
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
  const oldTagNames = new Set(oldTags.map((tag: any) => tag?.tag).filter(Boolean));
  const newAutomaticTags = newItem.tags
    .filter((tag: any) => tag?.tag && !oldTagNames.has(tag.tag))
    .map((tag: any) => ({
      ...tag,
      type: 1,
    }));

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
    oldNormalized === newNormalized
    || oldNormalized.includes(newNormalized)
    || newNormalized.includes(oldNormalized)
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
