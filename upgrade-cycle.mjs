export const meta = {
  name: 'upgrade-cycle',
  description: 'Goal-driven autonomous upgrade/migration: decompose → plan → develop → review → triage, looped per task until done, blocked, or flagged',
  whenToUse: 'Drive a detailed prose goal (migrate a data model, upgrade a language/runtime version, port a framework, refactor a subsystem) to a production-ready state over a long autonomous run. Two-phase: phase:"plan" decomposes + stops for approval; phase:"run" executes.',
  phases: [
    { title: 'Load', detail: 'Read the approved task plan + prior progress (resume)' },
    { title: 'Decompose', detail: 'Planner breaks the goal into an ordered, dependency-aware task list (plan phase only)' },
    { title: 'Research', detail: 'Ad-hoc read-only agent answers the Planner\'s open questions before it commits to a plan' },
    { title: 'Critique', detail: 'Independent critic re-derives the change surface and flags plan coverage gaps (plan phase only)' },
    { title: 'Plan', detail: 'Planner emits a verified, minimal develop-plan for one task; sets tests_required' },
    { title: 'Develop', detail: 'Developer implements minimally + tests, runs gates, leaves changes UNSTAGED' },
    { title: 'Review', detail: 'Adversarial reviewer reads the unstaged git diff only (this cycle\'s scope)' },
    { title: 'Triage', detail: 'Planner routes findings via the decision matrix, stages on accept, hard-stops on a blocker' },
    { title: 'Record', detail: 'Scribe persists per-task progress + CHANGELOG + rebuilds LEDGER' },
    { title: 'Sweep', detail: 'After ALL tasks are done: independent agent hunts for goal-coverage gaps the plan missed' },
  ],
};

// =============================================================================
// Config — everything app/goal-specific arrives via args so the script stays general
// =============================================================================
const A = typeof args === 'string' ? JSON.parse(args) : args;
if (!A || !A.goal || !A.runId) {
  throw new Error('args must include at least { runId, goal, target, gates }; got typeof=' + (typeof args));
}

const PHASE      = A.phase ?? 'plan';                       // 'plan' (decompose+stop) | 'run' (execute)
const RUN_ID     = A.runId;
const GOAL       = A.goal;
const TARGET     = A.target ?? {};                          // { repo, lang, framework }
const REFERENCE  = A.reference ?? '';                       // optional: a completed example to diff against
const CONVENTIONS= A.conventions ?? '(none supplied — infer from the surrounding code)';
const GATES      = A.gates ?? {};                           // { build, test, testSetup }
const SEED       = A.seed ?? [];                            // optional task seed to anchor decomposition
const MAX_ROUNDS = A.maxRounds ?? 3;                        // fix rounds per task before "needs-attention"
const MAX_RESEARCH = A.maxResearch ?? 3;                    // research↔re-plan iterations before forcing a plan

// Per-role model tiers + OPTIONAL custom subagent types. By default no agentType is passed, so
// every role runs as the harness's standard workflow subagent (always available); 'Explore' for
// research is a Claude Code built-in. Only set an agentType that exists in YOUR agent registry.
// Scribe work is mechanical (verbatim JSON writes, status tables) — a cheaper tier is deliberate.
const AT = { research: 'Explore', ...(A.agentTypes ?? {}) };
const M  = { planner: 'opus', research: 'sonnet', develop: 'opus', review: 'sonnet', scribe: 'sonnet', ...(A.models ?? {}) };
const roleOpts = (role, extra) => ({ model: M[role], ...(AT[role] ? { agentType: AT[role] } : {}), ...extra });

// Resolve ROOT to an ABSOLUTE path so every agent + `git -C` call is cwd-independent (subagents
// run with varying working directories, so relative paths would scatter state). Priority:
//   1. explicit args.root  →  2. AUTO-DETECT the working directory at runtime.
// (2) makes the tool adapt to wherever it is invoked from with no hardcoded per-machine path.
// Run-state lands in `<ROOT>/runs/<runId>` unless args.stateDir overrides it.
let ROOT = (A.root ? String(A.root) : '').replace(/\\/g, '/').replace(/\/+$/, '');
if (!ROOT) {
  const loc = await agent(
    'Output ONLY the absolute current working directory: run `pwd` and return its path verbatim, nothing else. Read-only — change nothing.',
    roleOpts('research', { label: 'locate-root',
      schema: { type: 'object', required: ['cwd'], properties: { cwd: { type: 'string' } } } }),
  );
  ROOT = String(loc?.cwd ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  log(`root auto-detected: ${ROOT || '(detection failed — falling back to cwd-relative paths)'}`);
}
const abs        = (p) => (ROOT && !/^([a-zA-Z]:)?\//.test(p)) ? `${ROOT}/${p}` : p;
const REFERENCE_P = REFERENCE ? abs(REFERENCE) : '';
const REPO       = abs(TARGET.repo ?? '.');                 // absolute path to the target git repo
const STATE_DIR  = abs(A.stateDir ?? `runs/${RUN_ID}`);     // <root>/runs/<runId> unless overridden

// Two severity floors. Review surfaces everything >= REVIEW_SEV; everything >= FIX_SEV is
// fixable IN-LOOP — UNLESS it's a pre-existing business-logic defect (regression risk), which
// is flagged to NEEDS-DECISION instead.
const SEV_RANK   = { low: 1, medium: 2, high: 3, critical: 4 };
// LEAN policy (deliberate, to save context): this workflow makes the REQUESTED change correct and
// production-safe — it is NOT a general code review. The reviewer looks only at the diff and
// surfaces only INTRODUCED, production-blocking (high+) defects + testing blockers. Easy obvious
// in-scope wins are taken; medium/low/cosmetic issues are neither fixed nor logged — a separate
// code-review workflow catches those. So the review floor defaults HIGH.
const FIX_SEV    = SEV_RANK[A.fixSeverity ?? 'high'];
const REVIEW_SEV = SEV_RANK[A.reviewSeverity ?? (A.fixSeverity ?? 'high')];

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

// Per-task gate semantics. Some goals keep the WHOLE suite intentionally red mid-run (test-first
// migrations where the environment/schema already moved ahead of the code), so "done" is judged
// per-task against its own selector, never whole-suite-green:
//   green        -> build passes AND this task's (selector-scoped) tests pass
//   red-baseline -> build passes AND the authored tests FAIL for the expected reason (TDD red step)
//   build-only   -> build passes; no test pass/fail requirement
// Build (lint/compile) must ALWAYS pass — a broken build is never acceptable.
function gateOk(gx, needTests, dev) {
  if (!dev) return false;
  if (GATES.build && dev.build_passed !== true) return false;       // build/lint must always pass
  if (!GATES.test || gx === 'build-only') return true;
  if (gx === 'red-baseline') return dev.test_outcome === 'failed-expected';
  if (needTests && dev.tests_run_count === 0) return false;         // selector matched NOTHING — a false green
  return needTests ? dev.test_outcome === 'passed' : true;          // 'green' (no-test tasks pass on build)
}

// =============================================================================
// Structured-output schemas
// =============================================================================
const TASK_SHAPE = {
  type: 'object',
  required: ['id', 'title', 'description', 'files', 'tests_required'],
  properties: {
    id: { type: 'string', description: 'stable kebab-case id, unique within the plan' },
    title: { type: 'string' },
    description: { type: 'string', description: 'what this task changes and why, grounded in the goal' },
    files: { type: 'array', items: { type: 'string' }, description: 'likely-touched source paths (repo-relative)' },
    depends_on: { type: 'array', items: { type: 'string' }, description: 'task ids that must complete first' },
    tests_required: { type: 'boolean', description: 'true if break-risk × business-logic-importance × complexity warrants tests' },
    tests_rationale: { type: 'string' },
    acceptance: { type: 'string', description: 'observable definition of done for this task' },
    risk: { type: 'string', enum: ['low', 'medium', 'high'] },
    gate_expectation: {
      type: 'string', enum: ['green', 'red-baseline', 'build-only'],
      description: 'what gate outcome means DONE for this task. green = build + THIS task\'s tests pass. red-baseline = author tests that FAIL for the expected reason (test-first/TDD); build green, suite intentionally red. build-only = no test pass/fail requirement.',
    },
    test_selector: { type: 'string', description: 'which tests define this task done — a test path or name filter scoped to this task (e.g. a single test file, or a --filter/-k pattern); "" = none / whole suite' },
    size: { type: 'string', enum: ['S', 'M', 'L'], description: 'rough effort/context for ONE develop pass. Target M (~1–6 files, fits ~150k tokens). Fold S into a neighbor; split L.' },
  },
};

const DECOMPOSE_SCHEMA = {
  type: 'object',
  required: ['tasks', 'research_requests'],
  properties: {
    tasks: { type: 'array', items: TASK_SHAPE },
    research_requests: { type: 'array', items: { type: 'string' }, description: 'open questions to resolve before the plan is trustworthy; empty when confident' },
    notes: { type: 'string' },
  },
};

const RESEARCH_SCHEMA = {
  type: 'object',
  required: ['question', 'findings'],
  properties: {
    question: { type: 'string' },
    findings: { type: 'string', description: 'concrete answer with file paths / commit refs / code excerpts' },
    recommendation: { type: 'string' },
  },
};

const PLAN_SCHEMA = {
  type: 'object',
  required: ['task_id', 'steps', 'files', 'tests_required', 'research_requests'],
  properties: {
    task_id: { type: 'string' },
    steps: { type: 'array', items: { type: 'string' }, description: 'ordered, minimal implementation steps' },
    files: { type: 'array', items: { type: 'string' } },
    tests_required: { type: 'boolean' },
    tests_plan: { type: 'string', description: 'what to test and how (unit or integration), or "" if none' },
    gate_expectation: { type: 'string', enum: ['green', 'red-baseline', 'build-only'], description: 'confirm/override the task gate expectation' },
    test_selector: { type: 'string', description: 'confirm/override the test path/filter scoping this task done' },
    research_requests: { type: 'array', items: { type: 'string' }, description: 'remaining open questions; empty = ready to develop' },
    decision_notes: { type: 'string', description: 'where the decision matrix chose between valid options' },
  },
};

const DEVELOP_SCHEMA = {
  type: 'object',
  required: ['results', 'build_passed', 'test_outcome', 'unstaged_confirmed'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'status', 'summary'],
        properties: {
          file: { type: 'string' },
          status: { type: 'string', enum: ['CHANGED', 'ADDED', 'SKIPPED', 'FAILED'] },
          summary: { type: 'string' },
        },
      },
    },
    tests_written: { type: 'boolean' },
    build_passed: { type: 'boolean' },
    test_passed: { type: 'boolean', description: 'true if the task tests ran AND passed' },
    test_outcome: {
      type: 'string', enum: ['passed', 'failed-expected', 'failed-unexpected', 'not-run'],
      description: 'passed = task tests green. failed-expected = red baseline exactly as the test-first task intends. failed-unexpected = failed for a wrong reason (a real defect). not-run = no tests executed.',
    },
    ran_tests: { type: 'boolean' },
    tests_run_count: { type: 'integer', description: 'how many tests the runner ACTUALLY executed for this task\'s selector. 0 = the selector matched nothing (a false green — the gate fails on it); -1 = the runner reports no count' },
    unstaged_confirmed: { type: 'boolean', description: 'true if changes were left UNSTAGED (git add NOT run)' },
    gate_output: { type: 'string', description: 'tail of failing gate output, or "" if green' },
    notes: { type: 'string' },
  },
};

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'category', 'severity', 'title', 'detail', 'introduced_by_this_change', 'business_logic'],
        properties: {
          file: { type: 'string' },
          line: { type: 'string' },
          category: { type: 'string', enum: ['correctness', 'security', 'error-handling', 'regression', 'api-contract', 'data-integrity', 'types', 'testing', 'performance', 'maintainability', 'convention'] },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          title: { type: 'string', description: 'short, specific, stable across rounds' },
          detail: { type: 'string' },
          introduced_by_this_change: { type: 'boolean', description: 'true if THIS cycle\'s unstaged diff introduced it; false if it pre-exists in the staged/committed baseline' },
          business_logic: { type: 'boolean', description: 'true if it touches existing domain/business logic whose behavior could regress' },
          suggested_fix: { type: 'string' },
        },
      },
    },
  },
};

const TRIAGE_SCHEMA = {
  type: 'object',
  required: ['verdicts', 'accepted', 'staged', 'has_blocker'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['finding_id', 'is_real', 'decision', 'blocking', 'rationale'],
        properties: {
          finding_id: { type: 'string' },
          is_real: { type: 'boolean' },
          decision: { type: 'string', enum: ['ACTIONABLE', 'DEFER', 'NEEDS_USER', 'REJECT'] },
          blocking: { type: 'boolean', description: 'true ONLY if this prevents all further progress on the goal' },
          matrix: {
            type: 'object',
            properties: {
              clarity: { type: 'string', enum: ['clear', 'ambiguous'] },
              effort: { type: 'string', enum: ['small', 'large'] },
              blast_radius: { type: 'string', enum: ['local', 'cross-cutting'] },
              scope: { type: 'string', enum: ['in-scope', 'scope-creep'] },
              architectural: { type: 'boolean' },
            },
          },
          rationale: { type: 'string' },
          fix_instruction: { type: 'string', description: 'precise minimal instruction (ACTIONABLE only)' },
        },
      },
    },
    accepted: { type: 'boolean', description: 'true if the round is accepted (gates green, zero ACTIONABLE) and was staged' },
    staged: { type: 'boolean', description: 'true if you ran `git add` on the task files this round' },
    regression_found: { type: 'boolean', description: 'true if the unstaged diff regressed previously-staged/accepted work' },
    has_blocker: { type: 'boolean', description: 'true if any verdict.blocking is true; conductor halts the whole run' },
    new_tasks: { type: 'array', items: TASK_SHAPE, description: 'large/cross-cutting in-scope items split into follow-up tasks' },
    next_fix_plan: {
      type: 'object',
      properties: { steps: { type: 'array', items: { type: 'string' } }, files: { type: 'array', items: { type: 'string' } } },
      description: 'develop-plan for the next round (present when accepted=false and not blocked)',
    },
    wrote_logs: { type: 'boolean' },
    summary: { type: 'string' },
  },
};

const LOADER_SCHEMA = {
  type: 'object',
  required: ['tasks', 'done'],
  properties: {
    tasks: { type: 'array', items: TASK_SHAPE, description: 'the approved task plan from tasks.json (empty if the file is missing)' },
    done: { type: 'array', items: { type: 'object', required: ['id', 'status'], properties: { id: { type: 'string' }, status: { type: 'string' } } } },
    plan_missing: { type: 'boolean' },
  },
};

const RECORD_SCHEMA = { type: 'object', required: ['written'], properties: { written: { type: 'boolean' }, tasks_complete: { type: 'integer' } } };

const CRITIQUE_SCHEMA = {
  type: 'object',
  required: ['gaps'],
  properties: {
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'evidence'],
        properties: {
          title: { type: 'string' },
          evidence: { type: 'string', description: 'file:line hits / grep counts proving the miss — no evidence, no gap' },
          suggestion: { type: 'string', description: 'fold into task <id> | new task | reorder | split' },
        },
      },
    },
    notes: { type: 'string' },
  },
};

const SWEEP_SCHEMA = {
  type: 'object',
  required: ['complete', 'gaps'],
  properties: {
    complete: { type: 'boolean', description: 'true if no goal-coverage gaps were found' },
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'evidence'],
        properties: {
          title: { type: 'string' },
          evidence: { type: 'string', description: 'file:line hits or gate output proving the gap' },
          suggested_task: { type: 'string', description: 'a one-line follow-up task that would close it' },
        },
      },
    },
    suite_result: { type: 'string', description: 'observed outcome of running the FULL gates (or why they were not run)' },
  },
};

const BASELINE_SCHEMA = {
  type: 'object',
  required: ['clean'],
  properties: {
    clean: { type: 'boolean', description: 'true once `git diff` (unstaged tracked) is empty' },
    staged_files: { type: 'array', items: { type: 'string' } },
    ignored_untracked: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
};

// =============================================================================
// Shared prompt fragments
// =============================================================================
const CONTEXT = `
GOAL (the north star — everything serves this; do not exceed it):
${GOAL}

TARGET REPO: ${REPO}  (lang=${TARGET.lang ?? '?'}, framework=${TARGET.framework ?? '?'})
${REFERENCE_P ? `REFERENCE (a COMPLETED example of this kind of change — mine it for the canonical pattern): ${REFERENCE_P}` : ''}

CONVENTIONS (match these; deviations are 'convention' findings):
${CONVENTIONS}

GATES (the build/test commands that define "it works"):
  build: ${GATES.build ?? '(none)'}
  test:  ${GATES.test ?? '(none)'}
  ${GATES.testSetup ? `test setup note: ${GATES.testSetup}` : ''}

STAGING CONTRACT (the cycle boundary is git itself):
  • staged index + HEAD  = ACCEPTED baseline (prior blessed work). Treat as known-good.
  • unstaged working tree = THIS cycle's work — the only thing under review.
  • Developers NEVER stage. The Planner stages (git add, NEVER commit) only on acceptance.

BE TOKEN-ECONOMICAL (target ~150k tokens for your whole turn): read ONLY the files this task
touches plus the SPECIFIC reference section you need — do NOT re-read the whole tree or the entire
reference. Prefer targeted grep over broad reads. Don't restate large files back; act on them.
`;

const MATRIX = `
SCOPE DISCIPLINE (this is NOT a general code review — a SEPARATE review workflow does that later):
Act ONLY on issues THIS change introduced. Make the requested update correct, testable, and
production-safe, and leave the code we TOUCHED a little better — nothing more. Pre-existing problems
in untouched code are OUT OF SCOPE: never fix them (regression risk) and don't even log them.

DECISION MATRIX — route each finding IN ORDER (first match wins):
  1. is_real == false ............................................ REJECT (drop)
  2. introduced_by_this_change == false (pre-existing) .......... REJECT (out of scope — drop, do NOT log)
  3. prevents tests/build from running or passing .............. ACTIONABLE (testing blockers are ALWAYS fixed)
  4. easy & obvious in-scope fix (clear, local, ≤ a few lines) . ACTIONABLE (take the easy win, any severity)
  5. introduced regression of previously-staged/accepted work . ACTIONABLE (you raise this yourself)
  6. severity >= ${A.fixSeverity ?? 'high'} (production-blocking) AND a clear correct in-scope fix ... ACTIONABLE (fix our own breakage)
  7. severity >= ${A.fixSeverity ?? 'high'} but ambiguous / a business-logic judgment / needs a human call
        ... NEEDS_USER → ${STATE_DIR}/NEEDS-DECISION.md (FLAG — must be addressed before production).
            blocking=true ONLY if no further GOAL progress is possible without the answer.
  8. scope-creep / new feature outside the GOAL ................ REJECT (drop, do NOT log)
  9. otherwise (medium/low, non-blocking, not an easy win) ..... REJECT — DO NOT log it. The separate
        code-review workflow will catch it. Conserving context is the priority here.
NET: fix testing blockers + easy wins + our own production-blocking breakage; FLAG only the major
issues that need a human (usually business logic); silently drop everything else. Don't chase or
document perfection — that is what wastes context and rounds.
`;

// =============================================================================
// Role prompts
// =============================================================================
const decomposePrompt = (research) => `
You are the PLANNER in DECOMPOSE mode. Read the target repo (and the reference, if given) and
break the GOAL into an ORDERED, dependency-aware list of bounded tasks — the smallest set of
units that, done in order, fully achieve the goal and nothing more.
${CONTEXT}
${SEED.length ? `SEED (a human's first-cut task list — refine, reorder, split/merge, correct; keep what's right):\n${SEED.map((s, i) => `  ${i + 1}. ${typeof s === 'string' ? s : JSON.stringify(s)}`).join('\n')}` : ''}
${research.length ? `RESEARCH you previously requested (use it; do not re-ask what is answered):\n${research.map((r) => `  Q: ${r.question}\n  A: ${r.findings}\n  ⇒ ${r.recommendation || ''}`).join('\n')}` : ''}

RULES:
- Each task = one coherent, reviewable change with a clear acceptance test. Order by dependency
  (a producer before its consumers). Set depends_on accurately.
- Set tests_required per task by your own judgment: TRUE when break-risk × business-logic
  importance × complexity is non-trivial (auth, data integrity, money/state mutations, external API contracts);
  FALSE for changes an LLM zero-shots correctly (mechanical, well-patterned). Explain in
  tests_rationale. Unit OR integration — whichever catches the risk most cheaply.
- TEST-FIRST ORDERING + GATE EXPECTATIONS. Some goals keep the whole suite intentionally RED
  mid-run (e.g. the environment/schema/spec has already moved ahead and the code is catching up) —
  when the GOAL implies this, "done" is per-task, never whole-suite-green. For each KEY/RISKY
  feature, author its tests BEFORE converting it. Set each task's gate_expectation + test_selector:
    • A test-authoring task → gate_expectation="red-baseline" (build green; the new tests must FAIL
      for the right reason — they ARE the spec the later conversion satisfies).
    • A conversion task → gate_expectation="green", test_selector scoping to JUST that feature's
      tests (so the rest of the still-red suite doesn't block it).
    • Mechanical low-risk tasks with no tests → gate_expectation="build-only".
  If the test harness doesn't exist yet, the FIRST task stands it up (gate_expectation="green",
  a trivial sanity test passing proves the harness works) before any red-baseline task.
- RIGHT-SIZE TASKS for token efficiency. Each task pays a FULL plan→develop→review→triage→record
  cycle (~hundreds of k tokens), so TINY tasks waste tokens and HUGE tasks blow an agent's context.
  Target each task at ONE coherent, independently-reviewable change of ~1–6 files that a single
  developer pass (~150k tokens) can implement AND test. FOLD trivial/mechanical changes into the
  nearest related feature task rather than giving them their own cycle; SPLIT anything too big for
  one pass. Set \`size\` (S/M/L) and avoid S.
- FEWER CYCLES: you MAY combine a feature's test-authoring and its conversion into ONE test-first
  task (write the failing test, then implement until it is green; gate_expectation="green") instead
  of two separate tasks, whenever the feature is small/clear enough to do in a single pass. Reserve
  the separate red-baseline test task for large/risky features where the failing spec is worth
  reviewing on its own before conversion.
- READ the actual code to anchor the file lists. Do NOT invent files.
- INVENTORY THE FULL SURFACE: grep the repo for EVERY occurrence of the patterns/APIs/symbols the
  GOAL replaces or touches — do NOT extrapolate from a few sample files. Every hit must be covered
  by some task (or explicitly noted out-of-scope in notes). Record the hit counts in notes so
  coverage is checkable afterwards.
- If anything material is uncertain (an ambiguous contract, an unclear precedence rule, how the
  reference solved it), put it in research_requests INSTEAD of guessing. Return empty
  research_requests only when you are confident the plan is trustworthy.
- Do NOT write any files or change any code in this mode. Return the plan via the schema.`;

const researchPrompt = (q) => `
You are the RESEARCH agent (read-only). Answer ONE specific question the Planner needs resolved
before it commits to a plan. Be concrete: cite file paths, commit refs, code excerpts, or live
docs. Do NOT modify anything.
${CONTEXT}
QUESTION:
${q}

Inspect the target repo and especially the REFERENCE (a completed example) where relevant. If the
question is about an external spec/API, you may search the web. Return your answer via the schema
with an actionable recommendation.`;

const planPrompt = (task, research) => `
You are the PLANNER producing a develop-plan for ONE task. Verify it against the real code, then
emit the minimal set of steps to satisfy the task's acceptance — no gold-plating, no scope creep.
${CONTEXT}
TASK: ${task.id} — ${task.title}
  ${task.description}
  files (likely): ${(task.files || []).join(', ') || '(discover)'}
  acceptance: ${task.acceptance || '(define it)'}
  tests_required (from decomposition): ${task.tests_required} — ${task.tests_rationale || ''}
${research.length ? `RESEARCH you requested:\n${research.map((r) => `  Q: ${r.question}\n  A: ${r.findings}\n  ⇒ ${r.recommendation || ''}`).join('\n')}` : ''}

PROCEDURE:
1. Read the task's files and the reference's equivalent (commit/pattern) so the plan mirrors the
   proven approach. Where multiple valid implementations exist, apply the DECISION MATRIX and
   record the choice in decision_notes.
2. Confirm or correct tests_required, gate_expectation (green | red-baseline | build-only), and
   test_selector for THIS task; if tests are needed, say exactly what to test (tests_plan). If the
   suite is intentionally red mid-run, a conversion task is green only against its OWN selector;
   a test-authoring task is "done" when its new tests fail as intended (red-baseline).
3. If a material uncertainty remains, return it in research_requests (the conductor will fetch an
   answer and call you again). Return empty research_requests when ready to hand off to Develop.
4. Do NOT modify code in this mode. Return the plan via the schema.
${MATRIX}`;

const developPrompt = (task, plan, repairOf) => {
  const gx = plan.gate_expectation || task.gate_expectation || 'green';
  const sel = plan.test_selector || task.test_selector || '';
  const needTests = (plan.tests_required ?? task.tests_required) === true;
  const gxLine = gx === 'red-baseline'
    ? 'red-baseline — AUTHOR the tests for this feature; they MUST FAIL because the code is not converted yet. Report test_outcome="failed-expected" once they run and fail for the RIGHT reason (asserting the not-yet-built target behavior), or "failed-unexpected" if they fail for a wrong reason (a parse error, missing fixture, etc.).'
    : gx === 'build-only'
      ? 'build-only — no test pass/fail requirement; just keep the build green.'
      : 'green — this task\'s tests must PASS (test_outcome="passed").';
  return `
You are the DEVELOPER. Implement the plan EXACTLY — minimally and surgically. Match conventions.
NO opportunistic refactors, NO scope creep beyond the plan.
${CONTEXT}
TASK: ${task.id} — ${task.title}
${repairOf ? `THIS IS A REPAIR ROUND. Address ONLY these items from the prior review/gate failure:` : `PLAN STEPS:`}
${(plan.steps || []).map((s, i) => `  ${i + 1}. ${s}`).join('\n')}
FILES: ${(plan.files || task.files || []).join(', ')}
TESTS: ${needTests ? `REQUIRED — ${plan.tests_plan || 'cover the risky path with unit or integration tests'}` : 'not required for this task'}
GATE EXPECTATION: ${gxLine}
TEST SELECTOR (scope the test run to THIS task — the rest of the suite may be intentionally red mid-run): ${sel || '(none — run the smallest relevant set)'}

PROCEDURE (IPO):
0. BASELINE: the accepted baseline is already STAGED. \`git -C ${REPO} diff\` therefore shows only
   this cycle's work: empty on the first round of a task, or your own prior-round work on a repair
   round (build ON it — do not revert it). Do not stage anything yourself.
1. Implement the steps. Author/extend tests as the gate expectation requires. If the test harness
   is missing: ${GATES.testSetup || '(stand it up minimally)'}. Leave the lines you TOUCH a little
   better (obvious one-line wins are welcome), but do NOT refactor or fix unrelated/pre-existing code.
   Before returning, SELF-REVIEW your own diff and fix anything obviously wrong — catching it here
   saves a whole extra review→fix round.
2. Run the GATES and capture results:
     build: ${GATES.build ?? '(skip — none configured)'}
     test (scope to the selector above when set): ${GATES.test ?? '(skip — none configured)'}
   Set build_passed, and set test_outcome to passed | failed-expected | failed-unexpected | not-run.
   SANITY-CHECK the runner REALLY executed your tests: set tests_run_count to the count the runner
   reports (0 = your selector matched NOTHING — that is a FALSE green, fix the selector and re-run;
   -1 if the runner prints no count). Some runners silently ignore extra path arguments — when in
   doubt run one file per invocation or use the runner's filter flag.
3. Do NOT chase whole-suite green — only this task's scoped tests matter. Never weaken/delete tests
   or disable checks. Build/lint must always pass; if you cannot make it pass within scope, leave it
   failing and explain in gate_output.
4. LEAVE CONTENT UNSTAGED — do NOT \`git add\` content and do NOT commit. EXCEPTION: for any file you
   CREATE, run \`git -C ${REPO} add -N <file>\` (intent-to-add) so it shows up in the reviewer's
   \`git diff\` (which otherwise omits brand-new files). Intent-to-add does not stage content. The
   Planner stages for real on acceptance. Set unstaged_confirmed=true.
Report per-file status + gate results via the schema.`;
};

const reviewPrompt = (task, handled) => `
You are the ADVERSARIAL REVIEWER. Review ONLY this cycle's work — the UNSTAGED diff — for
production-readiness. The staged/committed baseline is KNOWN-GOOD context: read it to understand
intent, but do NOT review it and do NOT hunt for pre-existing problems in untouched code.
${CONTEXT}
TASK UNDER REVIEW: ${task.id} — ${task.title}
  acceptance: ${task.acceptance || ''}

SCOPE — get the exact diff first:
  \`git -C ${REPO} diff\`            (unstaged tracked changes = part of THIS cycle — review this)
  \`git -C ${REPO} status --porcelain\` then READ every NEW/untracked file (\`??\`/\`A\`) that belongs
       to this task — \`git diff\` OMITS brand-new files, so new test/source files only show up here.
  \`git -C ${REPO} diff --staged\`  (accepted baseline — context only, do NOT review)
THIS CYCLE = the unstaged tracked diff PLUS those new files. Ignore unrelated pre-existing baseline.

This is NOT a general code review — a SEPARATE review workflow audits the whole codebase later.
Your ONLY job: did THIS change introduce a problem that blocks testing or production? Report ONLY:
  • TESTING BLOCKERS — anything that stops the build/tests from running or passing.
  • INTRODUCED PRODUCTION-BLOCKING defects (severity >= ${A.reviewSeverity ?? 'high'}): a real
    correctness/security/data-integrity/api-contract bug or a REGRESSION this diff caused.
  • INCOMPLETE IMPLEMENTATION — the diff does NOT actually satisfy the task's acceptance (a missed
    call site, an unconverted branch, a test asserting the wrong behavior). Report as correctness/high.
  • (optional) a genuinely OBVIOUS one-line in-scope improvement to a line THIS diff touched.
Do NOT report — drop silently — anything that is: pre-existing (not caused by this diff), medium/
low severity, stylistic, "could be more defensive", speculative, a redesign, or out of the GOAL's
scope. Those are explicitly someone else's job. An empty findings list is the NORMAL, GOOD outcome.
For each finding set introduced_by_this_change (must be TRUE — you don't report pre-existing) and
business_logic, with a specific file:line and a minimal fix direction.
Do NOT re-report ALREADY HANDLED items:
${handled.length ? handled.map((t) => `  - ${t}`).join('\n') : '  (none yet)'}
Return via the schema (usually an empty array).`;

const triagePrompt = (task, items, round, gateMet, gateDesc, gateOutput, isLastRound) => `
You are the PLANNER in TRIAGE mode — and the orchestrator-of-record for the git baseline. Confirm
each finding against the ACTUAL unstaged diff, route it via the decision matrix, and either ACCEPT
(stage) the round or produce the next fix-plan. Reject false positives and scope creep ruthlessly.
${CONTEXT}
TASK: ${task.id} — ${task.title}   (round ${round} of max ${MAX_ROUNDS})
GATE EXPECTATION: ${gateDesc}
GATE OUTCOME: ${gateMet ? 'MET — the gate expectation is satisfied' : 'NOT MET — see detail:'}
${gateMet ? '' : (gateOutput || '(no detail)')}

CANDIDATE FINDINGS (finding_id :: file :: category/severity :: introduced/business :: title):
${items.length ? items.map((i) => `  - ${i.id} :: ${i.f.file} :: ${i.f.category}/${i.f.severity} :: introduced=${i.f.introduced_by_this_change} business=${i.f.business_logic} :: ${i.f.title}\n      ${i.f.detail}\n      suggested: ${i.f.suggested_fix || '(none)'}`).join('\n') : '  (none — reviewer returned clean)'}
${MATRIX}

PROCEDURE:
1. Verify each finding against \`git -C ${REPO} diff\`. Route via the matrix. For ACTIONABLE items
   write a precise minimal fix_instruction.
2. REGRESSION CHECK: compare the unstaged diff against the staged baseline
   (\`git -C ${REPO} diff --staged\`). If this cycle regressed previously-accepted behavior, raise
   it yourself as an ACTIONABLE finding (set regression_found=true).
3. DOCUMENT — keep this MINIMAL to conserve context (agents own the files; create headers if missing):
     • NEEDS_USER → append to ${STATE_DIR}/NEEDS-DECISION.md (title, where, what, options, recommendation).
     • any blocking=true → ALSO append a consolidated entry to ${STATE_DIR}/BLOCKERS.md.
     • REJECT / dropped items → write NOTHING. Do not log mediums, lows, pre-existing, or scope-creep —
       the separate code-review workflow handles them. Logging them just wastes context.
   Set wrote_logs=true only if you appended a NEEDS_USER or blocker entry.
4. DECIDE (THIS IS THE FINAL ALLOWED ROUND: ${isLastRound ? 'YES' : 'no'}):
   • If the GATE OUTCOME is MET and there are ZERO ACTIONABLE findings: ACCEPT — run
     \`git -C ${REPO} add <the task's changed AND newly-created files>\` (NEVER commit), set
     staged=true & accepted=true. (For a red-baseline task this means the authored tests correctly
     FAIL as intended — a valid, stageable "done": the failing test is the conversion's spec.)
   • LAST-ROUND + GATE MET: if this IS the final allowed round AND the gate is MET but a few minor
     ACTIONABLE easy-wins remain, ACCEPT ANYWAY — stage (accepted=true, staged=true) and DROP the
     leftover easy-wins silently (do NOT log them; they are below the bar). Only REFUSE
     (accepted=false) if a remaining item is a HIGH/CRITICAL INTRODUCED must-fix or a testing blocker.
   • Otherwise (gate NOT met, or a real must-fix remains, and not blocked): accepted=false; return a
     tight next_fix_plan (steps+files) addressing ONLY the gate problem + must-fix ACTIONABLE items.
     Leave the tree UNSTAGED. Do NOT treat an intentionally-red suite as a failure.
   • If any verdict.blocking is true: set has_blocker=true (conductor halts the whole run); do NOT
     stage. The working tree is left intact for the user.
Return everything via the schema.`;

// Lean accept — the common happy path (clean review + gate met). A full triage prompt + opus is
// wasted when there is nothing to triage; this does the two things that still matter (regression
// spot-check + staging) on the cheaper review tier.
const acceptPrompt = (task, round, gateDesc) => `
You are finalizing an ACCEPT for one task: the reviewer found NOTHING and the gate expectation is
met. Two jobs only — regression spot-check, then stage.
${CONTEXT}
TASK: ${task.id} — ${task.title}   (round ${round})
GATE: ${gateDesc}
1. REGRESSION SPOT-CHECK: \`git -C ${REPO} diff --stat\` (this cycle) vs
   \`git -C ${REPO} diff --staged --stat\` (accepted baseline). Confirm the unstaged changes
   plausibly belong to THIS task and did not clobber previously-staged work. If something looks
   regressed, return accepted=false, regression_found=true, and a tight next_fix_plan instead.
2. STAGE: \`git -C ${REPO} add <the task's changed AND newly-created files>\` (NEVER commit), then
   confirm \`git -C ${REPO} diff\` is empty for those files.
Return verdicts=[], accepted=true, staged=true, has_blocker=false via the schema.`;

const critiquePrompt = (tasks) => `
You are an INDEPENDENT PLAN CRITIC (read-only). A planner decomposed the GOAL into the task list
below. Your ONLY job is to find what the plan MISSED — not to restyle or re-architect it.
${CONTEXT}
PROPOSED TASK LIST:
${tasks.map((t) => `  - ${t.id} [deps: ${(t.depends_on || []).join(',') || '-'}] gate=${t.gate_expectation || 'green'} files=${(t.files || []).join(', ') || '(discover)'}\n      ${t.title} — ${t.acceptance || ''}`).join('\n')}

PROCEDURE:
1. Re-derive the change surface YOURSELF: grep the target repo for the patterns/APIs/symbols the
   GOAL replaces or touches. Do NOT trust the plan's file lists — verify them.
2. Compare every hit against the task list. Report a gap ONLY for material misses WITHIN the GOAL:
   an uncovered call site/feature/file, a missing prerequisite (e.g. no test-harness task), a
   dependency-ordering error, or a task too large for one ~150k-token develop pass.
3. Do NOT report style preferences, alternative decompositions, or anything beyond the GOAL.
   An empty gaps list is a GOOD outcome. Do not modify any files.
Return via the schema with file:line evidence for each gap — no evidence, no gap.`;

const amendPrompt = (tasks, critique) => `
You are the PLANNER amending your task plan. An independent critic verified it against the actual
repo and found coverage gaps. Fold the REAL ones in (into an existing task where natural; as a new
or split task where needed; reorder if a dependency was wrong). REJECT any gap that is out of the
GOAL's scope and say why in notes.
${CONTEXT}
CURRENT PLAN:
${JSON.stringify(tasks, null, 2)}

CRITIC'S GAPS:
${critique.gaps.map((g, i) => `  ${i + 1}. ${g.title}\n     evidence: ${g.evidence}\n     suggestion: ${g.suggestion || '(none)'}`).join('\n')}

Return the COMPLETE amended task list via the schema (research_requests=[]). Do NOT write files.`;

const sweepPrompt = (doneIds) => `
You are the FINAL COMPLETENESS SWEEP. Every task is done and its work is STAGED. Verify, against
the repo itself, that the GOAL is actually fully achieved — your job is to find what the task plan
MISSED, not to re-review accepted work.
${CONTEXT}
COMPLETED TASKS: ${doneIds.join(', ')}

PROCEDURE (read-only except step 4):
1. RE-DERIVE the change surface from the GOAL: grep the target repo for every pattern/API/symbol
   the goal replaces or touches. Any hit that should have been converted but wasn't = a gap.
2. Run the FULL gates once and record the real outcome:
     build: ${GATES.build ?? '(none configured)'}
     test:  ${GATES.test ?? '(none configured)'}
   If the GOAL implies whole-suite green at the end, a red suite is a gap. If a red tail is
   expected, say which failures look expected vs surprising.
3. Spot-check the staged diff (\`git -C ${REPO} diff --staged --stat\`): does it plausibly cover
   every task's acceptance? Look for suspiciously-untouched areas the GOAL names.
4. Write ${STATE_DIR}/SWEEP.md: the suite result, then each gap (title + file:line evidence + a
   suggested follow-up task) — or "No gaps found." Do NOT modify source code, stage, or commit.
Report ONLY material, in-GOAL gaps — not improvements, not pre-existing issues. Return via the schema.`;

const baselinePrompt = () => `
You are establishing the git BASELINE for this run in ${REPO}. The staging contract is:
staged index = ACCEPTED baseline, unstaged working tree = the current cycle's work. Right now the
tree may carry PRE-EXISTING local changes that belong to NO task and must not pollute task review
diffs (so the reviewer's \`git diff\` shows only a task's own work).
1. Run \`git -C ${REPO} status --porcelain\`.
2. For every MODIFIED or otherwise-tracked-changed file, run \`git -C ${REPO} add\` on it to fold it
   into the accepted baseline. Do NOT commit. Afterwards \`git -C ${REPO} diff\` must be EMPTY.
3. Leave UNTRACKED files untouched — just list them in ignored_untracked.
${A.baselineNote ? `Expected pre-existing changes (this is normal — stage them as baseline, do not revert): ${A.baselineNote}` : ''}
Do NOT modify any source code. Return the lists + clean=true via the schema.`;

const loaderPrompt = () => `
You are the PROGRESS LOADER (read-only). Prepare a ${PHASE}-phase resume.
1. Read ${STATE_DIR}/tasks.json if it exists → return its task array as "tasks" (set plan_missing
   accordingly; return [] + plan_missing=true if absent).
2. Read every ${STATE_DIR}/progress/*.json (if the dir exists) → return one {id,status} per file
   as "done". Return [] if none.
Do NOT modify anything. Return via the schema.`;

const recorderPrompt = (task, record, total) => `
You are the SCRIBE/RECORDER. Persist this task's outcome durably so a re-run resumes without
redoing it. Do NOT modify source code.
1. Ensure ${STATE_DIR}/progress/ exists.
2. Write this EXACT JSON verbatim to ${STATE_DIR}/progress/${slug(task.id)}.json:
${JSON.stringify(record)}
3. Append a human-readable entry for this task to ${STATE_DIR}/CHANGELOG.md (what changed, files,
   tests added, anything deferred/flagged).
4. Rebuild ${STATE_DIR}/LEDGER.md from ALL ${STATE_DIR}/progress/*.json as a Markdown table:
   columns: task | status | rounds | fixed | tests | deferred | needs-you | gates.
   Heading: "# Upgrade ledger — N / ${total} tasks complete". Sort by task id.
Return written=true and tasks_complete=N.`;

const decomposeRecorderPrompt = (tasks) => `
You are the SCRIBE. Persist the approved-pending task plan for the run phase to read.
1. Ensure ${STATE_DIR}/ exists.
2. Write this EXACT JSON verbatim to ${STATE_DIR}/tasks.json:
${JSON.stringify({ runId: RUN_ID, goal: GOAL, generatedTasks: tasks }, null, 2)}
3. Write a readable ${STATE_DIR}/TASKS.md table
   (task | depends_on | tests? | gate_expectation | test_selector | risk | acceptance)
   so the user can review/edit the plan before approving.
Do NOT modify source code. Return written=true and tasks_complete=${tasks.length}.`;

// =============================================================================
// PHASE: plan — decompose the goal, persist tasks.json, then STOP for approval
// =============================================================================
if (PHASE === 'plan') {
  phase('Decompose');
  log(`decompose: goal "${GOAL.slice(0, 80)}${GOAL.length > 80 ? '…' : ''}" → ${REPO}`);

  let research = [];
  let plan = null;
  for (let i = 0; i <= MAX_RESEARCH; i++) {
    plan = await agent(decomposePrompt(research), roleOpts('planner', {
      schema: DECOMPOSE_SCHEMA, phase: 'Decompose', label: i === 0 ? 'decompose' : `decompose r${i}`,
    }));
    const qs = (plan?.research_requests || []).filter(Boolean);
    if (!qs.length || i === MAX_RESEARCH) break;
    log(`decompose: planner asked ${qs.length} research question(s) (round ${i + 1})`);
    phase('Research');
    const answers = await parallel(qs.map((q) => () => agent(researchPrompt(q), roleOpts('research', {
      schema: RESEARCH_SCHEMA, phase: 'Research', label: `research:${slug(q).slice(0, 24)}`,
    }))));
    research = research.concat(answers.filter(Boolean));
  }

  let tasks = (plan?.tasks || []);

  // Independent coverage critic: a SECOND agent re-derives the change surface from the repo and
  // flags material gaps BEFORE the user approves the plan. One planner pass anchors on what it
  // happened to read; the critic greps the whole surface, so misses get caught while they are
  // still cheap (a plan edit, not a missed task discovered post-run). Disable with planCritic:false.
  if (A.planCritic !== false && tasks.length) {
    phase('Critique');
    const critique = await agent(critiquePrompt(tasks), roleOpts('review', {
      schema: CRITIQUE_SCHEMA, phase: 'Critique', label: 'plan-critic',
    }));
    if ((critique?.gaps || []).length) {
      log(`critique: ${critique.gaps.length} coverage gap(s) found — planner amending the plan`);
      const amended = await agent(amendPrompt(tasks, critique), roleOpts('planner', {
        schema: DECOMPOSE_SCHEMA, phase: 'Decompose', label: 'decompose:amend',
      }));
      if ((amended?.tasks || []).length) { plan = amended; tasks = amended.tasks; }
    } else {
      log('critique: no coverage gaps found');
    }
  }

  phase('Record');
  const rec = await agent(decomposeRecorderPrompt(tasks), roleOpts('scribe', {
    schema: RECORD_SCHEMA, phase: 'Record', label: 'record:tasks.json',
  }));
  log(`decompose complete: ${tasks.length} task(s) written to ${STATE_DIR}/tasks.json (recorded=${rec?.written === true})`);
  return {
    phase: 'plan',
    runId: RUN_ID,
    tasksFile: `${STATE_DIR}/tasks.json`,
    taskCount: tasks.length,
    tasks: tasks.map((t) => ({ id: t.id, title: t.title, depends_on: t.depends_on || [], tests_required: t.tests_required, risk: t.risk })),
    notes: plan?.notes || '',
    nextStep: `Review/edit ${STATE_DIR}/tasks.json, then re-invoke with phase:"run".`,
  };
}

// =============================================================================
// PHASE: run — execute the per-task plan→develop→review→triage loop
// =============================================================================
phase('Load');
const loaded = await agent(loaderPrompt(), roleOpts('scribe', {
  schema: LOADER_SCHEMA, phase: 'Load', label: 'load-plan',
}));
if (loaded?.plan_missing || !(loaded?.tasks || []).length) {
  throw new Error(`No approved task plan at ${STATE_DIR}/tasks.json — run phase:"plan" first, then approve it.`);
}

const allTasks = loaded.tasks;
const doneById = new Map((loaded.done || []).map((d) => [d.id, d.status]));
// Dependency-respecting order: tasks already appear ordered from decomposition; we keep that
// order and simply skip tasks whose recorded status is terminal-done.
// "done" covers all accepted variants: "done", "done (with follow-ups)", "done (residual advisory)".
const isDone = (id) => { const s = String(doneById.get(id) ?? ''); return s.startsWith('done') || s === 'clean'; };
const notDone = allTasks.filter((t) => !isDone(t.id));
// Optional scope: run only an explicit subset of task ids (must be dependency-closed). Lets us
// run "just the first section" without mutating the approved tasks.json.
const runOnly = Array.isArray(A.runOnly) && A.runOnly.length ? A.runOnly : null;
const pending = runOnly ? notDone.filter((t) => runOnly.includes(t.id)) : notDone;
log(`resume: ${allTasks.length - notDone.length}/${allTasks.length} done; ${pending.length} to process${runOnly ? ` (scoped to ${runOnly.length} task[s] via runOnly)` : ''}`);

// One-time baseline prep: fold any pre-existing modified TRACKED files into the staged baseline so
// each task's UNSTAGED diff is purely that task's work (keeps the reviewer's git-diff scope clean).
if (A.prepBaseline !== false && pending.length) {
  const base = await agent(baselinePrompt(), roleOpts('scribe', {
    schema: BASELINE_SCHEMA, phase: 'Load', label: 'baseline-prep',
  }));
  log(`baseline: staged ${(base?.staged_files || []).length} pre-existing file(s); ignoring ${(base?.ignored_untracked || []).length} untracked`);
}

const ledger = [];
let halted = false;
let blockerReason = '';

for (const task of pending) {
  if (halted) break;
  // Budget guard: when the user set a token target (e.g. "+500k"), stop CLEANLY between tasks
  // rather than letting an agent() call throw mid-task. Completed work is recorded; resume re-runs
  // the same args and skips done tasks.
  if (budget.total && budget.remaining() < (A.minTaskBudget ?? 150_000)) {
    log(`⏸ stopping before ${task.id}: ~${Math.round(budget.remaining() / 1000)}k tokens remain (< minTaskBudget) — resume with the same args to continue`);
    break;
  }
  // Guard: a dependency is "satisfied" once it reached a done* status (gate met). A dependency that
  // ended gate-UNMET (functionally broken) is a TRUE blocker — we can't safely build on it.
  const unmetDep = (task.depends_on || []).find((d) => !isDone(d));
  if (unmetDep) {
    halted = true;
    blockerReason = `Task ${task.id} cannot proceed: dependency ${unmetDep} did not reach a gate-met (done) state.`;
    await agent(`You are the SCRIBE. Append a clear entry to ${STATE_DIR}/BLOCKERS.md (create it with a "# Blockers" header if missing) recording that the run halted because: ${blockerReason}. Include what the user should check/fix and that the run can resume after. Do NOT modify source code. Return written=true.`, roleOpts('scribe', {
      schema: RECORD_SCHEMA, phase: 'Triage', label: 'blocker:dependency',
    }));
    log(`✋ BLOCKER: ${blockerReason}`);
    break;
  }

  log(`▶ task ${task.id} — ${task.title}`);
  const record = { id: task.id, title: task.title, status: 'pending', rounds: 0, fixed: 0, tests_added: 0, deferred: 0, needsUser: 0, rejected: 0, regression: false, gates: null };
  const handled = [];          // titles fed back to the reviewer so it won't re-report
  const resolved = new Set();   // finding signatures (file:title) considered done

  // ---- PLAN (+ ad-hoc research loop) ----------------------------------------
  phase('Plan');
  let research = [];
  let plan = null;
  for (let i = 0; i <= MAX_RESEARCH; i++) {
    plan = await agent(planPrompt(task, research), roleOpts('planner', {
      schema: PLAN_SCHEMA, phase: 'Plan', label: i === 0 ? `plan:${task.id}` : `plan:${task.id} r${i}`,
    }));
    const qs = (plan?.research_requests || []).filter(Boolean);
    if (!qs.length || i === MAX_RESEARCH) break;
    log(`  plan: ${qs.length} research question(s) before develop`);
    phase('Research');
    const answers = await parallel(qs.map((q) => () => agent(researchPrompt(q), roleOpts('research', {
      schema: RESEARCH_SCHEMA, phase: 'Research', label: `research:${slug(q).slice(0, 24)}`,
    }))));
    research = research.concat(answers.filter(Boolean));
  }
  if (!plan) { record.status = 'skipped (no plan)'; ledger.push(record); continue; }

  // ---- DEVELOP → REVIEW → TRIAGE loop ---------------------------------------
  let round = 0;
  let devPlan = plan;
  let repair = false;
  while (round < MAX_ROUNDS) {
    round++;
    record.rounds = round;

    phase('Develop');
    const dev = await agent(developPrompt(task, devPlan, repair), roleOpts('develop', {
      schema: DEVELOP_SCHEMA, phase: 'Develop', label: `develop:${task.id} r${round}`,
    }));
    const gx = devPlan.gate_expectation || task.gate_expectation || 'green';
    const needTests = (devPlan.tests_required ?? task.tests_required) === true;
    const gateMet = gateOk(gx, needTests, dev);
    const gateDesc = `${gx}${(devPlan.test_selector || task.test_selector) ? ` (tests: ${devPlan.test_selector || task.test_selector})` : ''} — observed: build=${dev?.build_passed}, test_outcome=${dev?.test_outcome}`;
    if (dev?.tests_written) record.tests_added++;
    record.gates = { expectation: gx, met: gateMet, build: dev?.build_passed ?? null, test_outcome: dev?.test_outcome ?? null };

    // Review the unstaged diff — skipped when the developer produced no changes (an empty diff
    // has nothing to review; the gate outcome alone drives the next round).
    const produced = (dev?.results || []).some((r) => r.status === 'CHANGED' || r.status === 'ADDED');
    let review = null;
    if (produced) {
      phase('Review');
      review = await agent(reviewPrompt(task, handled), roleOpts('review', {
        schema: REVIEW_SCHEMA, phase: 'Review', label: `review:${task.id} r${round}`,
      }));
    } else {
      log(`  review skipped r${round}: developer reported no changed/added files`);
    }
    const findings = (review?.findings || [])
      .filter((f) => (SEV_RANK[f.severity] ?? 1) >= REVIEW_SEV)
      .map((f, i) => ({ id: `${slug(task.id)}-r${round}-${i}`, f }))
      .filter((x) => !resolved.has(`${x.f.file}:${x.f.title}`));

    phase('Triage');
    const isLastRound = round >= MAX_ROUNDS;
    // Happy path (clean review + gate met): a LEAN accept — regression spot-check + stage — on the
    // cheaper review tier. Findings or a missed gate get the full planner triage.
    const lean = findings.length === 0 && gateMet && produced;
    const triage = lean
      ? await agent(acceptPrompt(task, round, gateDesc), roleOpts('review', {
          schema: TRIAGE_SCHEMA, phase: 'Triage', label: `accept:${task.id} r${round}`,
        }))
      : await agent(triagePrompt(task, findings, round, gateMet, gateDesc, dev?.gate_output || '', isLastRound), roleOpts('planner', {
          schema: TRIAGE_SCHEMA, phase: 'Triage', label: `triage:${task.id} r${round}`,
        }));
    if (triage?.regression_found) record.regression = true;

    // Tally + remember terminal routings so the reviewer won't resurface them.
    const byId = new Map(findings.map((x) => [x.id, x]));
    const actionable = [];
    for (const v of triage?.verdicts || []) {
      const item = byId.get(v.finding_id);
      if (v.decision === 'ACTIONABLE') { actionable.push(v); continue; }
      if (item) { resolved.add(`${item.f.file}:${item.f.title}`); handled.push(item.f.title); }
      if (v.decision === 'DEFER') record.deferred++;
      else if (v.decision === 'NEEDS_USER') record.needsUser++;
      else if (v.decision === 'REJECT') record.rejected++;
    }
    if ((triage?.new_tasks || []).length) record.spawnedTasks = (record.spawnedTasks || 0) + triage.new_tasks.length;

    // Hard stop on a true blocker — halt the WHOLE run for user input.
    if (triage?.has_blocker || (triage?.verdicts || []).some((v) => v.blocking)) {
      halted = true;
      blockerReason = triage?.summary || `Blocker raised during ${task.id} round ${round}.`;
      record.status = 'BLOCKED';
      log(`  ✋ BLOCKER during ${task.id} r${round} → halting run (see ${STATE_DIR}/BLOCKERS.md)`);
      break;
    }

    // Accept: the Planner is authoritative — it stages on accept (clean, or last-round-gate-met
    // with residual logged to ADVISORY). Trust triage.accepted, but require the gate to be met.
    if (triage?.accepted === true && gateMet) {
      const residual = (triage.wrote_logs && actionable.length) ? ` (+${actionable.length} residual→ADVISORY)` : '';
      record.status = (record.deferred + record.needsUser > 0) ? 'done (with follow-ups)' : (residual ? 'done (residual advisory)' : 'done');
      record.staged = triage?.staged === true;
      record.fixed += Math.max(0, (triage.verdicts || []).filter((v) => v.decision === 'ACTIONABLE').length - actionable.length);
      log(`  ✓ ${task.id} accepted after ${round} round(s) [gate=${gx} met] (staged=${record.staged}, fixed=${record.fixed}, flagged=${record.needsUser})${residual}`);
      break;
    }

    // Not accepted → next round from the triage's fix-plan.
    record.fixed += actionable.length;
    if (isLastRound) {
      record.status = gateMet ? 'needs-attention (unresolved must-fix)' : 'needs-attention (gate unmet)';
      log(`  ⚠ ${task.id}: round budget (${MAX_ROUNDS}) exhausted — ${actionable.length} item(s) open, gate(${gx}) ${gateMet ? 'met' : 'UNMET'}`);
      break;
    }
    devPlan = triage?.next_fix_plan && (triage.next_fix_plan.steps || []).length
      ? { ...devPlan, steps: triage.next_fix_plan.steps, files: triage.next_fix_plan.files || devPlan.files }
      : { ...devPlan, steps: actionable.map((v) => v.fix_instruction).filter(Boolean) };
    repair = true;
    log(`  ↻ ${task.id} r${round}: ${actionable.length} actionable + gate(${gx}) ${gateMet ? 'met' : 'UNMET'} → repair round`);
  }
  if (record.status === 'pending') record.status = 'needs-attention (loop end)';

  // ---- RECORD (durable per-task; survives kill/resume) ----------------------
  phase('Record');
  const rec = await agent(recorderPrompt(task, record, allTasks.length), roleOpts('scribe', {
    schema: RECORD_SCHEMA, phase: 'Record', label: `record:${task.id}`,
  }));
  record.recorded = rec?.written === true;
  doneById.set(task.id, record.status.startsWith('done') ? 'done' : record.status);
  ledger.push(record);
}

// =============================================================================
// Final completeness sweep — only when EVERY task is done. An independent agent re-derives the
// change surface from the GOAL (grep, full gates, staged-diff spot-check) and reports anything the
// task plan missed to SWEEP.md. This is the "did we actually finish?" check the per-task loop —
// which deliberately never looks beyond its own diff — cannot do. Disable with finalSweep:false.
// =============================================================================
let sweep = null;
if (A.finalSweep !== false && !halted && ledger.length && allTasks.every((t) => isDone(t.id))) {
  phase('Sweep');
  sweep = await agent(sweepPrompt(allTasks.map((t) => t.id)), roleOpts('review', {
    schema: SWEEP_SCHEMA, phase: 'Sweep', label: 'final-sweep',
  }));
  log(sweep?.complete
    ? `sweep: no goal-coverage gaps found (suite: ${sweep?.suite_result || 'n/a'})`
    : `sweep: ${(sweep?.gaps || []).length} potential gap(s) — see ${STATE_DIR}/SWEEP.md`);
}

// =============================================================================
// Result
// =============================================================================
return {
  phase: 'run',
  runId: RUN_ID,
  halted,
  blockerReason: halted ? blockerReason : '',
  stateDir: STATE_DIR,
  sweep: sweep ? { complete: sweep.complete === true, gaps: (sweep.gaps || []).length, suite: sweep.suite_result || '' } : null,
  summary: {
    tasksProcessed: ledger.length,
    done: ledger.filter((r) => r.status.startsWith('done')).length,
    needsAttention: ledger.filter((r) => r.status.startsWith('needs-attention')).length,
    blocked: ledger.filter((r) => r.status === 'BLOCKED').length,
    totalFixed: ledger.reduce((s, r) => s + r.fixed, 0),
    totalTestsAdded: ledger.reduce((s, r) => s + r.tests_added, 0),
    totalDeferred: ledger.reduce((s, r) => s + r.deferred, 0),
    totalNeedsUser: ledger.reduce((s, r) => s + r.needsUser, 0),
    regressions: ledger.filter((r) => r.regression).length,
  },
  ledger,
  followups: halted
    ? `Run halted — see ${STATE_DIR}/BLOCKERS.md. Resolve, then resume with resumeFromRunId.`
    : `Review ${STATE_DIR}/LEDGER.md, ${STATE_DIR}/NEEDS-DECISION.md${sweep && sweep.complete !== true ? `, ${STATE_DIR}/SWEEP.md (coverage gaps!)` : ''}, and the staged diff in ${REPO}.`,
};
