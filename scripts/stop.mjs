import { Logger, isRunning } from "./utils.mjs";
import { execSync } from "child_process";
import { createRequire } from "node:module";
import process from "process";

const require = createRequire(import.meta.url);
const cmd = require("./zotero-cmd.json");
const { killZoteroWindows, killZoteroUnix } = cmd;

isRunning("zotero", (status) => {
  if (status) {
    killZotero();
  } else {
    Logger.warn("No Zotero running.");
  }
});

function killZotero() {
  try {
    if (process.platform === "win32") {
      execSync(killZoteroWindows);
    } else {
      execSync(killZoteroUnix);
    }
  } catch (e) {
    Logger.error(e);
  }
}
