#!/usr/bin/env node

let payload = {};

try {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks).toString("utf8").trim();
  payload = input ? JSON.parse(input) : {};
} catch {
  process.exit(0);
}

const toolInput = payload.tool_input ?? {};
const command =
  typeof toolInput.command === "string"
    ? toolInput.command
    : typeof toolInput.cmd === "string"
      ? toolInput.cmd
      : "";

if (!command) {
  process.exit(0);
}

const commandSurface = stripNonShellHereDocs(command).replace(/\s+/g, " ").trim();
const lower = commandSurface.toLowerCase();

const denyRules = [
  {
    pattern: /\/Applications\/Zotero\.app\/Contents\/MacOS\/zotero/i,
    reason:
      "Direct Zotero binary launch is blocked. Use the project verification ladder and scaffold-managed npm scripts.",
  },
  {
    pattern: /(^|[;&|]\s*)open\s+(-[^\s]+\s+)*-a\s+["']?zotero["']?(\s|$)/i,
    reason:
      "Direct `open -a Zotero` is blocked. Prove isolation and use an allowed project npm script.",
  },
  {
    pattern: /(^|[;&|]\s*)open\s+(-[^\s]+\s+)*(-b\s+org\.zotero\.zotero|\/Applications\/Zotero\.app)(\s|$)/i,
    reason:
      "Direct Zotero app launch is blocked. Prove isolation and use an allowed project npm script.",
  },
  {
    pattern: /(^|[;&|]\s*)osascript\b.*application\s+["']?zotero["']?/i,
    reason:
      "AppleScript Zotero activation is blocked. Do not control the user's Zotero instance directly.",
  },
  {
    pattern: /(^|[;&|]\s*)(env\s+|command\s+)?zotero(\s|$)/i,
    reason:
      "Bare `zotero` commands are blocked. Use the Zotero verification ladder before any runtime check.",
  },
  {
    pattern: /zotero:\/\//i,
    reason:
      "Raw Zotero URL commands are blocked. Do not bypass project-managed runtime scripts.",
  },
  {
    pattern: /ztoolkit-debug/i,
    reason:
      "Raw ztoolkit debug URLs are blocked. Use scaffold-managed verification instead.",
  },
  {
    pattern: /(^|[;&|]\s*)(npm|pnpm|yarn|bun)\s+(run\s+)?(reload|reload:print|stop)(\s|$)/i,
    reason:
      "Reload/stop runtime scripts are blocked by default to avoid repeatedly controlling the user's Zotero instance.",
  },
  {
    pattern: /(^|[;&|]\s*)node\s+scripts\/(reload|debug-url|stop)\.mjs(\s|$)/i,
    reason:
      "Direct Zotero runtime helper scripts are blocked. Use the verification ladder and allowed npm scripts.",
  },
  {
    pattern: /(^|\s)-url(\s|=|$)|["'`]--?url["'`]|["'`]-url["'`]/i,
    reason:
      "Raw Zotero URL launch arguments are blocked. Use project-managed verification scripts only.",
  },
];

for (const rule of denyRules) {
  if (rule.pattern.test(commandSurface)) {
    deny(rule.reason);
  }
}

const runtimeReminder =
  /(^|[;&|]\s*)(npm|pnpm|yarn|bun)\s+(run\s+)?(start|test|test:ui|smoke:ui)(\s|$)/i;

if (runtimeReminder.test(lower)) {
  allowWithContext(
    "Before running Zotero runtime/UI checks, record the verification tier, why lower tiers are insufficient, and isolation evidence for the test profile or scaffold runner.",
  );
}

function deny(reason) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

function allowWithContext(message) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: message,
      },
    }),
  );
  process.exit(0);
}

function stripNonShellHereDocs(shellCommand) {
  const lines = shellCommand.split(/\r?\n/);
  const kept = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    kept.push(line);

    const marker = line.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
    if (!marker) {
      continue;
    }

    if (/(^|[;&|]\s*)(ba)?sh\b|(^|[;&|]\s*)zsh\b/.test(line)) {
      kept.push(";");
      continue;
    }

    const delimiter = marker[1];
    while (index + 1 < lines.length && lines[index + 1].trim() !== delimiter) {
      index += 1;
    }
  }

  return kept.join("\n");
}
