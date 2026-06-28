import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";

const tmp = mkdtempSync(path.join(tmpdir(), "metadata-smoke-"));
const outfile = path.join(tmp, "metadata.cjs");
const attachmentPreferencesOutfile = path.join(
  tmp,
  "attachmentPreferences.cjs",
);
const menuOutfile = path.join(tmp, "menu.cjs");
const require = createRequire(import.meta.url);

try {
  await build({
    entryPoints: ["src/modules/metadata.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    outfile,
    logLevel: "silent",
  });
  await build({
    entryPoints: ["src/modules/attachmentPreferences.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    outfile: attachmentPreferencesOutfile,
    logLevel: "silent",
  });
  await build({
    entryPoints: ["src/modules/menu.ts"],
    bundle: true,
    format: "cjs",
    platform: "node",
    outfile: menuOutfile,
    logLevel: "silent",
  });

  const {
    applyMetadataUpdateWithConfirmation,
    applySafeMetadataUpdate,
    buildAttachmentImportOptions,
    buildMetadataTranslationSettings,
    buildMetadataUpdatePreview,
    buildFallbackDoubanItem,
    extractDoubanTitle,
    formatBatchUpdateSummary,
    formatBatchUpdateSummaryLines,
    formatMetadataUpdatePreview,
    getConfiguredAttachmentSaveStrategy,
    getItemISBN,
    isNoTitleSpecifiedError,
    lowersDatePrecision,
    METADATA_RESULT_CLOSE_TIME_MS,
    mergeExtra,
    normalizeAttachmentSaveStrategy,
    normalizeMetadataOperationSchema,
    shouldConfirmBeforeMetadataUpdate,
    shouldTryAttachmentSave,
    saveNewMetadataItem,
    sanitizeMetadataLogData,
    translateWithMetadataProviders,
  } = require(outfile);
  const { setConfiguredAttachmentSaveStrategy } = require(
    attachmentPreferencesOutfile,
  );
  const { METADATA_MENU_ACTIONS } = require(menuOutfile);

  globalThis.ztoolkit = {
    log() {},
  };

  const documentWithMeta = createMockDocument({
    title: "Ignored browser title (豆瓣)",
    selectors: {
      'meta[property="og:title"]': { content: " Norwegian Wood " },
      'meta[property="book:author"]': { content: "Haruki Murakami" },
      'meta[property="book:isbn"]': { content: "9780099448822" },
      'meta[property="og:description"]': {
        content: "When he hears her favourite Beatles song...",
      },
    },
  });

  assert.equal(extractDoubanTitle(documentWithMeta), "Norwegian Wood");
  assert.deepEqual(
    buildFallbackDoubanItem(
      documentWithMeta,
      "https://book.douban.com/subject/1355643/",
    ),
    {
      __fallbackDoubanItem: true,
      itemType: "book",
      title: "Norwegian Wood",
      url: "https://book.douban.com/subject/1355643/",
      creators: [
        {
          creatorType: "author",
          lastName: "Haruki Murakami",
          fieldMode: 1,
        },
      ],
      ISBN: "9780099448822",
      abstractNote: "When he hears her favourite Beatles song...",
    },
  );

  const documentWithJSONLD = createMockDocument({
    title: "Fallback title (豆瓣)",
    selectors: {
      'script[type="application/ld+json"]': {
        textContent: JSON.stringify({ "@type": "Book", name: "JSON-LD Title" }),
      },
    },
  });

  assert.equal(extractDoubanTitle(documentWithJSONLD), "JSON-LD Title");
  assert.equal(isNoTitleSpecifiedError(new Error("No title specified")), true);
  assert.equal(isNoTitleSpecifiedError(new Error("Network failed")), false);
  assert.equal(METADATA_RESULT_CLOSE_TIME_MS, 8000);
  assert.equal(normalizeMetadataOperationSchema("save"), "save");
  assert.equal(normalizeMetadataOperationSchema("update"), "update");
  assert.equal(normalizeMetadataOperationSchema("bad-value"), "update");
  assert.equal(lowersDatePrecision("2020-05-06", "2020"), true);
  assert.equal(lowersDatePrecision("2020", "2020-05-06"), false);
  assert.deepEqual(
    sanitizeMetadataLogData({
      schema: "save",
      title: "Private Reading Title",
      libraryID: 1,
      collectionID: 9,
      savedItemID: 123,
      attachmentCount: 0,
      attempts: [
        {
          provider: "douban-url",
          ok: false,
          error: "No translated metadata found",
          url: "https://book.douban.com/subject/private/",
        },
      ],
    }),
    {
      schema: "save",
      savedItemID: 123,
      attachmentCount: 0,
      attempts: [
        {
          provider: "douban-url",
          ok: false,
          error: "No translated metadata found",
        },
      ],
    },
  );
  assert.equal(
    mergeExtra("DOI: old-doi\nUser Note: keep me", "DOI: new-doi\nISBN: 978"),
    "DOI: old-doi\nUser Note: keep me\nISBN: 978",
  );

  const savedNewItems = [];
  const importedAttachments = [];

  globalThis.Zotero = {
    Item: class MockZoteroItem {
      constructor(itemType) {
        this.id = undefined;
        this.itemType = itemType;
        this.itemTypeID = globalThis.Zotero.ItemTypes.getID(itemType);
        this.libraryID = undefined;
        this.fields = {};
        this.collections = [];
        this.attachments = [];
        this.notes = [];
        this.saveCount = 0;
      }

      fromJSON(json) {
        this.json = { ...json };
        this.itemType = json.itemType || this.itemType;
        this.itemTypeID = globalThis.Zotero.ItemTypes.getID(this.itemType);
        this.fields = { ...json };
      }

      setCollections(collections) {
        this.collections = [...collections];
      }

      getAttachments() {
        return [...this.attachments];
      }

      getNotes() {
        return [...this.notes];
      }

      setNote(note) {
        this.note = note;
      }

      async saveTx() {
        this.saveCount += 1;
        if (!this.id) {
          this.id = 200 + savedNewItems.length;
        }
        savedNewItems.push(this);
      }
    },
    Attachments: {
      async importFromURL(options) {
        importedAttachments.push({ ...options });
        return { id: 500 + importedAttachments.length, ...options };
      },
    },
    ItemTypes: {
      getID(itemType) {
        return { book: 1, webpage: 2 }[itemType] || 0;
      },
    },
    ItemFields: {
      getID(field) {
        return field;
      },
      isValidForType() {
        return true;
      },
    },
    Libraries: {
      userLibraryID: 1,
    },
  };

  assert.deepEqual(
    buildMetadataTranslationSettings({
      saveAttachments: true,
      libraryID: 1,
      collections: [9],
    }),
    {
      saveAttachments: false,
      libraryID: false,
    },
  );

  const mockItem = createMockItem({
    itemTypeID: 1,
    fields: {
      title: "Norwegian Wood",
      date: "1987-09-04",
      publisher: "Existing Publisher",
      extra: "DOI: old-doi\nUser Note: keep me",
    },
    tags: [
      { tag: "manual tag", type: 0 },
      { tag: "old automatic", type: 1 },
    ],
  });

  const updateResult = applySafeMetadataUpdate(
    {
      itemType: "webpage",
      title: "Completely Different Book",
      date: "1987",
      publisher: "",
      extra: "DOI: new-doi\nISBN: 9780099448822",
      tags: [{ tag: "translated tag" }],
    },
    mockItem,
  );

  assert.equal(mockItem.itemTypeID, 1);
  assert.equal(mockItem.getField("title"), "Norwegian Wood");
  assert.equal(mockItem.getField("date"), "1987-09-04");
  assert.equal(mockItem.getField("publisher"), "Existing Publisher");
  assert.equal(
    mockItem.getField("extra"),
    "DOI: old-doi\nUser Note: keep me\nISBN: 9780099448822",
  );
  assert.deepEqual(mockItem.getTags(), [
    { tag: "manual tag", type: 0 },
    { tag: "translated tag", type: 1 },
  ]);
  assert.deepEqual(
    new Set(updateResult.skipped.map((skip) => skip.field)),
    new Set(["itemType", "title", "date", "publisher"]),
  );

  const mockItemWithAutomaticTags = createMockItem({
    itemTypeID: 1,
    fields: {},
    tags: [{ tag: "keep automatic when incoming empty", type: 1 }],
  });
  const emptyTagsResult = applySafeMetadataUpdate(
    { tags: [] },
    mockItemWithAutomaticTags,
  );
  assert.deepEqual(mockItemWithAutomaticTags.getTags(), [
    { tag: "keep automatic when incoming empty", type: 1 },
  ]);
  assert.equal(
    emptyTagsResult.skipped.some((skip) => skip.field === "tags"),
    true,
  );

  const previewItem = createMockItem({
    itemTypeID: 1,
    fields: {
      title: "Norwegian Wood",
      date: "1987-09-04",
      publisher: "Existing Publisher",
      ISBN: "",
      abstractNote: "",
      extra: "User Note: keep me",
    },
    tags: [{ tag: "manual tag", type: 0 }],
  });
  const previewResult = buildMetadataUpdatePreview(
    {
      title: "Norwegian Wood",
      creators: [{ creatorType: "author", lastName: "Haruki Murakami" }],
      date: "1987",
      publisher: "Vintage",
      ISBN: "9780099448822",
      abstractNote: "Preview abstract",
      extra: "ISBN: 9780099448822",
      tags: [{ tag: "translated tag" }],
    },
    previewItem,
  );
  const previewText = formatMetadataUpdatePreview(previewResult);

  assert.equal(previewItem.getField("publisher"), "Existing Publisher");
  assert.equal(previewItem.getField("ISBN"), "");
  assert.equal(previewItem.saveCount, 0);
  assert.match(previewText, /publisher: Existing Publisher -> Vintage/);
  assert.match(previewText, /creators: \(empty\) -> Haruki Murakami/);
  assert.match(previewText, /ISBN: \(empty\) -> 9780099448822/);
  assert.match(previewText, /date: skipped \(skip lower precision date\)/);
  assert.match(previewText, /tags: manual tag -> manual tag, translated tag/);

  const cancelItem = createMockItem({
    itemTypeID: 1,
    fields: {
      title: "Norwegian Wood",
      publisher: "Existing Publisher",
    },
    tags: [],
  });
  const cancelResult = await applyMetadataUpdateWithConfirmation(
    {
      title: "Norwegian Wood",
      publisher: "Vintage",
    },
    cancelItem,
    () => false,
  );

  assert.equal(cancelResult.confirmed, false);
  assert.equal(cancelResult.status, "canceled");
  assert.equal(cancelItem.getField("publisher"), "Existing Publisher");
  assert.equal(cancelItem.saveCount, 0);

  const confirmItem = createMockItem({
    itemTypeID: 1,
    fields: {
      title: "Norwegian Wood",
      publisher: "Existing Publisher",
    },
    tags: [],
  });
  let confirmCalls = 0;
  const confirmResult = await applyMetadataUpdateWithConfirmation(
    {
      title: "Norwegian Wood",
      publisher: "Vintage",
    },
    confirmItem,
    (preview) => {
      confirmCalls += 1;
      assert.equal(
        preview.applied.some((change) => change.field === "publisher"),
        true,
      );
      return true;
    },
  );

  assert.equal(confirmResult.confirmed, true);
  assert.equal(confirmResult.status, "applied");
  assert.equal(confirmCalls, 1);
  assert.equal(confirmItem.getField("publisher"), "Vintage");
  assert.equal(confirmItem.saveCount, 1);

  const noChangeItem = createMockItem({
    itemTypeID: 1,
    fields: {
      title: "Norwegian Wood",
    },
    tags: [],
  });
  let noChangeConfirmCalls = 0;
  const noChangeResult = await applyMetadataUpdateWithConfirmation(
    {
      title: "Norwegian Wood",
    },
    noChangeItem,
    () => {
      noChangeConfirmCalls += 1;
      return true;
    },
  );

  assert.equal(noChangeResult.confirmed, false);
  assert.equal(noChangeResult.status, "skipped");
  assert.equal(noChangeResult.reason, "no safe metadata changes");
  assert.equal(noChangeConfirmCalls, 0);
  assert.equal(noChangeItem.saveCount, 0);

  const isbnItem = createMockItem({
    itemTypeID: 1,
    fields: {
      ISBN: "978-0-099-44882-2",
    },
    tags: [],
  });

  assert.equal(getItemISBN(isbnItem), "9780099448822");

  const doubanProviderResult = await translateWithMetadataProviders(
    {
      url: "https://book.douban.com/subject/1355643/",
      oldItem: isbnItem,
    },
    [
      {
        name: "douban-url",
        canTranslate: () => true,
        translate: async () => [{ title: "Douban Result" }],
      },
      {
        name: "isbn",
        canTranslate: () => true,
        translate: async () => [{ title: "ISBN Result" }],
      },
    ],
  );

  assert.equal(doubanProviderResult.provider, "douban-url");
  assert.deepEqual(doubanProviderResult.item, { title: "Douban Result" });
  assert.deepEqual(doubanProviderResult.attempts, [
    { provider: "douban-url", ok: true },
  ]);

  const isbnFallbackResult = await translateWithMetadataProviders(
    {
      url: "https://book.douban.com/subject/1355643/",
      oldItem: isbnItem,
    },
    [
      {
        name: "douban-url",
        canTranslate: () => true,
        translate: async () => {
          throw new Error("URL translator failed");
        },
      },
      {
        name: "isbn",
        canTranslate: (input) => Boolean(getItemISBN(input.oldItem)),
        translate: async () => [{ title: "ISBN Result" }],
      },
    ],
  );

  assert.equal(isbnFallbackResult.provider, "isbn");
  assert.deepEqual(isbnFallbackResult.item, { title: "ISBN Result" });
  assert.deepEqual(isbnFallbackResult.attempts, [
    {
      provider: "douban-url",
      ok: false,
      error: "URL translator failed",
    },
    { provider: "isbn", ok: true },
  ]);

  await assert.rejects(
    () =>
      translateWithMetadataProviders(
        {
          url: "https://book.douban.com/subject/1355643/",
          oldItem: isbnItem,
        },
        [
          {
            name: "douban-url",
            canTranslate: () => true,
            translate: async () => {
              throw new Error("URL translator failed");
            },
          },
          {
            name: "isbn",
            canTranslate: (input) => Boolean(getItemISBN(input.oldItem)),
            translate: async () => {
              throw new Error("ISBN lookup failed");
            },
          },
        ],
      ),
    /Metadata providers failed: douban-url: URL translator failed; isbn: ISBN lookup failed/,
  );

  assert.equal(
    formatBatchUpdateSummary({
      success: 2,
      failed: 1,
      skipped: 1,
      canceled: 1,
      fallback: 1,
      reasons: {
        "missing URL": 1,
        "translator failed": 1,
      },
    }),
    "Summary: success 2, failed 1, skipped 1, canceled 1, fallback 1, reasons: missing URL x1; translator failed x1",
  );
  assert.equal(
    formatBatchUpdateSummary({
      success: 1,
      failed: 0,
      skipped: 0,
      canceled: 0,
      fallback: 0,
      reasons: {},
    }),
    "Summary: success 1",
  );
  assert.deepEqual(
    formatBatchUpdateSummaryLines({
      success: 2,
      failed: 1,
      skipped: 1,
      canceled: 1,
      fallback: 1,
      reasons: {
        "missing URL": 1,
        "translator failed": 1,
      },
    }),
    [
      "Summary:",
      "success 2",
      "failed 1",
      "skipped 1",
      "canceled 1",
      "fallback 1",
      "reasons: missing URL x1; translator failed x1",
    ],
  );
  assert.deepEqual(
    formatBatchUpdateSummaryLines({
      success: 1,
      failed: 0,
      skipped: 0,
      canceled: 0,
      fallback: 0,
      reasons: {},
    }),
    ["Summary:", "success 1"],
  );
  assert.equal(
    formatBatchUpdateSummary(
      {
        success: 2,
        failed: 1,
        skipped: 1,
        canceled: 1,
        fallback: 1,
        reasons: {
          "missing URL": 1,
          "translator failed": 1,
        },
      },
      {
        title: "汇总",
        success: "成功",
        failed: "失败",
        skipped: "跳过",
        canceled: "取消",
        fallback: "备用来源",
        reasons: "原因",
      },
    ),
    "汇总: 成功 2, 失败 1, 跳过 1, 取消 1, 备用来源 1, 原因: missing URL x1; translator failed x1",
  );

  assert.equal(normalizeAttachmentSaveStrategy("always"), "always");
  assert.equal(normalizeAttachmentSaveStrategy("bad-value"), "none");

  globalThis.Zotero.Prefs = {
    get(prefName) {
      if (prefName.endsWith(".attachmentSaveStrategy")) {
        return "legacy";
      }
      if (prefName.endsWith(".saveAttachments")) {
        return false;
      }
      return undefined;
    },
  };
  assert.equal(getConfiguredAttachmentSaveStrategy(), "none");

  globalThis.Zotero.Prefs = {
    get(prefName) {
      if (prefName.endsWith(".attachmentSaveStrategy")) {
        return "legacy";
      }
      if (prefName.endsWith(".saveAttachments")) {
        return true;
      }
      return undefined;
    },
  };
  assert.equal(getConfiguredAttachmentSaveStrategy(), "missing");

  globalThis.Zotero.Prefs = {
    get(prefName) {
      if (prefName.endsWith(".attachmentSaveStrategy")) {
        return "always";
      }
      if (prefName.endsWith(".saveAttachments")) {
        return false;
      }
      return undefined;
    },
  };
  assert.equal(getConfiguredAttachmentSaveStrategy(), "always");

  const preferenceWrites = [];
  globalThis.Zotero.Prefs = {
    set(prefName, value) {
      preferenceWrites.push({ prefName, value });
      return true;
    },
  };
  assert.equal(setConfiguredAttachmentSaveStrategy("always"), "always");
  assert.equal(setConfiguredAttachmentSaveStrategy("bad-value"), "none");
  assert.deepEqual(
    preferenceWrites.map(({ prefName, value }) => ({
      key: prefName.replace(/^extensions\.zotero\.updatemetadata\./, ""),
      value,
    })),
    [
      { key: "attachmentSaveStrategy", value: "always" },
      { key: "saveAttachments", value: true },
      { key: "attachmentSaveStrategy", value: "none" },
      { key: "saveAttachments", value: false },
    ],
  );

  globalThis.Zotero.Prefs = {
    get(prefName) {
      assert.match(prefName, /confirmBeforeUpdate$/);
      return "true";
    },
  };
  assert.equal(
    shouldConfirmBeforeMetadataUpdate(),
    true,
    "string true from Zotero preferences should enable update confirmation",
  );

  globalThis.Zotero.Prefs = {
    get() {
      return true;
    },
  };
  assert.equal(shouldConfirmBeforeMetadataUpdate(), true);

  globalThis.Zotero.Prefs = {
    get() {
      return false;
    },
  };
  assert.equal(shouldConfirmBeforeMetadataUpdate(), false);

  globalThis.Zotero.Prefs = {
    get() {
      return "false";
    },
  };
  assert.equal(shouldConfirmBeforeMetadataUpdate(), false);

  const itemWithoutAttachments = createMockItem({
    itemTypeID: 1,
    fields: {},
    tags: [],
    attachments: [],
  });
  const itemWithAttachments = createMockItem({
    itemTypeID: 1,
    fields: {},
    tags: [],
    attachments: [10],
  });
  const translatedWithAttachment = {
    title: "Norwegian Wood",
    creators: [{ lastName: "Murakami" }],
    date: "1987-09-04",
    attachments: [
      {
        url: "https://example.test/fulltext.pdf",
        mimeType: "application/pdf",
        title: "Full Text",
      },
    ],
  };

  assert.equal(
    shouldTryAttachmentSave(
      translatedWithAttachment,
      itemWithoutAttachments,
      "missing",
    ),
    true,
  );
  assert.equal(
    shouldTryAttachmentSave(
      translatedWithAttachment,
      itemWithAttachments,
      "missing",
    ),
    false,
  );
  assert.equal(
    shouldTryAttachmentSave(
      translatedWithAttachment,
      itemWithAttachments,
      "always",
    ),
    true,
  );

  assert.deepEqual(
    buildAttachmentImportOptions(
      {
        ...translatedWithAttachment,
        attachments: [{ mimeType: "application/pdf", title: "Full Text" }],
      },
      itemWithoutAttachments,
    ),
    {
      ok: false,
      reason: "missing attachment URL",
    },
  );

  assert.deepEqual(
    buildAttachmentImportOptions(
      translatedWithAttachment,
      itemWithoutAttachments,
    ),
    {
      ok: true,
      options: {
        url: "https://example.test/fulltext.pdf",
        contentType: "application/pdf",
        title: "Full Text",
        parentItemID: itemWithoutAttachments.id,
        libraryID: itemWithoutAttachments.libraryID,
        fileBaseName: "Murakami - 1987 - Norwegian Wood",
      },
    },
  );

  globalThis.Zotero.Prefs = {
    get(prefName) {
      if (prefName.endsWith(".saveNotes")) {
        return false;
      }
      if (prefName.endsWith(".attachmentSaveStrategy")) {
        return "missing";
      }
      return undefined;
    },
  };

  savedNewItems.length = 0;
  importedAttachments.length = 0;
  const saveNewResult = await saveNewMetadataItem(translatedWithAttachment, {
    saveAttachments: true,
    libraryID: 1,
    collections: [9],
  });

  assert.equal(saveNewResult.status, "saved");
  assert.equal(savedNewItems.length, 1);
  assert.equal(importedAttachments.length, 1);
  assert.equal(saveNewResult.item.saveCount, 1);
  assert.deepEqual(saveNewResult.item.collections, [9]);
  assert.equal(saveNewResult.item.json.title, "Norwegian Wood");
  assert.equal(saveNewResult.item.json.attachments, undefined);
  assert.equal(saveNewResult.item.json.notes, undefined);
  assert.equal(importedAttachments[0].parentItemID, saveNewResult.item.id);
  assert.equal(importedAttachments[0].libraryID, 1);
  assert.equal(importedAttachments[0].title, "Full Text");

  savedNewItems.length = 0;
  importedAttachments.length = 0;
  await saveNewMetadataItem(translatedWithAttachment, {
    saveAttachments: false,
    libraryID: 1,
  });
  assert.equal(savedNewItems.length, 1);
  assert.equal(importedAttachments.length, 0);

  savedNewItems.length = 0;
  await assert.rejects(
    () =>
      saveNewMetadataItem(
        {
          itemType: "book",
          attachments: translatedWithAttachment.attachments,
        },
        {
          saveAttachments: true,
          libraryID: 1,
        },
      ),
    /Translated metadata has no title/,
  );
  assert.equal(savedNewItems.length, 0);

  assertPreferenceWindowLocalization();
  assertPreferenceCheckboxBindings();
  assertMenuActionContract(METADATA_MENU_ACTIONS);

  console.log("metadata douban fallback smoke: pass");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

function assertMenuActionContract(actions) {
  assert.deepEqual(actions, [
    {
      id: "updateMetadata-action-update",
      labelKey: "itemmenu-updateExistingMetadata-label",
      schema: "update",
    },
    {
      id: "updateMetadata-action-save",
      labelKey: "itemmenu-saveNewMetadata-label",
      schema: "save",
    },
  ]);

  const menuSource = readFileSync("src/modules/menu.ts", "utf8");
  assert.match(
    menuSource,
    /icon:\s*menuIcon/,
    "MenuManager entries should use the plugin icon",
  );
  assert.match(
    menuSource,
    /runMetadataAction\(win,\s*action\.schema/,
    "menu commands should pass an explicit action schema to getMeta",
  );
  assert.match(
    menuSource,
    /items:\s*items\s*\?\?\s*getSelectedItems\(win\)/,
    "fallback menu commands should use the current Zotero selection",
  );
  assert.match(
    menuSource,
    /setAttribute\("image",\s*menuIcon\)/,
    "fallback XUL entries should display the plugin icon",
  );

  for (const locale of ["en-US", "zh-CN"]) {
    const ftl = readFileSync(`addon/locale/${locale}/addon.ftl`, "utf8");
    for (const action of actions) {
      assert.match(
        ftl,
        new RegExp(`^${action.labelKey}\\s*=`, "m"),
        `${action.labelKey} should exist in ${locale} addon.ftl`,
      );
    }
  }
}

function assertPreferenceWindowLocalization() {
  const preferencesXhtml = readFileSync(
    "addon/content/preferences.xhtml",
    "utf8",
  );
  const preferenceMessages = [
    "pref-select",
    "pref-confirmBeforeUpdate",
    "pref-attachmentStrategy",
    "pref-saveNotes",
    "pref-about",
    "pref-help",
  ];

  for (const message of preferenceMessages) {
    assert.match(
      preferencesXhtml,
      new RegExp(`data-l10n-id="${message}"`),
      `${message} should be used by the preference window`,
    );
  }

  assert.doesNotMatch(
    preferencesXhtml,
    /pref-saveAttachments|__addonRef__-saveAttachments/,
    "legacy saveAttachments should not remain as a visible preference control",
  );

  for (const message of ["pref-confirmBeforeUpdate", "pref-saveNotes"]) {
    assert.match(
      preferencesXhtml,
      new RegExp(
        `<checkbox[\\s\\S]*data-l10n-id="${message}"[\\s\\S]*data-l10n-attrs="label"[\\s\\S]*native="true"`,
      ),
      `${message} checkbox should localize its visible label`,
    );
  }

  for (const message of ["pref-select", "pref-attachmentStrategy"]) {
    assert.match(
      preferencesXhtml,
      new RegExp(
        `<label[\\s\\S]*data-l10n-id="${message}"[\\s\\S]*data-l10n-attrs="value"`,
      ),
      `${message} label should localize its visible value`,
    );
  }

  assert.match(
    preferencesXhtml.trim(),
    /<\/groupbox>\s*<\/vbox>$/,
    "the About group should stay inside the preference pane root",
  );

  for (const locale of ["en-US", "zh-CN"]) {
    const ftl = readFileSync(`addon/locale/${locale}/preferences.ftl`, "utf8");
    assert.doesNotMatch(
      ftl,
      /^pref-saveAttachments\s*=/m,
      `legacy saveAttachments label should not remain in ${locale} preferences.ftl`,
    );
    for (const message of preferenceMessages) {
      assert.match(
        ftl,
        new RegExp(`^${message}\\s*=`, "m"),
        `${message} should exist in ${locale} preferences.ftl`,
      );
    }
  }
}

function assertPreferenceCheckboxBindings() {
  const preferenceWindowSource = readFileSync(
    "src/modules/preferenceWindow.ts",
    "utf8",
  );
  const metadataSource = readFileSync("src/modules/metadata.ts", "utf8");
  const attachmentPreferencesSource = readFileSync(
    "src/modules/attachmentPreferences.ts",
    "utf8",
  );

  assert.doesNotMatch(
    preferenceWindowSource,
    /bindPrefCheckbox\(doc, "saveAttachments"\)/,
    "legacy saveAttachments should not be bound as a duplicate checkbox",
  );
  assert.doesNotMatch(
    preferenceWindowSource,
    /function\s+(getVisibleAttachmentSaveStrategy|isAttachmentSaveStrategy)\b/,
    "attachment strategy normalization should be centralized outside the preference window",
  );
  assert.doesNotMatch(
    metadataSource,
    /function\s+isAttachmentSaveStrategy\b/,
    "metadata should use the centralized attachment preference helper",
  );

  for (const prefKey of ["confirmBeforeUpdate", "saveNotes"]) {
    assert.match(
      preferenceWindowSource,
      new RegExp(`bindPrefCheckbox\\(doc, "${prefKey}"\\)`),
      `${prefKey} should explicitly bind its checkbox to Zotero prefs`,
    );
  }

  assert.match(
    preferenceWindowSource,
    /setPref\(prefKey, checkbox\.checked === true\)/,
    "checkbox changes should be persisted to Zotero prefs",
  );
  assert.match(
    attachmentPreferencesSource,
    /setPref\("saveAttachments", strategy !== "none"\)/,
    "attachment strategy changes should mirror the legacy pref for compatibility",
  );
  assert.match(
    preferenceWindowSource,
    /setConfiguredAttachmentSaveStrategy\(\s*target\.value,?\s*\)/,
    "preference window should persist attachment strategy through the shared helper",
  );
  assert.match(
    metadataSource,
    /from "\.\/attachmentPreferences"/,
    "metadata should read attachment strategy through the shared helper",
  );
}

function createMockDocument({ title, selectors }) {
  return {
    title,
    querySelector(selector) {
      const value = selectors[selector];
      return Array.isArray(value) ? value[0] || null : value || null;
    },
    querySelectorAll(selector) {
      const value = selectors[selector];
      if (!value) {
        return [];
      }
      return Array.isArray(value) ? value : [value];
    },
  };
}

function createMockItem({ itemTypeID, fields, tags, attachments = [] }) {
  return {
    id: 100,
    libraryID: 1,
    itemTypeID,
    fields: { ...fields },
    tags: [...tags],
    attachments: [...attachments],
    saveCount: 0,
    getField(field) {
      return this.fields[field] || "";
    },
    setField(field, value) {
      this.fields[field] = value;
    },
    setType(typeID) {
      this.itemTypeID = typeID;
    },
    setCreators(creators) {
      this.creators = creators;
    },
    getTags() {
      return [...this.tags];
    },
    setTags(tags) {
      this.tags = tags;
    },
    getAttachments() {
      return [...this.attachments];
    },
    getNotes() {
      return [];
    },
    async saveTx() {
      this.saveCount += 1;
    },
  };
}
