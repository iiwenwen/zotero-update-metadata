import { buildOpenURLCommand, runDebugURL } from "./debug-url.mjs";
import { openDevToolScript, reloadScript } from "./scripts.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const cmd = require("./zotero-cmd.json");
const { zoteroBinPath } = cmd.exec;
const args = new Set(process.argv.slice(2));
const script = args.has("--open-devtools") ? openDevToolScript : reloadScript;

if (args.has("--print")) {
  console.log(buildOpenURLCommand(zoteroBinPath, script));
} else {
  runDebugURL(zoteroBinPath, script);
}
