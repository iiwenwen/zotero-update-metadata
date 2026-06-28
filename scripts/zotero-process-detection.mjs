import { spawnSync } from "node:child_process";
import process from "node:process";

const MACOS_BUNDLE_MAIN_EXECUTABLE =
  /(?:^|\s)\S*Zotero\.app\/Contents\/MacOS\/zotero(?:\s|$)/i;

export function detectZoteroRunning({
  platform = process.platform,
  runCommand = spawnSync,
} = {}) {
  if (platform === "win32") {
    const result = runCommand("tasklist", ["/FI", "IMAGENAME eq Zotero.exe"], {
      encoding: "utf8",
    });
    return result.status === 0 && /\bZotero\.exe\b/i.test(result.stdout);
  }

  for (const processName of ["Zotero", "zotero"]) {
    const exact = runCommand("pgrep", ["-x", processName], {
      encoding: "utf8",
    });
    if (exact.status === 0) {
      return true;
    }
  }

  const macOSBundle = runCommand(
    "pgrep",
    ["-f", "Zotero\\.app/Contents/MacOS/zotero(\\s|$)"],
    {
      encoding: "utf8",
    },
  );
  return macOSBundle.status === 0;
}

export function isZoteroMainProcessCommand(command) {
  return MACOS_BUNDLE_MAIN_EXECUTABLE.test(command);
}
