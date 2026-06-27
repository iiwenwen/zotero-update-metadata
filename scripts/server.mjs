import { main as build, esbuildOptions } from "./build.mjs";
import { openDevToolScript, reloadScript } from "./scripts.mjs";
import { runDebugURL } from "./debug-url.mjs";
import { main as startZotero } from "./start.mjs";
import { Logger } from "./utils.mjs";
import { execSync } from "child_process";
import chokidar from "chokidar";
import { createRequire } from "node:module";
import { context } from "esbuild";
import { exit } from "process";

process.env.NODE_ENV = "development";

const require = createRequire(import.meta.url);
const cmd = require("./zotero-cmd.json");
const { zoteroBinPath } = cmd.exec;

async function watch() {
  const watcher = chokidar.watch(["src/**", "addon/**"], {
    ignored: /(^|[\/\\])\../, // ignore dotfiles
    persistent: true,
  });

  let esbuildCTX = await context(esbuildOptions);

  watcher
    .on("ready", () => {
      Logger.info("Server Ready! \n");
    })
    .on("change", async (path) => {
      Logger.info(`${path} changed.`);
      if (path.startsWith("src")) {
        await esbuildCTX.rebuild();
      } else if (path.startsWith("addon")) {
        await build()
          // Do not abort the watcher when errors occur in builds triggered by the watcher.
          .catch((err) => {
            Logger.error(err);
          });
      }
      // reload
      reload();
    })
    .on("error", (err) => {
      Logger.error("Server start failed!", err);
    });
}

function reload() {
  Logger.debug("Reloading...");
  runDebugURL(zoteroBinPath, reloadScript);
}

function openDevTool() {
  Logger.debug("Open dev tools...");
  runDebugURL(zoteroBinPath, openDevToolScript);
}

async function main() {
  // build
  await build();

  // start Zotero
  startZotero(openDevTool);

  // watch
  await watch();
}

main().catch((err) => {
  Logger.error(err);
  // execSync("node scripts/stop.mjs");
  exit(1);
});

process.on("SIGINT", (code) => {
  execSync("node scripts/stop.mjs");
  Logger.info(`Server terminated with signal ${code}.`);
  exit(0);
});
