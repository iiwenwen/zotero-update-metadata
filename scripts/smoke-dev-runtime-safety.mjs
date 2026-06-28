import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJsonPath = path.join(repoRoot, "package.json");
const scaffoldConfigPath = path.join(repoRoot, "zotero-plugin.config.ts");
const scriptsDir = path.join(repoRoot, "scripts");
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
  /^stop$/,
];
const allowedRuntimePackageScriptNames = [/^reload(?::|$)/];

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

assert.equal(
  packageScripts.start,
  "zotero-plugin serve",
  "npm run start must remain the scaffold-managed development entry",
);

for (const scriptName of Object.keys(packageScripts)) {
  assert.equal(
    forbiddenPackageScriptNames.some((pattern) => pattern.test(scriptName)),
    false,
    `package.json must not expose standalone unsafe script "${scriptName}"`,
  );
}

for (const [scriptName, command] of Object.entries(packageScripts)) {
  if (
    allowedRuntimePackageScriptNames.some((pattern) => pattern.test(scriptName))
  ) {
    continue;
  }
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
  for (const token of forbiddenExecutableTokens) {
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
