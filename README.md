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

## 42COG / Codex Workflow

This project is initialized for Codex with the 42COG RCSW workflow:

```text
Init -> Real -> Cog -> Product Requirements -> User Story -> UX/UI Design -> System Architecture -> Data / Domain -> Coding -> QA -> Work / Iteration
```

Key directories:

- `.42cog/`: project cognition, constraints, and iteration records
- `spec/`: product, design, and development specifications
- `src/`: Zotero plugin source code
- `.codex/`: Codex project skills and local agent notes

Project skills are exposed through relative symlinks from `.codex/skills/` to `.42plugin/42edu/`.

### Autonomous Agent Alignment

Autonomous Codex work must use the 42COG/RCSW method as part of the execution loop, not only as project background:

- Before planning a task, read the minimal 42COG context that applies to the change: `.42cog/meta/meta.md`, `.42cog/real/real.md`, `.42cog/cog/cog.md`, and only the relevant `spec/` or work documents.
- In each task context, name the affected 42COG entities, constraints, non-goals, acceptance criteria, risks, and verification path.
- During execution, keep changes scoped to the selected Issue and no more than four core entities; avoid broad scans of historical `.ai/`, `.42cog/`, or `.codex/` records unless the current task requires them.
- Before completion, verify that the change still satisfies the relevant Real constraints and Cog entity boundaries, then record the run and create a controlled checkpoint commit for tracked task files.

## ChangeLog

- 2024-04-09 Release 1.0.0 Initial version
