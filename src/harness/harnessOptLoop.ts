/**
 * HarnessOpt optimizer loop — OpenRSI's engine, rewired for the Harbor boundary.
 *
 * Runs INSIDE the Harbor optimizer container as the `main` agent. The mutable
 * artifact is the target agent's Python code at `/work/agent` (NOT a JSON
 * scaffold); scoring is the `evals` sidecar (NOT the AtCoder judge); fitness is
 * the task's own reward on held-out cases (normalized gain is computed by VeRO at
 * finalization). We keep OpenRSI's philosophy — think-first proposals, diverse
 * "lever" angles, keep-if-better, optional memory — under the bench's rules:
 *
 *   - baseline on the SAME cases before any claim;
 *   - iterate on DEVELOPMENT (full disclosure), SELECT on VALIDATION (aggregate);
 *   - budgets bind on case-passes (4 per partition) — verify only the NOMINEE;
 *   - foreground only, no backgrounding; end with `evals submit`;
 *   - a broken edit must not ship: a candidate that fails to import/score reverts.
 *
 * This is a v0 wired to the documented interfaces; the first (cheap) smoke run
 * validates the gateway routing and the `evals --json` shapes (see evals.ts).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { Evals, type EvalResult } from "./evals.js";

const pexec = promisify(execFile);

/** The eight OpenficeQA-derived harness levers; used as diverse proposal angles. */
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
  model: Model<any>;
  generations: number; // OPENRSI_GENERATIONS
  devSubset: number; // cases per dev iteration (cheap signal)
  minValCases: number; // k-anonymity floor for validation aggregate
  reserveValCalls: number; // keep this many val case-passes for final confirm
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
  // Nothing staged => no candidate produced this round.
  const status = await git(cwd, "status", "--porcelain");
  if (!status.trim()) return null;
  await pexec("git", ["-c", "user.name=openrsi", "-c", "user.email=openrsi@localhost", "commit", "-m", msg], {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
  });
  return currentSha(cwd);
}

async function resetTo(cwd: string, sha: string): Promise<void> {
  await git(cwd, "reset", "--hard", sha);
}

/** One think-first proposal: a pi coding-agent edits the target under one lever angle. */
async function propose(cfg: LoopConfig, lever: string, diagnostics: string, memory: string): Promise<void> {
  const systemPrompt = [
    "You are OpenRSI's harness-optimization proposer. You improve the Python code of a target",
    "agent so it scores higher on a HIDDEN held-out evaluation. You may edit files under the",
    "current directory and must keep the agent importable and runnable (do not change its entry",
    "class path or break its interface). Prefer a small, mechanistically-justified change over a",
    "large rewrite. Think first: state the causal mechanism, the expected direction of the metric,",
    "and what result would falsify it — THEN make the edit.",
    memory,
  ].join("\n");

  const userPrompt = [
    `# Improve the target agent (this round's angle: ${lever})`,
    "",
    "## What the current agent gets wrong (development diagnostics)",
    diagnostics || "(no diagnostics yet — read the code and the task first)",
    "",
    "Make ONE focused edit under the angle above. Keep per-case latency in mind: a slower agent can",
    "score worse by pushing cases past their wall-clock limit. Edit the files in place; do not commit",
    "(the loop commits for you). When done, briefly state mechanism / expected-delta / falsification.",
  ].join("\n");

  const { session } = await createAgentSession({
    model: cfg.model,
    thinkingLevel: cfg.thinkingLevel ?? "medium",
    systemPrompt,
    cwd: cfg.targetDir,
    sessionManager: SessionManager.inMemory(cfg.targetDir),
  } as any);
  await session.prompt(userPrompt);
  await session.waitForIdle();
}

/** Higher score wins; treat null as -inf so a broken candidate never beats the seed. */
function better(a: number | null, b: number | null): boolean {
  return (a ?? -Infinity) > (b ?? -Infinity);
}

export interface LoopResult {
  baselineDev: EvalResult;
  championSha: string;
  championVal: number | null;
  generations: number;
  accepted: number;
}

export async function runLoop(cfg: LoopConfig): Promise<LoopResult> {
  const { evals, targetDir, log } = cfg;
  const seedSha = await currentSha(targetDir);

  // Baseline on a fixed dev subset (same cases we will compare candidates on).
  const devSlice = { start: 0, stop: cfg.devSubset };
  const baselineDev = await evals.evaluate("development", devSlice);
  log(`baseline dev(${cfg.devSubset}) score=${fmt(baselineDev.score)} cases=${baselineDev.numCases}`);

  let championSha = seedSha;
  let championDev = baselineDev.score;
  let accepted = 0;

  for (let gen = 1; gen <= cfg.generations; gen++) {
    // Stop proposing if the dev budget can't cover another same-subset comparison.
    const budget = await evals.status().catch(() => null);
    const remDev = budget?.remainingCases["development"];
    if (remDev != null && remDev < cfg.devSubset) {
      log(`gen${gen}: dev budget low (${remDev} < ${cfg.devSubset}) — stop proposing`);
      break;
    }

    const lever = LEVERS[(gen - 1) % LEVERS.length];
    const diagnostics = summarizeCases(baselineDev); // v0: seed diagnostics; refine with champion's later
    log(`gen${gen}: propose [${lever}] on champion ${championSha.slice(0, 8)}`);

    await resetTo(targetDir, championSha); // branch from the champion
    try {
      await propose(cfg, lever, diagnostics, "");
    } catch (e: any) {
      log(`gen${gen}: proposer error: ${e?.message || e} — skip`);
      await resetTo(targetDir, championSha);
      continue;
    }
    const candSha = await commitAll(targetDir, `gen${gen} [${lever}]`);
    if (!candSha) {
      log(`gen${gen}: no edit produced — skip`);
      continue;
    }

    // Evaluate the candidate on the SAME dev subset.
    let candDev: EvalResult;
    try {
      candDev = await evals.evaluate("development", devSlice);
    } catch (e: any) {
      log(`gen${gen}: eval error (${e?.message || e}) — revert candidate`);
      await resetTo(targetDir, championSha);
      continue;
    }
    log(`gen${gen}: candidate dev=${fmt(candDev.score)} vs champ ${fmt(championDev)}`);

    if (better(candDev.score, championDev)) {
      championSha = candSha;
      championDev = candDev.score;
      accepted++;
      log(`gen${gen}: ACCEPT (dev ${fmt(candDev.score)})`);
    } else {
      await resetTo(targetDir, championSha);
      log(`gen${gen}: reject — keep champion ${championSha.slice(0, 8)}`);
    }
  }

  // Final confirmation on VALIDATION (aggregate, >= k cases), champion vs seed,
  // spending the reserved validation budget. Only then submit.
  await resetTo(targetDir, championSha);
  let championVal: number | null = null;
  try {
    const valSlice = { start: 0, stop: Math.max(cfg.minValCases, cfg.reserveValCalls) };
    const champVal = await evals.evaluate("validation", valSlice);
    championVal = champVal.score;
    log(`champion validation=${fmt(championVal)}`);
  } catch (e: any) {
    log(`validation confirm failed: ${e?.message || e}`);
  }

  // Deliberate submit of the champion commit (never rely on auto-best).
  await evals.submit().then(
    () => log(`submitted champion ${championSha.slice(0, 8)}`),
    (e) => log(`submit failed: ${e?.message || e}`),
  );

  return { baselineDev, championSha, championVal, generations: cfg.generations, accepted };
}

function summarizeCases(r: EvalResult): string {
  if (!r.cases.length) return "";
  const fails = r.cases.filter((c) => (c.score ?? 0) <= 0).slice(0, 12);
  return fails.length ? `Failing/low cases (sample): ${fails.map((c) => c.caseId).join(", ")}` : "";
}
function fmt(n: number | null): string {
  return n == null ? "n/a" : n.toFixed(4);
}
