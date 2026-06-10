# upgrade-cycle

**An autonomous, goal-driven workflow for Claude Code that upgrades and migrates codebases —
safely, test-first, and mostly unattended.**

You give it a detailed goal ("migrate this app's data model", "upgrade Angular 16 → 17", "port
this service to the new framework"). It breaks the work into an ordered task plan, hands it to you
for approval, then drives each task through a **plan → develop → review** loop until the change is
implemented, tested, and production-safe — pausing only when it genuinely needs your decision.

It is **one file** (`upgrade-cycle.mjs`) plus a config you write. Everything project- and
stack-specific lives in the config; the engine itself knows nothing about your language or
framework.

---

## What it actually does

For every task in the plan, it runs a tight loop:

1. **Plan** — a senior-engineer agent reads your code (and a reference example, if you provide one)
   and writes a precise, minimal implementation plan. It can pull in ad-hoc research first.
2. **Develop** — another agent implements the plan, writes/updates tests where the risk warrants
   it, and runs your build + test commands.
3. **Review** — an adversarial agent reviews **only the change just made** for production-blocking
   problems.
4. **Triage** — the planner decides: accept it, do another round, **flag** something that needs
   your call, or **stop** if it hits a true blocker.

It works **test-first**: for risky features it writes the failing tests first, then converts the
code until they pass. It leaves the code it touches a little better, fixes obvious wins and
testing blockers, and **flags** (rather than silently changing) anything that's a real
business-logic judgment call.

### Safety model — why it won't cause regressions

- **It uses git staging as the boundary.** Accepted work is `git add`-ed (the "known-good
  baseline"); the current task's work-in-progress stays unstaged (what the reviewer scrutinises).
  A later task that disturbs earlier accepted work shows up immediately in the diff.
- **It never commits.** Every change lands **staged, not committed**. You review and commit.
- **It only touches what the goal requires.** Pre-existing issues in untouched code are left alone
  (run a normal code review for those) — so it won't "helpfully" rewrite your legacy logic.

---

## Requirements

- **Claude Code** with the Workflow capability (this runs as a Claude Code *workflow*).
- The target is a **git repository.** Staging is how regressions are caught — non-negotiable.
- **A way to run the project's tests locally** — whatever your stack uses: `npm test`, `pytest`,
  `cargo test`, `go test`, or a containerised runner like `docker exec … phpunit`. You provide the
  exact commands; the workflow just runs them and reads pass/fail.
- Ideally a **reference**: a sibling repo/module where a similar change was already done. The agents
  mirror it. Optional but a big quality boost.

---

## Using it in Claude Code

### 1. Point Claude at this tool and include the word **“workflow”**

The Workflow tool only activates when you opt in, so include **“workflow”** (or “workflows”) in
your message. For example:

> "Use the upgrade-cycle **workflow** in `~/tools/upgrade-cycle` to migrate `~/work/myapp`. Here's
> the goal: … Start with the plan phase so I can review the breakdown."

### 2. Write your config

Copy `examples/TEMPLATE.json` and fill it in (see `examples/` for a TypeScript/Angular example and
a PHP/docker example). The fields that matter most:

| field | what it is |
|------|------------|
| `goal` | one detailed paragraph: what to change, why, what must NOT break, what "done" looks like |
| `target.repo` | absolute path to the target **git** repo |
| `root` | *(optional)* where run-state is written; **auto-detected** from the working directory if omitted |
| `gates.build` / `gates.test` | the shell commands that compile/lint and run your tests |
| `gates.testSetup` | notes: how to run ONE test, runner quirks, run-as-user, DB isolation |
| `reference` | (optional) a completed example to mirror |
| `seed` | (optional) a first-cut task list to steer the breakdown |

### 3. Run the two phases

- **Plan first.** Ask Claude to run the `plan` phase. It writes a proposed task list to
  `runs/<runId>/tasks.json` (+ a readable `TASKS.md`) and **stops**. Review and edit it.
- **Then run.** Ask Claude to run the `run` phase. Tip: have it run just the **first slice** first
  (a `runOnly` subset) so you can sanity-check cost and quality before letting the rest go.

Claude drives the `Workflow` tool for you — you mostly approve the plan, watch progress
(`/workflows`), and review the result.

---

## Reviewing the changes

When a run finishes, **nothing is committed** — it's all staged in your target repo. Review it like
a PR:

```bash
cd /path/to/target-repo
git diff --cached            # everything the workflow staged
git diff --cached --stat     # the file-level summary
<your test command>          # confirm the suite is green yourself
```

Then check the run's reports under `runs/<runId>/`:

- **`LEDGER.md`** — every task and its status.
- **`NEEDS-DECISION.md`** — anything the workflow flagged for *you* (usually a business-logic call).
  Read this before committing.
- **`CHANGELOG.md`** — a human-readable summary of what changed.
- **`BLOCKERS.md`** — only present if a run hard-stopped; explains why and how to resume.

When you're satisfied: commit (you may want to unstage any local-only patches first). If you run a
separate, general code-review pass before production, do it now — this workflow deliberately stays
in scope and leaves broad cleanups to that pass.

---

## How much does a run cost / how long?

Each task is a full multi-agent cycle — expect roughly **250–350k tokens per task** and a few
minutes each. Keep tasks right-sized (~1–6 files); the planner does this for you and will split
anything too large. Use `runOnly` to checkpoint cheaply.

---

## Reference

- **`CLAUDE.md`** — the operator guide Claude follows when driving this (the deeper mechanics and
  gotchas).
- **`examples/`** — `TEMPLATE.json`, plus worked configs for an Angular upgrade and a PHP/docker
  data-model migration.
- **`upgrade-cycle.mjs`** — the engine. The top of the file documents every `args` field.

### Config field reference

| field | required | meaning |
|------|:--:|---------|
| `phase` | ✓ | `"plan"` (decompose + stop) or `"run"` (execute) |
| `runId` | ✓ | names the state dir `runs/<runId>/` |
| `goal` | ✓ | the prose objective |
| `target` | ✓ | `{ repo, lang, framework }` — `repo` is the target git repo |
| `gates` | ✓ | `{ build, test, testSetup }` — your stack's commands |
| `root` |  | where state is written + base for relative paths; auto-detected from cwd if omitted |
| `reference` |  | a completed example to mirror |
| `conventions` |  | coding rules the reviewer judges against |
| `seed` |  | first-cut task list (strings or task objects) |
| `runOnly` |  | array of task ids — run a dependency-closed subset |
| `baselineNote` |  | expected pre-existing working-tree changes to fold into the baseline |
| `fixSeverity` / `reviewSeverity` |  | severity floors (default `high`) |
| `maxRounds` / `maxResearch` |  | per-task fix-round / research caps (default 3 / 3) |
| `models` / `agentTypes` |  | per-role model tier and subagent type |
