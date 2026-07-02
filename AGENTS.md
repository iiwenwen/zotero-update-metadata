# AGENTS.md

Repository entry point for Codex agents working on this Zotero desktop plugin.
Keep this file short and durable. Put detailed execution logic in ignored `.ai/**`,
domain policy in `.42cog/**`, and reusable review depth in `.codex/skills/**`.

## 1. Mission

Make the smallest correct change, preserve existing behavior, keep every step
recoverable, and finish only with concrete verification.

This project writes to Zotero user-library data. Treat that data as high value.
Never touch a real user Zotero profile or library unless the user explicitly
asks and confirms the risk.

## 2. Classify The Request

Classify before acting:

- `repo-change`: code, tests, product docs, build/config/release, or collaborator-visible artifacts. Create or bind a CNB Issue first.
- `versioned-governance-change`: tracked governance assets such as `AGENTS.md`, tracked `.codex/skills/**`, or `.42cog/spec/**` when explicitly in scope. Do not create a CNB Issue by default.
- `local-agent-maintenance`: ignored local control-plane state such as `.ai/**`, local prompts, local run records, queues, or ignored skill discovery links. Keep local-only; do not branch, commit, push, or open a CNB pull.
- `no-change review/advice`: audit, explanation, comparison, or recommendation only. Do not create Issues, commits, queue state, or fake checkpoints.

If one user report contains multiple independent user-visible problems, handle
one task at a time unless the same root cause, same files, same risk, and same
verification fully cover all symptoms.

## 3. Startup Context

For `repo-change`, `versioned-governance-change`, `local-agent-maintenance`,
watchdog, or queue work, read in order:

1. `AGENTS.md`
2. `.ai/WORKFLOW.md`, `.ai/STATE.md`, and `.ai/QUEUE.md` when present
3. The selected CNB Issue or local `.ai/tasks/<task-id>.md`, only after one task is selected

Do not scan the whole repository, `.ai/runs/**`, `.ai/archive/**`, or
`.ai/memory/**` at startup. Read historical local state only by explicit file
name when the current task needs it. `.ai/**` is local-only and must not be
staged.

For `no-change review/advice`, read only the requested context unless the user
asks for repository-state judgment.

## 4. Reality Sync

Before modifying tracked files, confirm:

- current branch and `git status`
- selected task source and scope
- in-scope files do not contain unrelated user changes
- local `.ai` state does not conflict with the real worktree
- allowed Files In Scope and Commit Scope
- relevant baseline failures, if any

If local state conflicts with the worktree, trust the worktree and update local
`.ai` state only when useful for recovery.

## 5. Planning And 42COG

Use the smallest planning level that fits the task.

- Simple, low-risk tasks may proceed after a minimal intent check.
- Ambiguous, medium-risk, user-data, runtime/UI, queue/watchdog, dependency, or release-related tasks need a short plan.
- Complex plans must record: `problem_exists`, `narrowed_scope`, `redefined_as`, `entity_count`, `old_behavior_risk`, `validation_first`, `certainty`, `risk`, and `intent_self_check`.
- Keep each task within four core entities. Split if it exceeds that.
- `LOW` certainty or `HIGH` risk means `NEED_HUMAN_DECISION`.

For non-trivial product, architecture, coding, QA, dependency, release, or domain
behavior changes, align with the minimum necessary 42COG files:

- `.42cog/meta/meta.md`
- `.42cog/real/real.md`
- `.42cog/cog/cog.md`
- directly relevant `.42cog/spec/**` or `spec/**`

Keep orchestration rules in `AGENTS.md` or ignored `.ai/WORKFLOW.md`; keep
domain rules, implementation recipes, test matrices, and product decisions in
the relevant 42COG/spec document.

## 6. Zotero Safety And Verification

Every task chooses and records one `verification_tier`:

- `docs_or_process`
- `pure_build_or_types`
- `pure_logic`
- `user_visible_plugin_behavior`
- `zotero_data_write_or_preferences`
- `release_or_dependency`

Use `.codex/skills/zotero-verification-ladder/SKILL.md` when choosing the tier
for Zotero code, UI/runtime behavior, preferences, metadata writes, build, or
release work.

Spec routing:

- Zotero data writes or preferences: `.42cog/spec/zotero-data-safety.md`
- Zotero runtime/UI commands: `.42cog/spec/runtime-command-policy.md`
- User-visible plugin behavior: `.42cog/spec/plugin-behavior-contracts.md`
- QA matrix and Test Ladder: `.42cog/spec/qa-zotero-verification.md`
- Dependency/release policy: `.42cog/spec/dependency-policy.md`

Code changes must prove function before UI. Start with static/unit or functional
smoke; use scaffold-managed Zotero runtime/UI only when lower tiers cannot prove
the behavior. Never use a real user Zotero profile/library for verification.

## 7. CNB And Git

CNB is the only collaboration and delivery platform for this project. GitHub is
only the mirror target configured by CNB and is not a Codex operation, review, or
delivery surface.

Tool boundary:

- Use `git` for local repository truth: worktrees, branches, diffs, staging, commits, fetch, pull, push, and commit graph.
- Use CNB HTTP API (`https://api.cnb.cool`) for platform truth: Issues, pulls, comments, reviews, status checks, conflicts, mergeability, merge gate, merge action, and Issue closure.
- When `git` and CNB API disagree, re-read both surfaces. Trust `git` for local repository state and CNB API for platform gate state; do not infer one from the other.

Default branch workflow:

- Do not do `repo-change` or `versioned-governance-change` work directly on `main`.
- Start each tracked task from an up-to-date `main`, then create a task branch with the `codex/` prefix unless the user requests another name.
- Commit, push to CNB, and open a CNB pull from the task branch.
- Do not merge by personal judgment or self-review alone. Merge only through the CNB merge gate: no conflicts or blocking feedback, and all configured required gates are satisfied.
- Explicit user confirmation is required for overriding the merge gate, direct commits to `main`, branch deletion, history rewriting, destructive cleanup, release/security/permission changes, or real Zotero profile/library access.

CNB Issue policy:

- Completed `repo-change`: keep the CNB Issue open until the CNB pull is merged, unless the user explicitly asks to close it earlier.
- Completed `versioned-governance-change`: do not create or close a CNB Issue unless the user explicitly requested remote Issue tracking.
- Completed `local-agent-maintenance`: do not create a CNB Issue, branch, commit, push, or pull.

## 8. Git Hygiene

- Never use `git add .` or `git add -A`.
- Stage only Commit Scope files.
- Never stage `.ai/**`, logs, caches, env files, secrets, local sessions, or unrelated ignored files.
- If an in-scope file mixes user changes with task changes, stop with `NEED_HUMAN_DECISION`.
- Run `git diff --cached --name-only` and `git diff --cached --check` before commit.
- Use Conventional Commits. Include task, scope, and verification evidence in the commit message.

For completed `repo-change` tasks, update useful ignored local state under
`.ai/**` for recovery, but do not stage it. For completed governance tasks, local
`.ai` task/run records are useful but still local-only.

## 9. Review

Before completion, review the actual diff, task goal, non-goals, verification
evidence, and staged files.

Use focused self-review for simple low-risk tasks. Use
`.codex/skills/zotero-review/SKILL.md` for:

- Zotero data writes or metadata fields
- attachments, notes, tags, Extra, translators, preferences
- UI/runtime behavior
- watchdog/queue/NEXT/PERSIST automation
- complex or high-risk code tasks
- CNB handoff, merge-gate, or Issue closure with behavior risk

P0/P1 findings always block completion. P2 blocks when it affects correctness,
data safety, regression, verification, git scope, release, or security.

## 10. Final Signal

Final output must start with exactly one signal:

```text
PASS
FAIL
BLOCKED
NEED_HUMAN_DECISION
HEARTBEAT_OK
```

`PASS` requires:

- task goal met and non-goals preserved
- necessary verification passed
- review has no unresolved blocking findings
- checkpoint commit completed when required
- CNB pull opened when branch workflow applies
- CNB Issue closure follows the Issue policy above

`PASS` format:

```text
PASS
Task: <source:id> <title>
Done:
- <actual change>
Verification:
- <command/check>: <result>
CNB Review: <clean | pending_merge_gate | ready_to_merge | fixed_blocking_feedback | not_applicable>
Commit: <hash or N/A — no repository changes>
Notes: <none or residual risk>
```

For branch workflow, `PASS` may include `State: CNB_REVIEW_OPEN`, meaning agent
work is complete and waiting for the CNB merge gate.
