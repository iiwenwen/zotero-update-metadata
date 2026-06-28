---
name: zotero-review
description: "Run adversarial multi-perspective self-review for this Zotero metadata plugin and its autonomous-agent workflow. Use before PASS, PR handoff, CNB Issue closure, or risky commits involving Zotero data writes, metadata fields, attachments, notes, tags, Extra, translators, watchdog/queue/NEXT behavior, automation smoke tests, or Git scope."
---

# Zotero Review

Use this skill to find bugs that a single reread would miss. Run independent reviewer passes, then merge the findings without letting one perspective explain away another.

## Review Contract

Review the actual diff, task goal, acceptance criteria, verification evidence, staged files, and relevant workflow state. Do not mark a task complete while P0/P1/P2 findings remain open.

Required perspectives:

1. Redundancy Reviewer: find duplicated rules, overlapping workflow paths, dead text, stale state, repeated prompts, and unnecessary abstractions.
2. Concurrency And Boundary Reviewer: inspect watchdog locks, NEXT re-entry, queue ordering, retry budgets, idempotency, partial writes, timeouts, and entity-count limits.
3. Zotero Data Safety Reviewer: protect real user libraries. Check item fields, attachments, notes, tags, Extra, URL/source updates, translator behavior, backups, isolated profiles, fixtures, and rollback paths.
4. Regression Reviewer: check old commands, menus, preferences, build scripts, hot reload, CNB handoff, tests, and prior documented workflow guarantees.
5. Verification And Git Scope Reviewer: check smoke/E2E evidence, `FIX_ROUND_PASS/FAIL`, staged files, secrets, cache, local `.ai` state, `.codex` scope exceptions, and commit-message evidence.

## Severity

- P0: data loss, security exposure, real Zotero library mutation, broken core workflow, irreversible state damage.
- P1: important user flow failure, old behavior regression, missing required automation smoke test, wrong Issue closure, unsafe queue/watchdog behavior.
- P2: reproducible edge-case risk, incomplete verification, ambiguous fallback, maintainability risk likely to cause future errors.
- P3: improvement that does not block completion.

Only list P0/P1/P2 when there is a concrete reproduction path, violated rule, or missing evidence that blocks completion.

## Output Format

For each perspective, output:

```md
## <Perspective Name>

### P<level>: <title>
File / Rule:
<path, method, or workflow rule>

Evidence:
<diff, command, staged file, log, or missing proof>

Why this matters:
<risk>

Minimal fix:
<smallest acceptable change>

Required verification:
<command, smoke test, structured check, or review evidence>
```

If a perspective finds no blocking issue, write:

```text
<Perspective Name>: no P0/P1/P2 findings
```

End with exactly one signal:

```text
PASS
```

or:

```text
FAIL
```

or:

```text
NEED_HUMAN_DECISION: <reason>
```

PASS is allowed only when all five perspectives have no P0/P1/P2 findings and the verification/Git-scope evidence is sufficient for the task type.
