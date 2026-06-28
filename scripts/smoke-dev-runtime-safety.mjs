import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import {
  detectZoteroRunning,
  isZoteroMainProcessCommand,
} from "./zotero-process-detection.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJsonPath = path.join(repoRoot, "package.json");
const scaffoldConfigPath = path.join(repoRoot, "zotero-plugin.config.ts");
const scriptsDir = path.join(repoRoot, "scripts");
const runtimeGuardPath = path.join(
  repoRoot,
  ".codex",
  "hooks",
  "zotero-runtime-guard.mjs",
);
const thisScript = path.basename(fileURLToPath(import.meta.url));

const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const packageScripts = pkg.scripts ?? {};

const legacyUnsafeScriptNames = new Set([
  "debug-url.mjs",
  "reload.mjs",
  "server.mjs",
  "start.mjs",
  "stop.mjs",
]);

const forbiddenPackageScriptNames = [
  /^debug(?::|$)/,
  /^devtools(?::|$)/,
  /^reload(?::|$)/,
  /^stop$/,
];

const forbiddenExecutableTokens = [
  "zotero://",
  "ztoolkit-debug",
  "addon.reload",
  "runDebugURL",
  "openDevTool",
  "open-devtools",
  "/Applications/Zotero.app",
  "open -a Zotero",
  "zotero-cmd.json",
];

const forbiddenCommandPatterns = [
  /\s-url(?:\s|=|$)/,
  /["'`]--?url["'`]/,
  /["'`]-url["'`]/,
];

const allowedExecutableTokensByLabel = {
  "scripts/run-zotero-ui-smoke.mjs": new Set(["zotero-cmd.json"]),
};

assert.equal(
  packageScripts.start,
  "node scripts/start-dev-if-needed.mjs",
  "npm run start must check Zotero once before delegating to scaffold serve",
);
assert.equal(
  packageScripts.dev,
  "npm run start",
  "npm run dev must reuse the guarded start entry",
);

const guardedStartScript = readFileSync(
  path.join(scriptsDir, "start-dev-if-needed.mjs"),
  "utf8",
);
assert.match(
  guardedStartScript,
  /ZOTERO_START_POLICY_RUNNING/,
  "guarded start script should expose a smoke-testable running override",
);
assert.match(
  guardedStartScript,
  /zotero-plugin[\s\S]*serve/,
  "guarded start script should delegate startup to scaffold serve only when needed",
);

assert.equal(
  isZoteroMainProcessCommand(
    "/Applications/Zotero.app/Contents/PlugIns/ZoteroSafariExtension.appex/Contents/MacOS/ZoteroSafariExtension",
  ),
  false,
  "Zotero Safari Extension must not be treated as the Zotero main process",
);
assert.equal(
  isZoteroMainProcessCommand(
    "/Applications/Zotero.app/Contents/MacOS/zotero --purgecaches no-remote -profile /tmp/profile",
  ),
  true,
  "the macOS Zotero app bundle main executable should be treated as running Zotero",
);

const probedCommands = [];
assert.equal(
  detectZoteroRunning({
    platform: "darwin",
    runCommand(command, args) {
      probedCommands.push([command, ...args]);
      return { status: 1, stdout: "" };
    },
  }),
  false,
  "Zotero should be considered stopped when only broad app-bundle matches would exist",
);
assert.deepEqual(
  probedCommands,
  [
    ["pgrep", "-x", "Zotero"],
    ["pgrep", "-x", "zotero"],
    ["pgrep", "-f", "Zotero\\.app/Contents/MacOS/zotero(\\s|$)"],
  ],
  "Zotero detection must use exact process names and the app bundle main executable, not a broad Zotero.app match",
);

const devGuardResult = spawnSync(process.execPath, [runtimeGuardPath], {
  input: JSON.stringify({ tool_input: { cmd: "npm run dev" } }),
  encoding: "utf8",
});
assert.equal(
  devGuardResult.status,
  0,
  ".codex runtime guard should accept npm run dev for contextual guidance",
);
assert.match(
  devGuardResult.stdout,
  /already running[\s\S]*hot reload/,
  ".codex runtime guard should remind that npm run dev leaves running Zotero untouched",
);

for (const scriptName of Object.keys(packageScripts)) {
  assert.equal(
    forbiddenPackageScriptNames.some((pattern) => pattern.test(scriptName)),
    false,
    `package.json must not expose standalone unsafe script "${scriptName}"`,
  );
}

for (const [scriptName, command] of Object.entries(packageScripts)) {
  assertSafeText(`package.json scripts.${scriptName}`, command);
}

assertSafeText(
  "zotero-plugin.config.ts",
  readFileSync(scaffoldConfigPath, "utf8"),
);

for (const fileName of readdirSync(scriptsDir)) {
  const filePath = path.join(scriptsDir, fileName);
  if (!statSync(filePath).isFile() || fileName === thisScript) {
    continue;
  }

  assert.equal(
    legacyUnsafeScriptNames.has(fileName),
    false,
    `legacy unsafe Zotero helper must not be restored: scripts/${fileName}`,
  );

  if (fileName.endsWith(".mjs") || fileName.endsWith(".js")) {
    assertSafeText(`scripts/${fileName}`, readFileSync(filePath, "utf8"));
  }
}

console.log("dev runtime safety smoke: pass");

function assertSafeText(label, text) {
  const allowedTokens = allowedExecutableTokensByLabel[label] ?? new Set();
  for (const token of forbiddenExecutableTokens) {
    if (allowedTokens.has(token)) {
      continue;
    }

    assert.equal(
      text.includes(token),
      false,
      `${label} must not contain unsafe Zotero debug token: ${token}`,
    );
  }

  for (const pattern of forbiddenCommandPatterns) {
    assert.equal(
      pattern.test(text),
      false,
      `${label} must not contain unsafe Zotero URL command pattern: ${pattern}`,
    );
  }
}
