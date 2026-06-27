# Zotero Update Metadata

[![zotero target version](https://img.shields.io/badge/Zotero-7--9-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

[![English](https://img.shields.io/badge/英文-English-blue.svg)](https://github.com/iiwenwen/zotero-update-metadata/blob/main/README.md)
[![Chinese](https://img.shields.io/badge/中文-Chinese-blue.svg)](https://github.com/iiwenwen/zotero-update-metadata/blob/main/doc/README-zhCN.md)

This project allows you to update or save metadata for entries in Zotero directly from the URL field of the entry, without the need to save the metadata on the corresponding page.

## Features

- Update or save metadata from the URL field of an entry in Zotero.

## Usage

1. Select an item in Zotero.
2. Right-click the Update Metadata button.
3. Wait for the update or save of the entry.

## Note

- Currently only applicable to entries saved with Douban.
- Compatibility target: Zotero 7.0 through Zotero 9.0.*.

## TODO

- [ ] You can choose whether or not to save attachments when updating entries

## Acknowledgments

- This plugin is built using the [Zotero Plugin Template](https://github.com/windingwind/zotero-plugin-template).
- The core code of this plugin is based on the modification of [mrtcode/zotero at update-metadata](https://github.com/mrtcode/zotero/tree/update-metadata).
- Some parts of the code reference:
  + [northword/zotero-format-metadata](https://github.com/northword/zotero-format-metadata)
  + [windingwind/zotero-pdf-translate](https://github.com/windingwind/zotero-pdf-translate/tree/87299879409b8d74c45b7690e0227232de407c0a)

## Disclaimer

Use this code under the AGPL. No warranty is provided. Follow the laws in your region!

## Development

Run `npm run start` to build the add-on, start Zotero with the configured
development profile, and watch `src/` plus `addon/` changes. While Zotero is
already running, `npm run reload` sends only the ztoolkit debug reload URL to
the current Zotero process, so most source and locale edits do not need a full
Zotero restart.

Use `npm run reload:print` to inspect the reload command without launching
Zotero. A full restart is still recommended after changing `addon/manifest.json`,
bootstrap startup/shutdown behavior, dependency versions, or the configured
profile/data directory.

Maintainer-specific agent workflow instructions are kept out of this
user-facing README. See `AGENTS.md` for Codex and automation guidance.

## ChangeLog

- 2024-04-09 Release 1.0.0 Initial version
