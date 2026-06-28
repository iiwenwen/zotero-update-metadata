import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const logDir = path.resolve("logs");
const logPath = path.join(logDir, "zotero-ui-smoke.log");
const scaffoldConfigPath = path.resolve("scripts/zotero-cmd.json");
const requiredLogMarkers = [
  "metadata-runtime-translation-settings",
  "metadata-runtime-save-new",
  "savedItemID",
  "attachmentCount",
  "revealResult",
  "Test run completed",
];

mkdirSync(logDir, { recursive: true });
writeFileSync(logPath, "");

const env = {
  ...process.env,
  ZOTERO_PLUGIN_ZOTERO_BIN_PATH:
    process.env.ZOTERO_PLUGIN_ZOTERO_BIN_PATH || readZoteroBinaryPath(),
};

if (!env.ZOTERO_PLUGIN_ZOTERO_BIN_PATH) {
  throw new Error(
    "ZOTERO_PLUGIN_ZOTERO_BIN_PATH is required for Zotero UI smoke tests",
  );
}

const command = path.resolve("node_modules/.bin/zotero-plugin");
const args = ["test", "--exit-on-finish", "--abort-on-fail"];
const { code, output } = await run(command, args, env);

writeFileSync(logPath, output);

if (code !== 0) {
  throw new Error(
    `Zotero UI smoke failed with exit code ${code}. See ${logPath}`,
  );
}

const log = readFileSync(logPath, "utf8");
const missingMarkers = requiredLogMarkers.filter(
  (marker) => !log.includes(marker),
);
if (missingMarkers.length) {
  throw new Error(
    `Zotero UI smoke log is missing markers: ${missingMarkers.join(", ")}`,
  );
}

console.log(`zotero ui smoke: pass (${logPath})`);

function readZoteroBinaryPath() {
  try {
    const config = JSON.parse(readFileSync(scaffoldConfigPath, "utf8"));
    return config?.exec?.zoteroBinPath || "";
  } catch {
    return "";
  }
}

function run(commandPath, args, childEnv) {
  return new Promise((resolve) => {
    const child = spawn(commandPath, args, {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      process.stderr.write(text);
    });

    child.on("close", (code) => resolve({ code, output }));
  });
}
