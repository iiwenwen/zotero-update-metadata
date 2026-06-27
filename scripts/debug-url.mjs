import { execSync } from "child_process";

export function buildDebugURL(script) {
  return `zotero://ztoolkit-debug/?run=${encodeURIComponent(script)}`;
}

export function buildOpenURLCommand(zoteroBinPath, script) {
  return `"${zoteroBinPath}" -url "${buildDebugURL(script)}"`;
}

export function runDebugURL(zoteroBinPath, script) {
  execSync(buildOpenURLCommand(zoteroBinPath, script));
}
