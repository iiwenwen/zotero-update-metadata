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

      const translatedItem = await translateURL(url);
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
      await updateItem(translatedItem, item);
      const endTime = Date.now();
      ztoolkit.log(`updateItem took ${endTime - startTime} milliseconds`);
      popWin.changeLine({
        type: "success",
        progress: 0,
        text: `${current}${getString("message-updateItem-success")}`,
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

async function translateDocument(doc: Document, url: string) {
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

  const newItems = await translateDocument(doc, url);
  if (!newItems.length) {
    throw new Error("Zotero translator returned no metadata items");
  }

  return newItems[0];
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
  if (!newItem) {
    throw new Error("No translated metadata found");
  }

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
  const itemJSON =
    typeof newItem.toJSON === "function" ? newItem.toJSON() : newItem;

  if (!itemJSON || typeof itemJSON !== "object") {
    throw new Error("Translated metadata is not a valid item object");
  }

  ztoolkit.log(`Update item from translated ${itemJSON.itemType ?? "item"}`);

  try {
    oldItem.fromJSON(itemJSON);
  } catch (err) {
    ztoolkit.log(`fromJSON update failed, falling back to field update: ${err}`);
    updateItemFields(itemJSON, oldItem);
  }

  await oldItem.saveTx();
  return oldItem;
}

function updateItemFields(newItem: any, oldItem: Zotero.Item) {
  if (newItem.itemType) {
    const itemTypeID = Zotero.ItemTypes.getID(newItem.itemType);
    if (itemTypeID) {
      oldItem.setType(itemTypeID);
    }
  }

  if (Array.isArray(newItem.creators)) {
    oldItem.setCreators(newItem.creators);
  }

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

    if (!Zotero.ItemFields.isValidForType(fieldID, oldItem.itemTypeID)) {
      continue;
    }

    oldItem.setField(field, newItem[field] ?? "");
  }

  if (Array.isArray(newItem.tags)) {
    oldItem.setTags(newItem.tags);
  }
}
