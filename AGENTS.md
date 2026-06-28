# AGENTS.md

You are the autonomous coding agent for this repository.

Keep this file concise. It is the durable project entry point for Codex, not the full workflow manual. Detailed local workflow state lives in `.ai/WORKFLOW.md`; reusable review depth lives in `.codex/skills/zotero-review/SKILL.md`.

## 1. Mission

Do the smallest correct change, keep old behavior safe, make every step recoverable, and finish only when the result is verified.

This project is a Zotero desktop plugin. Treat Zotero user-library data as high value. Never touch a real user Zotero profile or library unless the user explicitly asks and confirms the risk.

## 2. Request Classification

Classify each user request first:

- `repo-change`: code, tests, product docs, build/config/release, or anything that creates a versioned project artifact. Must create or bind a CNB Issue before execution.
- `agent-process-maintenance`: changes only to agent behavior, such as `AGENTS.md`, `.ai/WORKFLOW.md`, `.ai/prompts/`, `.codex/skills/`, or prompt/workflow governance. Do not create a CNB Issue by default; use local task/run records and a controlled git checkpoint if versioned files change.
- `no-change review/advice`: audit, explanation, comparison, or recommendation only. Do not create Issues, queue state, commits, or fake checkpoints. Final output must say `Commit: N/A — no repository changes`.

If a user report contains multiple independent problems, split by user-visible behavior. Handle only one task at a time unless the same root cause, same files, same risk, and same verification fully cover all symptoms.

## 3. Required Startup Context

For `repo-change`, `agent-process-maintenance`, watchdog, or queue work, read in order:

1. `AGENTS.md`
2. `.ai/WORKFLOW.md`
3. `.ai/STATE.md`
4. `.ai/QUEUE.md`
5. Current CNB Issue or `.ai/tasks/<task-id>.md`, only after one task is selected

Do not scan the whole repository, `.ai/runs/`, or `.ai/memory/` at startup. Read those only when the current task needs them.

For `no-change review/advice`, read only the requested context unless the user explicitly asks for repository-state judgment.

## 4. Reality Sync

Before modifying files, confirm:

- current branch and `git status`
- current task source and scope
- in-scope files do not contain unrelated user changes
- previous `.ai/STATE.md` does not conflict with reality
- relevant baseline failures, if any
- allowed Files In Scope and Commit Scope

If local state conflicts with the real worktree, trust the worktree and update local `.ai` state.

## 5. Planning And 42COG

Use the smallest planning level that fits the task.

- Simple, low-risk tasks may execute after a minimal intent check.
- Complex, ambiguous, medium-risk, user-data, runtime, queue/watchdog, or release-related tasks need a plan.
- A complex plan must include meta-reflection: `problem_exists`, `narrowed_scope`, `redefined_as`, `entity_count`, `old_behavior_risk`, and `validation_first`.
- Keep each task within four core entities. Split if it exceeds that.
- Record `certainty`, `risk`, and `intent_self_check` before execution.
- `LOW` certainty or `HIGH` risk means `NEED_HUMAN_DECISION`.

High-risk operations always need explicit human confirmation: deleting many files, deleting user data, changing migrations, backup/restore formats, security boundaries, permissions, releases, merging to `main`, deleting branches, rewriting git history, overwriting user changes, or touching a real Zotero profile/library.

Every non-trivial task must align with 42COG/RCSW using the minimum necessary files:

- `.42cog/meta/meta.md`
- `.42cog/real/real.md`
- `.42cog/cog/cog.md`
- directly related `.42cog/spec/`, `spec/`, or `.42cog/work/` docs when the task touches product, design, architecture, coding, QA, dependency, release, or domain behavior

Record affected Cog entities by stable IDs when possible, for example `E1`, `E2`, `E3`.

Every new or updated `.42cog/spec/**` document must reference `.42cog/cog/cog.md` and name the related agents, entities, flows, and weights.

Keep the AI workflow responsible for orchestration only: task routing, planning gates, verification gates, review, persistence, and handoff. Do not encode full code-domain rules, implementation recipes, test matrices, or product decisions in `AGENTS.md` or `.ai/WORKFLOW.md`; put those in the relevant 42COG/spec document and reference them from the workflow.

## 6. Zotero Safety And Test Ladder

Code changes must prove function before UI. The detailed verification matrix lives in `.42cog/spec/qa-zotero-verification.md`; this file only keeps the hard trigger.

Every task must choose and record a `verification_tier`:

- `docs_or_process`
- `pure_build_or_types`
- `pure_logic`
- `user_visible_plugin_behavior`
- `zotero_data_write_or_preferences`
- `release_or_dependency`

Spec routing:

- Zotero data writes or preferences: `.42cog/spec/zotero-data-safety.md`
- Zotero runtime/UI commands: `.42cog/spec/runtime-command-policy.md`
- User-visible plugin behavior: `.42cog/spec/plugin-behavior-contracts.md`
- QA matrix and Test Ladder: `.42cog/spec/qa-zotero-verification.md`
- Dependency/release policy: `.42cog/spec/dependency-policy.md`

## 7. Review And Fix

Before `PASS`, review the actual diff, task goal, acceptance criteria, verification evidence, and staged files.

Use focused self-review for simple low-risk tasks. Use `.codex/skills/zotero-review/SKILL.md` for:

- Zotero data writes or metadata fields
- attachments, notes, tags, Extra, translators, preferences
- UI/runtime behavior
- watchdog/queue/NEXT/PERSIST automation
- complex or high-risk code tasks
- CNB handoff or Issue closure with behavior risk

P0/P1 findings always block completion. P2 blocks only when it affects correctness, data safety, regression, verification, git scope, release, or security. Fix blocking findings in rounds, then rerun relevant verification and review.

After a CNB pull is open, CNB review feedback, comments, status checks, and conflict state are part of the autonomous loop. Blocking CNB feedback returns the task to the same branch for a fix round; non-blocking suggestions are recorded without merging.

## 8. Git And Persistence

Default branch workflow:

- Do not do task work directly on `main`.
- Start each `repo-change` or versioned `agent-process-maintenance` task from an up-to-date `main`, then create a task branch with the `codex/` prefix unless the user requests another name.
- Commit, push to CNB, and open a CNB pull from the task branch.
- Do not merge the CNB pull yourself unless the user explicitly asks and confirms.
- Emergency direct commits to `main` require explicit user confirmation and must be recorded in the run notes.

For completed `repo-change` tasks:

- update `.ai/STATE.md`, `.ai/QUEUE.md`, `.ai/runs/`, and useful `.ai/memory/`
- create one controlled git checkpoint commit
- create a CNB pull after verification, review, and checkpoint pass
- close the CNB Issue only after the CNB pull is merged or the user explicitly asks to close it

For versioned `agent-process-maintenance` changes:

- update local `.ai` task/run records
- create a controlled git checkpoint commit
- create a CNB pull after verification, review, and checkpoint pass
- do not create or close a CNB Issue unless the user explicitly requested remote tracking

Git rules:

- never use `git add .` or `git add -A`
- stage only Commit Scope files
- `.ai/STATE.md`, `.ai/QUEUE.md`, `.ai/runs/`, and `.ai/memory/` are `.ai local runtime state`: update them when needed, but do not stage them
- versioned process/spec assets may include `AGENTS.md`, `.ai/WORKFLOW.md`, `.ai/prompts/**`, `.codex/skills/**`, and `.42cog/spec/**` when explicitly in scope
- do not stage logs, caches, env files, secrets, local sessions, or unrelated ignored files
- run `git diff --cached --name-only` and `git diff --cached --check` before commit
- if in-scope files mix user changes with task changes, stop with `NEED_HUMAN_DECISION`

Commit messages use Conventional Commits and include task, changes, and verification.

## 9. Completion And Final Signal

Final output must start with exactly one signal:

```text
PASS
FAIL
BLOCKED
NEED_HUMAN_DECISION
HEARTBEAT_OK
```

`PASS` requires:

- task goal met
- non-goals preserved
- acceptance criteria met
- necessary tests or equivalent verification passed
- review has no unresolved blocking findings
- checkpoint commit completed when required
- CNB pull opened when branch workflow applies
- CNB Issue closed only when the CNB pull is merged, direct-main flow applies, or the user explicitly requested closure

`PASS` format:

```text
PASS
Task: <source:id> <title>
Done:
- <actual change>
Verification:
- <command/check>: <result>
CNB Review: <clean | pending_human_merge | fixed_blocking_feedback | not_applicable>
Commit: <hash or N/A — no repository changes>
Notes: <none or residual risk>
```

For branch workflow, `PASS` may include `State: CNB_REVIEW_OPEN`, meaning Agent work is complete and waiting for CNB review/merge; the Issue can remain open until merge.

Do not say “basically done”, “should work”, or “probably fine” as completion.

## 10. Where Detail Belongs

Keep `AGENTS.md` short and practical. Add durable detail elsewhere:

- `.ai/WORKFLOW.md`: local detailed execution flow and watchdog behavior
- `.codex/skills/zotero-review/SKILL.md`: reusable adversarial review
- `.ai/tasks/` and `.ai/runs/`: local task/run records
- `.ai/memory/`: reusable local lessons
- `.42cog/`: Real/Cog/RCSW project model
- `.42cog/spec/` and `spec/`: product, design, architecture, coding, QA, dependency, release, and domain specifications

When this file grows because of repeated edge cases, extract the edge-case procedure into a skill, local workflow doc, task-specific reference, or a 42COG/spec document, then leave only the trigger and hard constraint here.
