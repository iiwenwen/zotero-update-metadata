/* global Zotero, assert, window */

import {
  buildMetadataTranslationSettings,
  revealSavedMetadataItem,
  saveNewMetadataItem,
} from "../src/modules/metadata";

describe("metadata save-new runtime", function () {
  this.timeout(30000);

  const createdItemIDs = [];

  afterEach(async function () {
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
