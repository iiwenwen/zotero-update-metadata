# Zotero Update Metadata

[![zotero target version](https://img.shields.io/badge/Zotero-7--9-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)

[English](README.md) | [Chinese](doc/README-zhCN.md)

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

- This plugin is built using Zotero Plugin Template scaffolding.
- The core code is based on earlier Zotero update-metadata plugin work.
- Some implementation patterns reference existing Zotero metadata and translation plugins.

## Disclaimer

Use this code under the AGPL. No warranty is provided. Follow the laws in your region!

## Development

Copy `.env.example` to `.env` and point `ZOTERO_PLUGIN_PROFILE_PATH` and
`ZOTERO_PLUGIN_DATA_DIR` at an isolated development profile and data directory.

Run `npm start` or `npm run dev` once to enter the scaffold-managed hot reload
flow. The start script first checks whether Zotero is already running. If it is
running, the script leaves Zotero untouched and exits; if it is not running, the
script delegates to `zotero-plugin serve` to build the add-on, start the
configured development profile, and watch `src/` plus `addon/` changes. Keep the
scaffold process running for hot reload instead of restarting Zotero after each
change.

The old standalone reload shortcuts are no longer exposed because a bare
`zotero://ztoolkit-debug` URL can be handled by the wrong Zotero profile.

Use the workflow scripts as separate gates:

- `npm run format:check`: Prettier for plugin code, generated typings, and
  root project config.
- `npm run lint:check`: `format:check`, then ESLint for plugin code only
  (`src/`, `test/`, and `addon/`). Generated output, scaffold profiles, logs,
  and agent workflow files are not part of the default lint gate.
- `npm run build:xpi`: scaffold production XPI in `build/`.
- `npm run typecheck`: TypeScript checking without rebuilding the XPI.
- `npm run build`: `build:xpi`, then `typecheck`.
- `npm run test:unit`: Node smoke tests that do not start Zotero.
- `npm run test:ui`: Zotero runtime smoke tests in the scaffold test profile.
  Use this for UI, preference, and Zotero data-write behavior changes.
- `npm run check`: fast pre-PR gate, running lint, build, and unit smoke.
- `npm run verify`: full local gate, running `check` and the Zotero UI smoke.
- `npm run release`: version bump flow. The release hook runs `check` before
  bumping and rebuilds afterward so the XPI metadata uses the new version. This
  project publishes through CNB release flow, not GitHub release automation.
- `npm run release:dry-run`: preview the version bump flow without writing a
  release.

Maintainer-specific agent workflow instructions are kept out of this
user-facing README. See `AGENTS.md` for Codex and automation guidance.

## ChangeLog

- 2024-04-09 Release 1.0.0 Initial version
