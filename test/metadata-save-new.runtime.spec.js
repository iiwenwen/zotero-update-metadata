/* global Zotero, assert, window */

import {
  applyMetadataUpdateWithConfirmation,
  shouldConfirmBeforeMetadataUpdate,
  buildMetadataTranslationSettings,
  revealSavedMetadataItem,
  saveNewMetadataItem,
} from "../src/modules/metadata";
import { clearPref, setPref } from "../src/utils/prefs";

describe("metadata save-new runtime", function () {
  this.timeout(30000);

  const createdItemIDs = [];

  afterEach(async function () {
    clearPref("attachmentSaveStrategy");
    clearPref("confirmBeforeUpdate");
    clearPref("saveAttachments");
    clearPref("saveNotes");

    while (createdItemIDs.length) {
      const itemID = createdItemIDs.pop();
      try {
        const item = await Zotero.Items.getAsync(itemID);
        if (item) {
          await item.eraseTx({ skipDeleteLog: true });
        }
      } catch (err) {
        window.debug({
          marker: "metadata-runtime-cleanup-error",
          itemID,
          error: String(err),
        });
      }
    }
  });

  it("registers the metadata preview pane with Zotero item pane manager", function () {
    const customSections = Zotero.ItemPaneManager.customSectionData.options;
    const section = customSections.find(
      (option) =>
        option.pluginID === "zotero-update-metadata@iiwenwen" &&
        option.paneID.includes("updatemetadata-metadata-preview"),
    );

    assert.isOk(section, "metadata preview section should be registered");
    assert.equal(typeof section.onInit, "function");
    assert.equal(typeof section.onRender, "function");
    assert.equal(typeof section.onItemChange, "function");
    assert.equal(typeof section.onAsyncRender, "function");
    assert.include(
      section.bodyXHTML,
      "metadata-preview-pane",
      "registered section should provide preview pane body markup",
    );

    const item = new Zotero.Item("book");
    item.setField("title", "Runtime Preview Visibility");
    item.setField("url", "https://book.douban.com/subject/1355643/");

    const body = window.document.createElement("div");
    let enabled = null;
    let summary = null;
    const props = {
      body,
      item,
      tabType: "library",
      editable: true,
      setEnabled(value) {
        enabled = value;
        return value;
      },
      setSectionSummary(value) {
        summary = value;
        return value;
      },
      setL10nArgs() {},
      setSectionButtonStatus() {},
    };

    section.onInit({
      ...props,
      refresh() {
        return Promise.resolve();
      },
    });

    assert.isTrue(
      enabled,
      "metadata preview section should be visible immediately after init",
    );
    assert.isString(summary);
    assert.isAbove(summary.length, 0);

    enabled = null;
    summary = null;
    section.onRender(props);

    assert.isTrue(
      enabled,
      "metadata preview section should stay visible before update actions",
    );
    assert.isString(summary);
    assert.isAbove(summary.length, 0);

    enabled = null;
    summary = null;
    section.onItemChange(props);

    assert.isTrue(
      enabled,
      "metadata preview section should stay visible after item changes",
    );
    assert.isString(summary);
    assert.isAbove(summary.length, 0);
    assert.isNotNull(body.querySelector(".metadata-preview-overview"));

    window.debug({
      marker: "metadata-runtime-preview-pane-registered",
      paneID: section.paneID,
      hasOnRender: typeof section.onRender === "function",
      hasOnAsyncRender: typeof section.onAsyncRender === "function",
    });
    window.debug({
      marker: "metadata-runtime-preview-pane-visible",
      enabled,
      summary,
      hasOverview: Boolean(body.querySelector(".metadata-preview-overview")),
    });
  });

  it("does not write an existing item when update confirmation is canceled", async function () {
    let confirmCalls = 0;
    const libraryID = Zotero.Libraries.userLibraryID;
    const title = `Codex Runtime Confirm ${Date.now()}`;
    const item = new Zotero.Item("book");

    item.libraryID = libraryID;
    item.setField("title", title);
    item.setField("publisher", "Existing Publisher");
    await item.saveTx();
    createdItemIDs.push(item.id);

    setPref("confirmBeforeUpdate", "true");
    setPref("attachmentSaveStrategy", "none");
    setPref("saveAttachments", false);
    setPref("saveNotes", true);

    assert.isTrue(shouldConfirmBeforeMetadataUpdate());

    const canceled = await applyMetadataUpdateWithConfirmation(
      {
        itemType: "book",
        title,
        publisher: "Vintage",
        notes: ["<p>Supplemental note should not be saved.</p>"],
      },
      item,
      () => {
        confirmCalls += 1;
        return false;
      },
    );

    const savedAfterCancel = await Zotero.Items.getAsync(item.id, {
      noCache: true,
    });

    assert.equal(canceled.confirmed, false);
    assert.equal(canceled.status, "canceled");
    assert.equal(confirmCalls, 1);
    assert.equal(item.getField("publisher"), "Existing Publisher");
    assert.equal(savedAfterCancel.getField("publisher"), "Existing Publisher");
    assert.deepEqual(savedAfterCancel.getNotes(), []);
    assert.deepEqual(savedAfterCancel.getAttachments(), []);

    window.debug({
      marker: "metadata-runtime-confirm-canceled",
      itemID: item.id,
      confirmCalls,
      noteCount: savedAfterCancel.getNotes().length,
      attachmentCount: savedAfterCancel.getAttachments().length,
    });

    setPref("saveNotes", false);

    const applied = await applyMetadataUpdateWithConfirmation(
      {
        itemType: "book",
        title,
        publisher: "Vintage",
      },
      item,
      () => {
        confirmCalls += 1;
        return true;
      },
    );
    const savedAfterApply = await Zotero.Items.getAsync(item.id, {
      noCache: true,
    });

    assert.equal(applied.confirmed, true);
    assert.equal(applied.status, "applied");
    assert.equal(confirmCalls, 2);
    assert.equal(savedAfterApply.getField("publisher"), "Vintage");

    window.debug({
      marker: "metadata-runtime-confirm-applied",
      itemID: item.id,
      confirmCalls,
      publisher: savedAfterApply.getField("publisher"),
    });
  });

  it("uses non-saving provider settings before explicit save", function () {
    const settings = buildMetadataTranslationSettings({
      saveAttachments: true,
      libraryID: Zotero.Libraries.userLibraryID,
      collections: [99999],
    });

    assert.deepEqual(settings, {
      saveAttachments: false,
      libraryID: false,
    });

    window.debug({
      marker: "metadata-runtime-translation-settings",
      saveAttachments: settings.saveAttachments,
    });
  });

  it("persists a translated book as one new top-level item", async function () {
    const libraryID = Zotero.Libraries.userLibraryID;
    const title = `Codex Runtime Save New ${Date.now()}`;
    const beforeIDs = await Zotero.Items.getAll(libraryID, true, false, true);

    const result = await saveNewMetadataItem(
      {
        itemType: "book",
        title,
        creators: [
          {
            creatorType: "author",
            firstName: "Runtime",
            lastName: "Tester",
          },
        ],
        ISBN: "9780099448822",
        abstractNote: "Runtime save-new smoke item.",
        url: "https://book.douban.com/subject/1355643/",
        tags: [{ tag: "codex-runtime-smoke" }],
      },
      {
        saveAttachments: false,
        libraryID,
      },
    );

    createdItemIDs.push(result.item.id);

    const saved = await Zotero.Items.getAsync(result.item.id, {
      noCache: true,
    });
    const afterIDs = await Zotero.Items.getAll(libraryID, true, false, true);
    const revealResult = await revealSavedMetadataItem(
      saved,
      Zotero.getMainWindows()[0],
    );

    assert.isOk(result.item.id, "saved item should have an id");
    assert.equal(result.status, "saved");
    assert.isAbove(afterIDs.length, beforeIDs.length);
    assert.isTrue(saved.isTopLevelItem());
    assert.isTrue(saved.isRegularItem());
    assert.equal(saved.getField("title"), title);
    assert.equal(
      String(saved.getField("ISBN")).replace(/[^\dXx]/g, ""),
      "9780099448822",
    );
    assert.equal(
      saved.getField("url"),
      "https://book.douban.com/subject/1355643/",
    );
    assert.deepEqual(saved.getAttachments(), []);
    assert.isTrue(revealResult);

    window.debug({
      marker: "metadata-runtime-save-new",
      savedItemID: result.item.id,
      attachmentCount: saved.getAttachments().length,
      beforeTopLevelCount: beforeIDs.length,
      afterTopLevelCount: afterIDs.length,
      revealResult,
    });
  });
});
