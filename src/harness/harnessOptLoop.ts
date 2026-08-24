/**
 * HarnessOpt optimizer loop — OpenRSI's engine, rewired for the Harbor boundary.
 *
 * Runs INSIDE the Harbor optimizer container as the `main` agent. The mutable
 * artifact is the target agent's Python code at `/work/agent`; scoring is the
 * `evals` sidecar (src/harness/evals.ts). We keep OpenRSI's philosophy — diverse
 * "lever" angles, keep-if-better, think-first — under the bench's rules:
 *   - baseline on the SAME cases before any claim;
 *   - iterate on DEVELOPMENT (full disclosure), SELECT on VALIDATION (aggregate);
 *   - budgets bind on case-passes — verify only the NOMINEE;
 *   - foreground only; end with `evals submit --version <champion>`;
 *   - a broken edit must not ship: a candidate that fails to score reverts.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { Evals, type EvalResult, type PlanEntry } from "./evals.js";
import { logEvent } from "./log.js";

const pexec = promisify(execFile);

/** Harness levers used as diverse proposal angles (breadth correlates with gain). */
export const LEVERS = [
  "system prompt / instructions",
  "control loop & step cap",
  "tool schema & tool surface",
  "retry / timeout policy",
  "answer extraction / output formatting",
  "retrieval / context selection",
  "context management (truncation, memory)",
  "reasoning effort / model params",
] as const;

export interface LoopConfig {
  targetDir: string; // /work/agent
  evals: Evals;
  dev: PlanEntry; // development (full disclosure) — iterate here
  val: PlanEntry; // validation (aggregate) — select here
  model: Model<any>;
  generations: number;
  devSubset: number; // dev cases per iteration (same subset each time)
  reserveValCases: number; // val cases spent on the final confirmation
  thinkingLevel?: "low" | "medium" | "high";
  log: (m: string) => void;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await pexec("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}
async function currentSha(cwd: string): Promise<string> {
  return git(cwd, "rev-parse", "HEAD");
}
async function commitAll(cwd: string, msg: string): Promise<string | null> {
  await git(cwd, "add", "-A");
  if (!(await git(cwd, "status", "--porcelain")).trim()) return null; // no edit produced
  await pexec("git", ["-c", "user.name=openrsi", "-c", "user.email=openrsi@localhost", "commit", "-m", msg], {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
  });
  return currentSha(cwd);
}
async function resetTo(cwd: string, sha: string): Promise<void> {
  await git(cwd, "reset", "--hard", sha);
}

/** Working-tree diff (staged+unstaged) so we can see exactly what a proposer changed. */
async function worktreeDiff(cwd: string): Promise<string> {
  try {
    await git(cwd, "add", "-A", "-N"); // include new files in the diff
    return await git(cwd, "diff", "HEAD");
  } catch {
    return "";
  }
}

/** One think-first proposal: a pi coding-agent edits the target under one lever angle. */
async function propose(cfg: LoopConfig, lever: string, diagnostics: string): Promise<void> {
  const systemPrompt = [
    "You are OpenRSI's harness-optimization proposer. You improve the Python code of a target",
    "agent so it scores higher on a HIDDEN held-out evaluation. Edit files under the current",
    "directory; keep the agent importable and its entry class/interface intact. Prefer a small,",
    "mechanistically-justified change over a rewrite. Think first: state the causal mechanism, the",
    "expected direction of the metric, and what would falsify it — THEN make the edit.",
    "",
    "The current agent may be OUTRIGHT BROKEN (it can fail to run at all — a wrong model string,",
    "a bad request, a crash). A failing evaluation is a signal to DIAGNOSE and FIX the root cause,",
    "not a reason to stop. You have a shell: read the target code, and inspect the read-only",
    "`.evals/` context and traces (`evals cases <id>`, `evals trace <id> <case>`, files under",
    "`.evals/results/`) to see the exact error before editing.",
  ].join("\n");
  const userPrompt = [
    `# Improve the target agent (this round's angle: ${lever})`,
    "",
    "## Current evaluation diagnostics",
    diagnostics || "(no diagnostics yet — read the code and the task resources first)",
    "",
    "If the evaluation is FAILING (errors, not just low score), fixing that failure is the priority",
    "this round regardless of the angle above. Otherwise make ONE focused edit under the angle.",
    "Watch per-case latency: a slower agent can score worse by exceeding a case's wall-clock limit.",
    "Edit in place; do not commit (the loop commits for you).",
  ].join("\n");

  const { session } = await createAgentSession({
    model: cfg.model,
    thinkingLevel: cfg.thinkingLevel ?? "medium",
    systemPrompt,
    cwd: cfg.targetDir,
    sessionManager: SessionManager.inMemory(cfg.targetDir),
  } as any);
  // Capture the FULL session event stream so an investigation can see exactly what
  // the proposer did (or why it did nothing — e.g. a failed model call).
  const events: Array<Record<string, unknown>> = [];
  let tools = 0;
  let modelErr: string | undefined; // an errored model turn ends the loop WITHOUT throwing
  const unsub = session.subscribe((e: any) => {
    const type = e?.type ?? "?";
    if (type === "tool_execution_end") tools++;
    // A failed model call surfaces as an assistant message with stopReason "error"
    // and the text at message.errorMessage — not as a thrown exception. Capture it.
    const stopReason = e?.message?.stopReason ?? e?.stopReason;
    const errText = e?.message?.errorMessage ?? e?.error ?? e?.errorMessage;
    if (stopReason === "error" || stopReason === "aborted") modelErr = String(errText ?? stopReason).slice(0, 600);
    events.push({
      type,
      tool: e?.toolName ?? e?.name,
      stopReason,
      attempt: e?.attempt,
      maxAttempts: e?.maxAttempts,
      error: errText ? String(errText).slice(0, 400) : undefined,
      willRetry: e?.willRetry,
    });
  });
  logEvent("propose.start", { lever, diagnostics: diagnostics.slice(0, 1500) });
  let sessionErr: string | undefined;
  try {
    await session.prompt(userPrompt);
    await session.waitForIdle();
  } catch (e: any) {
    sessionErr = String(e?.stack || e?.message || e).slice(0, 800);
  } finally {
    unsub();
  }
  sessionErr = sessionErr ?? modelErr; // surface a silent errored turn as the proposer failure
  const stats = (session.getSessionStats?.() as any) ?? {};
  const diff = await worktreeDiff(cfg.targetDir);
  logEvent("propose.done", {
    lever,
    tools,
    cost: stats?.cost ?? 0,
    tokens: stats?.tokens ?? stats?.totalTokens,
    sessionError: sessionErr,
    editedChars: diff.length,
    events,
    diff: diff.slice(0, 6000),
  });
}

/** Higher wins; null (unscoreable/broken) is treated as -inf so it never beats the seed. */
function better(a: number | null, b: number | null): boolean {
  return (a ?? -Infinity) > (b ?? -Infinity);
}

export interface LoopResult {
  baselineDev: number | null;
  championSha: string;
  championDev: number | null;
  championVal: number | null;
  accepted: number;
  generations: number;
}

export async function runLoop(cfg: LoopConfig): Promise<LoopResult> {
  const { evals, targetDir, dev, val, log } = cfg;
  const seedSha = await currentSha(targetDir);
  const devSlice = { start: 0, stop: cfg.devSubset };

  logEvent("loop.start", { seedSha, dev, val, devSubset: cfg.devSubset, generations: cfg.generations });
  const baseline = await evals.evaluate(dev, devSlice);
  log(`baseline dev(${cfg.devSubset}) score=${fmt(baseline.score)} cases=${baseline.numCases}${baseline.error ? ` FAILING: ${baseline.error.slice(0, 200)}` : ""}`);
  logEvent("baseline", { score: baseline.score, error: baseline.error, cases: baseline.cases });

  let championSha = seedSha;
  let championDev = baseline.score;
  let championResult: EvalResult = baseline; // diagnostics source; updated on each accept
  let accepted = 0;

  for (let gen = 1; gen <= cfg.generations; gen++) {
    // Stop proposing if the dev case-pass budget can't cover another same-subset compare.
    const devPlan = evals.plan().find((p) => p.partition === dev.partition);
    if (devPlan?.remainingCases != null && devPlan.remainingCases < cfg.devSubset) {
      log(`gen${gen}: dev budget low (${devPlan.remainingCases} < ${cfg.devSubset}) — stop`);
      break;
    }

    const lever = LEVERS[(gen - 1) % LEVERS.length];
    log(`gen${gen}: propose [${lever}] from champion ${championSha.slice(0, 8)}`);
    logEvent("gen.start", { gen, lever, championSha, championDev, remainingDevCases: devPlan?.remainingCases ?? null });
    await resetTo(targetDir, championSha);
    try {
      await propose(cfg, lever, diagnose(championResult));
    } catch (e: any) {
      log(`gen${gen}: proposer error: ${e?.message || e} — skip`);
      logEvent("gen.proposer_error", { gen, error: String(e?.stack || e).slice(0, 600) });
      await resetTo(targetDir, championSha);
      continue;
    }
    const candSha = await commitAll(targetDir, `gen${gen} [${lever}]`);
    if (!candSha) {
      log(`gen${gen}: no edit produced — skip`);
      logEvent("gen.no_edit", { gen });
      continue;
    }

    const cand = await evals.evaluate(dev, devSlice);
    log(`gen${gen}: candidate dev=${fmt(cand.score)} vs champ ${fmt(championDev)}`);
    const won = better(cand.score, championDev);
    logEvent("gen.decision", { gen, candSha, candScore: cand.score, championDev, accepted: won });
    if (won) {
      championSha = candSha;
      championDev = cand.score;
      championResult = cand;
      accepted++;
      log(`gen${gen}: ACCEPT`);
    } else {
      await resetTo(targetDir, championSha);
      log(`gen${gen}: reject — keep champion`);
    }
  }

  // Final confirmation on validation (aggregate). Validation enforces a
  // k-anonymity floor (default 5): a smaller subset is DENIED ("evaluation
  // denied"), so request at least the floor, and skip the confirmation if the
  // partition itself is smaller than the floor.
  await resetTo(targetDir, championSha);
  let championVal: number | null = null;
  const valFloor = Number(process.env.OPENRSI_MIN_VAL_CASES || 5);
  const valStop = Math.min(val.cases ?? Number.MAX_SAFE_INTEGER, Math.max(cfg.reserveValCases, valFloor));
  if ((val.cases ?? 0) >= valFloor) {
    const vr = await evals.evaluate(val, { start: 0, stop: valStop });
    championVal = vr.score;
    log(`champion validation(${valStop})=${fmt(championVal)}${vr.error ? ` (err: ${vr.error.slice(0, 120)})` : ""}`);
  } else {
    log(`skip validation confirm: partition has ${val.cases} cases < k-anon floor ${valFloor}`);
  }
  logEvent("validation", { score: championVal });
  await evals.submit(championSha).then(
    () => { log(`submitted champion ${championSha.slice(0, 8)}`); logEvent("submit", { sha: championSha, ok: true }); },
    (e) => { log(`submit failed: ${e?.message || e}`); logEvent("submit", { sha: championSha, ok: false, error: String(e?.message || e) }); },
  );

  const result = { baselineDev: baseline.score, championSha, championDev, championVal, accepted, generations: cfg.generations };
  logEvent("loop.done", result);
  return result;
}

/** Diagnostics fed to the proposer: a hard failure (with root cause) takes priority over low cases. */
function diagnose(r: EvalResult): string {
  if (r.error) return `The current agent's evaluation is FAILING (fix this first):\n${r.error}`;
  const withErr = r.cases.filter((c) => c.error).slice(0, 6).map((c) => `${c.caseId}: ${c.error}`);
  if (withErr.length) return `Cases with errors:\n${withErr.join("\n")}`;
  const low = r.cases.filter((c) => (c.score ?? 0) <= 0).slice(0, 12).map((c) => c.caseId).filter(Boolean);
  return low.length ? `Failing/low-scoring cases (sample): ${low.join(", ")}` : "(agent runs; look for quality improvements)";
}
function fmt(n: number | null): string {
  return n == null ? "n/a" : n.toFixed(4);
}
