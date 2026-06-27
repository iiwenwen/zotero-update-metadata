import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";

const tmp = mkdtempSync(path.join(tmpdir(), "metadata-smoke-"));
const outfile = path.join(tmp, "metadata.cjs");
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

  const {
    applyMetadataUpdateWithConfirmation,
    applySafeMetadataUpdate,
    buildAttachmentImportOptions,
    buildMetadataUpdatePreview,
    buildFallbackDoubanItem,
    extractDoubanTitle,
    formatBatchUpdateSummary,
    formatMetadataUpdatePreview,
    getItemISBN,
    isNoTitleSpecifiedError,
    lowersDatePrecision,
    mergeExtra,
    normalizeAttachmentSaveStrategy,
    shouldTryAttachmentSave,
    translateWithMetadataProviders,
  } = require(outfile);

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
  assert.equal(lowersDatePrecision("2020-05-06", "2020"), true);
  assert.equal(lowersDatePrecision("2020", "2020-05-06"), false);
  assert.equal(
    mergeExtra("DOI: old-doi\nUser Note: keep me", "DOI: new-doi\nISBN: 978"),
    "DOI: old-doi\nUser Note: keep me\nISBN: 978",
  );

  globalThis.Zotero = {
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
  const confirmResult = await applyMetadataUpdateWithConfirmation(
    {
      title: "Norwegian Wood",
      publisher: "Vintage",
    },
    confirmItem,
    () => true,
  );

  assert.equal(confirmResult.confirmed, true);
  assert.equal(confirmItem.getField("publisher"), "Vintage");
  assert.equal(confirmItem.saveCount, 1);

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

  assert.equal(normalizeAttachmentSaveStrategy("always"), "always");
  assert.equal(normalizeAttachmentSaveStrategy("bad-value"), "none");

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
    shouldTryAttachmentSave(translatedWithAttachment, itemWithAttachments, "missing"),
    false,
  );
  assert.equal(
    shouldTryAttachmentSave(translatedWithAttachment, itemWithAttachments, "always"),
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
    buildAttachmentImportOptions(translatedWithAttachment, itemWithoutAttachments),
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

  console.log("metadata douban fallback smoke: pass");
} finally {
  rmSync(tmp, { recursive: true, force: true });
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
