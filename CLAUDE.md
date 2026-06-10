# upgrade-cycle — operator guide (for Claude)

This repo is a **single self-contained Claude Code Workflow** (`upgrade-cycle.mjs`) that drives a
prose goal — a migration, version upgrade, framework port, or large refactor — to a
production-ready, test-green state across one target git repo, mostly autonomously.

Your job when a user invokes this: help them write a correct `args` config, run the two phases,
**verify ground truth yourself**, and surface anything that needs their decision. Below is what is
NOT obvious from the prompts inside the engine.

## How the engine is structured (so you can adapt, not rewrite)

- The engine is **general**. Everything project/stack-specific comes from the `args` object the
  user passes to the `Workflow` tool. There is a hard config boundary at the top of
  `upgrade-cycle.mjs` (`const A = args`). Do not hardcode project specifics into the engine.
- It runs under the **Workflow tool runtime** — `agent()`, `parallel()`, `phase()`, `log()`,
  `args` are globals provided by the harness. It is NOT a standalone node program; you can't
  `node upgrade-cycle.mjs` it. To iterate on the engine, edit the `.mjs` and re-invoke `Workflow`.
- `meta` (top of file) must be a **pure literal** (no variables/among/calls). Top-level `return`
  and `await` are legal (the harness wraps the body in an async function).
- Syntax-check trick (since top-level return breaks `node --check`):
  `node -e "const s=require('fs').readFileSync('upgrade-cycle.mjs','utf8').replace('export const meta','const meta'); new Function('agent','parallel','pipeline','phase','log','args','budget','workflow','return (async()=>{'+s+'})()'); console.log('OK')"`

## The five roles (all generic, all in the engine)

Planner (decompose → plan each task → triage findings → **owns git staging**), Research
(ad-hoc, read-only), Developer (implements + tests, leaves work UNSTAGED), Reviewer (adversarial,
**diff-only**), Scribe (persists progress, rebuilds ledger). The conductor (JS) sequences them.

## The contracts that make it safe — keep them intact

- **Staging = the cycle boundary.** Staged index/HEAD = accepted baseline; the unstaged working
  tree = the current task's work (the reviewer's scope). The Developer never stages; the Planner
  stages on accept. **Nothing is ever committed — the user commits.** This is the regression guard.
- **Gates are the per-stack adapter.** `args.gates.build` and `args.gates.test` are literal shell
  commands the agents run. That's the ONLY thing that changes between a PHP app and a TS app.
  `build` (lint/compile) must ALWAYS pass; `test` is scoped per task.
- **Per-task `gate_expectation`**: `green` (build + this task's selector tests pass) | `red-baseline`
  (test-first: author tests that FAIL for the right reason; build green) | `build-only`. This lets
  the suite stay intentionally red mid-migration while each task is judged on its own selector.
- **Lean review policy** (deliberate, to save tokens): the reviewer looks only at the diff and
  flags only INTRODUCED, production-blocking defects + testing blockers. Easy obvious wins get
  fixed; mediums/lows/pre-existing are dropped (a SEPARATE code-review pass handles those). Do NOT
  lower `reviewSeverity` to surface more — that caused non-converging churn (700k tokens on one
  task) before it was fixed. Floors default to `high`.

## Running it — the playbook

1. **Write `args`.** The adaptation surface. Get these right:
   - `root`: **optional — auto-detected.** If omitted, the engine probes `pwd` once and uses that
     absolute path for everything (so it adapts to wherever it's launched). BEST PRACTICE: you know
     the tool's absolute path from the Workflow tool result (the `scriptPath` it echoes); pass that
     directory as `root` so run-state lands beside the tool (gitignored) instead of inside the
     target repo. Always forward-slashed.
   - `target.repo`: absolute path to the target **git** repo (or relative to `root`).
   - `goal`: one detailed paragraph — what, why, invariants to preserve, what "done" looks like.
   - `gates`: the build/test shell commands (+ `testSetup` notes: how to scope ONE test, runner
     quirks, run-as-user, container exec prefix, DB isolation).
   - `reference` (optional but powerful): a completed example to mirror — agents diff against it.
   - `seed` (optional): a first-cut task list to anchor decomposition. Prefer combining a feature's
     test + conversion into ONE test-first task to cut cycles.
   - `baselineNote`: describe expected pre-existing working-tree changes so they're folded into the
     baseline, not treated as task work.
2. **Phase `plan`.** Produces `runs/<runId>/tasks.json` + `TASKS.md`, then STOPS. Always hand the
   task plan to the user to approve/edit before running. The Planner often improves on the seed —
   read its `notes`.
3. **Phase `run`.** Use **`runOnly: [ids]`** to run a small first slice cheaply (e.g. the harness +
   first feature) before committing to the whole thing. Each task is ~250–350k tokens; right-size
   tasks (~1–6 files) and combine test+convert pairs.
4. **Verify ground truth YOURSELF — do not trust the ledger blindly.** Run the suite/selectors in
   the real environment, inspect the staged diff, confirm changes are additive and the legacy path
   is intact. The ledger reflects what the agents reported; you confirm reality.
5. **Resume** after any stop: re-invoke the same `args` (the loader skips done tasks via
   `runs/<runId>/progress/*.json`), or `resumeFromRunId` for same-session cache replay.

## Gotchas burned in from real runs

- **Verify what the test runner actually ran.** Some runners silently mislead — e.g. PHPUnit 4.x's
  CLI runs only the FIRST path argument and ignores the rest, so a multi-file selector gives a
  false green. Run one file per invocation, or use `--filter`. Always sanity-check the test count.
- **`git diff` omits brand-new files.** When verifying, also use `git status --porcelain` and read
  new files. (The engine handles this for the reviewer via `git add -N`; you must too.)
- **A gate-met task that ran out of rounds is still "done".** If you ever bless a task by hand
  (because its gate genuinely passed but bookkeeping failed), stage its files and write
  `runs/<runId>/progress/<id>.json` with `"status":"done"`, then resume.
- **Blocker halts are recovery loops, not failures.** Read `BLOCKERS.md`, fix the root cause
  (usually a bad gate command, a missing dependency between tasks, or a real design question for
  the user), then resume. A dependency is "satisfied" only when its predecessor reached a `done*`
  status (gate met).
- **Stray `runs/` or state in an unexpected place** = `root` auto-detected to a cwd you didn't
  expect (e.g. inside the target repo). Set `root` explicitly to the tool's directory, relocate the
  state, re-run.

## State files (under `runs/<runId>/`)

`tasks.json`/`TASKS.md` (the plan) · `progress/<id>.json` (drives resume) · `LEDGER.md` (status
table) · `NEEDS-DECISION.md` (flagged majors awaiting the user) · `BLOCKERS.md` (hard-stop reason)
· `CHANGELOG.md` (human summary) · `ADVISORY.md` (rare residual easy-wins). All gitignored.

## When you're done

Report: tasks done, suite result (run it), what's staged, anything in `NEEDS-DECISION.md`, and any
"reads-oddly-but-tests-pass" item worth the user's eye or the separate review pass. **Never commit**
— tell the user what to review (`git diff --cached`) and let them commit.
