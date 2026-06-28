import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const dryRun = process.env.ZOTERO_START_POLICY_DRY_RUN === "1";
const runningOverride = process.env.ZOTERO_START_POLICY_RUNNING;

const isRunning =
  runningOverride === "1" || (runningOverride !== "0" && detectZoteroRunning());

if (isRunning) {
  console.log(
    "Zotero is already running; leaving it untouched. The scaffold hot reload watcher should handle source changes.",
  );
  process.exit(0);
}

const command = path.resolve("node_modules/.bin/zotero-plugin");
const args = ["serve"];

if (dryRun) {
  console.log(
    `Zotero is not running; would start: ${command} ${args.join(" ")}`,
  );
  process.exit(0);
}

const child = spawn(command, args, {
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("exit", (code, signal) => {
  if (typeof code === "number") {
    process.exit(code);
  }
  console.error(
    `zotero-plugin serve exited from signal ${signal ?? "unknown"}`,
  );
  process.exit(1);
});

child.on("error", (err) => {
  console.error(`Unable to start zotero-plugin serve: ${err.message}`);
  process.exit(1);
});

function detectZoteroRunning() {
  if (process.platform === "win32") {
    const result = spawnSync("tasklist", ["/FI", "IMAGENAME eq Zotero.exe"], {
      encoding: "utf8",
    });
    return result.status === 0 && /\bZotero\.exe\b/i.test(result.stdout);
  }

  const exact = spawnSync("pgrep", ["-x", "Zotero"], {
    encoding: "utf8",
  });
  if (exact.status === 0) {
    return true;
  }

  const pathMatch = spawnSync("pgrep", ["-f", "Zotero\\.app"], {
    encoding: "utf8",
  });
  return pathMatch.status === 0;
}
