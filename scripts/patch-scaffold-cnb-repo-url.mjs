import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const scaffoldSharedFile = fileURLToPath(
  new URL(
    "../node_modules/zotero-plugin-scaffold/dist/shared/scaffold-replace-BTU0g6CT.mjs",
    import.meta.url,
  ),
);

const strictPattern =
  "url.match(/:\\/\\/.+com\\/([^/]+)\\/([^.]+)\\.git$/);";
const cnbCompatiblePattern =
  "url.match(/:\\/\\/[^/]+\\/([^/]+)\\/([^.]+)\\.git$/);";

const source = readFileSync(scaffoldSharedFile, "utf8");

if (source.includes(cnbCompatiblePattern)) {
  process.exit(0);
}

if (!source.includes(strictPattern)) {
  throw new Error("Unable to find scaffold repository URL parser pattern.");
}

writeFileSync(
  scaffoldSharedFile,
  source.replace(strictPattern, cnbCompatiblePattern),
);
