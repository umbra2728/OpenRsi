/**
 * HarnessOpt optimizer loop — OpenRSI's engine, rewired for the Harbor boundary.
 *
 * Runs INSIDE the Harbor optimizer container as the `main` agent. The mutable
 * artifact is the target agent's Python code at `/work/agent`; scoring is the
 * `evals` sidecar (src/harness/evals.ts). We keep OpenRSI's philosophy — diverse
 * "lever" angles, keep-if-better, think-first — under the bench's rules, and add
 * a statistically defensible selection procedure so a nominated candidate is a
 * confirmed improvement rather than a lucky small-sample draw:
 *
 *   - iterate on DEVELOPMENT (full disclosure) with cheap K=1 screens;
 *   - a MARGINAL screen win (<= one case) requires a PAIRED RE-CHECK on a fresh
 *     dev slice before it can become champion — this kills winner's-curse flips;
 *   - keep the best distinct accepted candidates as FINALISTS;
 *   - SELECT on a validation panel: seed + every finalist scored on the SAME
 *     cases; the winner is the best, and the seed is a legitimate finalist;
 *   - CONFIRM the winner against the seed on a FRESH, disjoint validation panel;
 *   - SUBMIT the winner only if it beats the seed on confirmation; otherwise
 *     submit the seed (the seed is a valid nomination);
 *   - every evaluation is stamped with a protocol STAGE and recorded in a
 *     reconciliation ledger so the sidecar database can be audited against
 *     OpenRSI's declared intent;
 *   - foreground only; end with `evals submit --version <nominee>`;
 *   - a broken edit must not ship: a candidate that fails to score reverts.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { Evals, EvalResult, PlanEntry } from "./evals.js";
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
  val: PlanEntry; // validation (aggregate) — select + confirm here
  model: Model<any>;
  generations: number;
  devSubset: number; // dev cases per screen (a fixed window each time)
  reserveValCases: number; // legacy knob: min cases for the confirmation panel
  thinkingLevel?: "low" | "medium" | "high";
  log: (m: string) => void;
  // Selection knobs (env-overridable; see runHarnessOpt.ts).
  finalists?: number; // max distinct finalists carried to validation (default 3)
  valSelectCases?: number | null; // selection-panel size (auto when null)
  valConfirmCases?: number | null; // confirmation-panel size (auto when null)
  confirmAttempts?: number; // repeats per artifact on the confirmation panel (default 2)
  confirmMargin?: number; // winner must beat seed by > this on confirm (default 0)
  minValCases?: number; // k-anonymity floor for a validation panel (default 5)
  pairedRecheck?: boolean; // require a second dev draw for a marginal win (default true)
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await pexec("git", args, {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}
async function currentSha(cwd: string): Promise<string> {
  return git(cwd, "rev-parse", "HEAD");
}
async function commitAll(cwd: string, msg: string): Promise<string | null> {
  await git(cwd, "add", "-A");
  if (!(await git(cwd, "status", "--porcelain")).trim()) return null; // no edit produced
  await pexec(
    "git",
    [
      "-c",
      "user.name=openrsi",
      "-c",
      "user.email=openrsi@localhost",
      "commit",
      "-m",
      msg,
    ],
    {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
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
async function propose(
  cfg: LoopConfig,
  lever: string,
  diagnostics: string,
): Promise<void> {
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
    "",
    "INFERENCE ROUTE CONTRACT (important): the target talks to an OpenAI-compatible gateway that",
    "does NOT provide server-side Responses state. Do NOT rely on `previous_response_id`",
    "continuation. Use Chat Completions with full client-held history, or a stateless Responses",
    "call that replays the complete transcript every turn. A candidate that chains turns via a",
    "non-null `previous_response_id` will fail on this route.",
  ].join("\n");
  const userPrompt = [
    `# Improve the target agent (this round's angle: ${lever})`,
    "",
    "## Current evaluation diagnostics",
    diagnostics ||
      "(no diagnostics yet — read the code and the task resources first)",
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
    if (stopReason === "error" || stopReason === "aborted")
      modelErr = String(errText ?? stopReason).slice(0, 600);
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
function num(a: number | null): number {
  return a ?? -Infinity;
}
function better(a: number | null, b: number | null): boolean {
  return num(a) > num(b);
}

/** A distinct accepted candidate carried forward to validation selection. */
interface Finalist {
  sha: string;
  devScore: number | null;
  label: string;
}

/** One entry in the reconciliation ledger: every eval maps to a declared stage. */
interface LedgerEntry {
  stage: string;
  sha: string;
  partition: string;
  subset: { start?: number; stop?: number } | null;
  score: number | null;
  evaluationId: string | null;
  error?: string;
}

export interface LoopResult {
  baselineDev: number | null;
  seedSha: string;
  nomineeSha: string;
  nomineeIsSeed: boolean;
  championDev: number | null;
  finalists: Array<{ sha: string; devScore: number | null }>;
  selection: Array<{
    sha: string;
    score: number | null;
    isSeed: boolean;
  }> | null;
  confirmation: {
    seed: number | null;
    winner: number | null;
    winnerSha: string;
    passed: boolean;
  } | null;
  accepted: number;
  generations: number;
}

export async function runLoop(cfg: LoopConfig): Promise<LoopResult> {
  const { evals, targetDir, dev, val, log } = cfg;
  const finalistsCap = Math.max(1, cfg.finalists ?? 3);
  const confirmAttempts = Math.max(1, cfg.confirmAttempts ?? 2);
  const confirmMargin = Math.max(0, cfg.confirmMargin ?? 0);
  const valFloor = Math.max(1, cfg.minValCases ?? 5);
  const pairedRecheck = cfg.pairedRecheck ?? true;
  const oneCase = cfg.devSubset > 0 ? 1 / cfg.devSubset : 1; // a single-case screen flip

  const ledger: LedgerEntry[] = [];
  const record = (
    stage: string,
    sha: string,
    entry: PlanEntry,
    subset: { start?: number; stop?: number } | null,
    r: EvalResult,
  ) => {
    ledger.push({
      stage,
      sha,
      partition: entry.partition,
      subset,
      score: r.score,
      evaluationId: r.evaluationId,
      error: r.error,
    });
  };

  const seedSha = await currentSha(targetDir);
  const devScreen = { start: 0, stop: cfg.devSubset };
  // A second, disjoint dev window for paired re-checks; falls back to the same
  // window (still an independent stochastic draw) when dev is too small.
  const devCases = dev.cases ?? cfg.devSubset;
  const recheckSlice =
    devCases >= 2 * cfg.devSubset
      ? { start: cfg.devSubset, stop: 2 * cfg.devSubset }
      : { start: 0, stop: cfg.devSubset };

  logEvent("loop.start", {
    seedSha,
    dev,
    val,
    devSubset: cfg.devSubset,
    generations: cfg.generations,
    finalistsCap,
    confirmAttempts,
    confirmMargin,
    valFloor,
    pairedRecheck,
  });
  const baseline = await evals.evaluate(dev, devScreen, "seed-dev-screen");
  record("seed-dev-screen", seedSha, dev, devScreen, baseline);
  log(
    `baseline dev(${cfg.devSubset}) score=${fmt(baseline.score)} cases=${baseline.numCases}${baseline.error ? ` FAILING: ${baseline.error.slice(0, 200)}` : ""}`,
  );
  logEvent("baseline", {
    score: baseline.score,
    error: baseline.error,
    cases: baseline.cases,
  });

  let championSha = seedSha;
  let championDev = baseline.score;
  let championResult: EvalResult = baseline; // diagnostics source; updated on each accept
  let accepted = 0;
  // Finalists are distinct accepted candidates (never the seed). The seed enters
  // the selection stage separately as a legitimate nomination.
  const finalists: Finalist[] = [];

  const addFinalist = (f: Finalist) => {
    finalists.push(f);
    finalists.sort((a, b) => num(b.devScore) - num(a.devScore));
    if (finalists.length > finalistsCap) finalists.length = finalistsCap;
  };

  for (let gen = 1; gen <= cfg.generations; gen++) {
    // Stop proposing if the dev case-pass budget can't cover another screen
    // (plus a possible paired re-check).
    const devPlan = evals.plan().find((p) => p.partition === dev.partition);
    const needCases = cfg.devSubset * (pairedRecheck ? 2 : 1);
    if (devPlan?.remainingCases != null && devPlan.remainingCases < needCases) {
      log(
        `gen${gen}: dev budget low (${devPlan.remainingCases} < ${needCases}) — stop`,
      );
      break;
    }

    const lever = LEVERS[(gen - 1) % LEVERS.length];
    log(
      `gen${gen}: propose [${lever}] from champion ${championSha.slice(0, 8)}`,
    );
    logEvent("gen.start", {
      gen,
      lever,
      championSha,
      championDev,
      remainingDevCases: devPlan?.remainingCases ?? null,
    });
    await resetTo(targetDir, championSha);
    try {
      await propose(cfg, lever, diagnose(championResult));
    } catch (e: any) {
      log(`gen${gen}: proposer error: ${e?.message || e} — skip`);
      logEvent("gen.proposer_error", {
        gen,
        error: String(e?.stack || e).slice(0, 600),
      });
      await resetTo(targetDir, championSha);
      continue;
    }
    const candSha = await commitAll(targetDir, `gen${gen} [${lever}]`);
    if (!candSha) {
      log(`gen${gen}: no edit produced — skip`);
      logEvent("gen.no_edit", { gen });
      continue;
    }

    const cand = await evals.evaluate(dev, devScreen, "cand-dev-screen");
    record("cand-dev-screen", candSha, dev, devScreen, cand);
    const screenWon = better(cand.score, championDev);
    const margin = num(cand.score) - num(championDev);
    const marginal = screenWon && margin <= oneCase * 1.0001; // <= one case flip
    log(
      `gen${gen}: candidate dev=${fmt(cand.score)} vs champ ${fmt(championDev)} (Δ=${margin.toFixed(4)}${marginal ? ", marginal" : ""})`,
    );

    let accept = screenWon;
    if (screenWon && marginal && pairedRecheck) {
      // Winner's-curse guard: re-evaluate BOTH champion and candidate on a fresh
      // dev slice and accept only if the candidate wins on the pooled two draws.
      log(
        `gen${gen}: marginal win — paired re-check on dev[${recheckSlice.start},${recheckSlice.stop})`,
      );
      await resetTo(targetDir, championSha);
      const champR = await evals.evaluate(
        dev,
        recheckSlice,
        "champ-dev-recheck",
      );
      record("champ-dev-recheck", championSha, dev, recheckSlice, champR);
      await resetTo(targetDir, candSha);
      const candR = await evals.evaluate(dev, recheckSlice, "cand-dev-recheck");
      record("cand-dev-recheck", candSha, dev, recheckSlice, candR);
      const candPooled = num(cand.score) + num(candR.score);
      const champPooled = num(championDev) + num(champR.score);
      accept = candPooled > champPooled;
      log(
        `gen${gen}: re-check champ=${fmt(champR.score)} cand=${fmt(candR.score)} → pooled ${candPooled.toFixed(4)} vs ${champPooled.toFixed(4)} → ${accept ? "confirm" : "reject"}`,
      );
      logEvent("gen.recheck", {
        gen,
        candSha,
        candScreen: cand.score,
        candRecheck: candR.score,
        champScreen: championDev,
        champRecheck: champR.score,
        accept,
      });
    }

    logEvent("gen.decision", {
      gen,
      candSha,
      candScore: cand.score,
      championDev,
      marginal,
      accepted: accept,
    });
    if (accept) {
      championSha = candSha;
      championDev = cand.score;
      championResult = cand;
      accepted++;
      addFinalist({
        sha: candSha,
        devScore: cand.score,
        label: `gen${gen} [${lever}]`,
      });
      log(
        `gen${gen}: ACCEPT (champion=${candSha.slice(0, 8)}, finalists=${finalists.length})`,
      );
    } else {
      await resetTo(targetDir, championSha);
      log(`gen${gen}: reject — keep champion ${championSha.slice(0, 8)}`);
    }
  }

  // ---- Validation: SELECT then CONFIRM -------------------------------------
  // Panels are DISJOINT case ranges so selection cannot leak into confirmation.
  // The seed is a legitimate nomination and is scored alongside every finalist.
  const valTotal = val.cases ?? 0;
  const plan = evals.plan().find((p) => p.partition === val.partition);
  const remainingVal = plan?.remainingCases ?? Number.MAX_SAFE_INTEGER;

  const panels = planValidationPanels({
    valTotal,
    remainingVal,
    nFinalists: finalists.length,
    confirmAttempts,
    valFloor,
    reserveValCases: cfg.reserveValCases,
    selCasesReq: cfg.valSelectCases ?? null,
    confCasesReq: cfg.valConfirmCases ?? null,
  });
  logEvent("validation.plan", {
    valTotal,
    remainingVal,
    finalists: finalists.map((f) => ({ sha: f.sha, devScore: f.devScore })),
    panels,
  });

  let selection: LoopResult["selection"] = null;
  let confirmation: LoopResult["confirmation"] = null;
  let nomineeSha = seedSha; // safe default: the seed is a valid nomination

  if (panels) {
    const { selCases, confCases } = panels;
    const selSlice = { start: 0, stop: selCases };
    // Score the seed + each finalist on the SAME selection cases.
    const contenders: Array<{ sha: string; isSeed: boolean; label: string }> = [
      { sha: seedSha, isSeed: true, label: "seed" },
      ...finalists.map((f) => ({ sha: f.sha, isSeed: false, label: f.label })),
    ];
    const sel: Array<{ sha: string; score: number | null; isSeed: boolean }> =
      [];
    for (const c of contenders) {
      await resetTo(targetDir, c.sha);
      const r = await evals.evaluate(val, selSlice, "val-select");
      record("val-select", c.sha, val, selSlice, r);
      sel.push({ sha: c.sha, score: r.score, isSeed: c.isSeed });
      log(
        `val-select(${selCases}) ${c.label} ${c.sha.slice(0, 8)} = ${fmt(r.score)}${r.error ? ` (err: ${r.error.slice(0, 100)})` : ""}`,
      );
    }
    selection = sel;

    // Winner = highest selection score; ties and any non-improvement over the
    // seed resolve to the seed (a candidate must earn the nomination).
    const seedSel = sel.find((s) => s.isSeed)!;
    let winner = seedSel;
    for (const s of sel) {
      if (!s.isSeed && num(s.score) > num(winner.score)) winner = s;
    }
    const winnerBeatsSeedOnSelect =
      !winner.isSeed && num(winner.score) > num(seedSel.score);
    logEvent("validation.select", {
      winnerSha: winner.sha,
      winnerIsSeed: winner.isSeed,
      seedScore: seedSel.score,
      winnerScore: winner.score,
      winnerBeatsSeedOnSelect,
    });

    if (!winnerBeatsSeedOnSelect) {
      log(
        `val-select: no finalist beat the seed (${fmt(seedSel.score)}) — nominate SEED`,
      );
      nomineeSha = seedSha;
    } else if (confCases <= 0) {
      // No room for a fresh confirmation panel: fall back to the selection winner
      // but flag it as unconfirmed.
      log(
        `val-confirm: no fresh panel available — nominate selection winner ${winner.sha.slice(0, 8)} (UNCONFIRMED)`,
      );
      logEvent("validation.confirm_skipped", {
        reason: "no-confirmation-panel",
        winnerSha: winner.sha,
      });
      nomineeSha = winner.sha;
    } else {
      // Confirm the winner against the seed on a FRESH, disjoint panel, averaging
      // `confirmAttempts` independent draws each.
      const confSlice = { start: selCases, stop: selCases + confCases };
      const seedConf = await confirmMean(
        cfg,
        evals,
        seedSha,
        val,
        confSlice,
        confirmAttempts,
        "val-confirm-seed",
        record,
      );
      const winnerConf = await confirmMean(
        cfg,
        evals,
        winner.sha,
        val,
        confSlice,
        confirmAttempts,
        "val-confirm-winner",
        record,
      );
      const passed = num(winnerConf) > num(seedConf) + confirmMargin;
      confirmation = {
        seed: seedConf,
        winner: winnerConf,
        winnerSha: winner.sha,
        passed,
      };
      log(
        `val-confirm(${confCases}×${confirmAttempts}) seed=${fmt(seedConf)} winner=${fmt(winnerConf)} margin>${confirmMargin} → ${passed ? "PASS (nominate winner)" : "FAIL (nominate seed)"}`,
      );
      logEvent("validation.confirm", {
        seedConf,
        winnerConf,
        confirmMargin,
        passed,
        winnerSha: winner.sha,
      });
      nomineeSha = passed ? winner.sha : seedSha;
    }
  } else {
    log(
      `validation: cannot fit a k-anon panel (floor ${valFloor}, val ${valTotal}, remaining ${remainingVal}) — nominate SEED`,
    );
    logEvent("validation.skip", {
      reason: "insufficient-validation-budget",
      valTotal,
      remainingVal,
      valFloor,
    });
  }

  const nomineeIsSeed = nomineeSha === seedSha;
  await resetTo(targetDir, nomineeSha);
  await evals.submit(nomineeSha).then(
    () => {
      log(
        `submitted nominee ${nomineeSha.slice(0, 8)}${nomineeIsSeed ? " (SEED)" : ""}`,
      );
      logEvent("submit", { sha: nomineeSha, isSeed: nomineeIsSeed, ok: true });
    },
    (e) => {
      log(`submit failed: ${e?.message || e}`);
      logEvent("submit", {
        sha: nomineeSha,
        ok: false,
        error: String(e?.message || e),
      });
    },
  );

  // The reconciliation ledger: the sidecar DB is canonical, but this records the
  // STAGE OpenRSI intended for every evaluation it issued, so an audit can flag
  // any sidecar evaluation that OpenRSI cannot account for (e.g. a proposer that
  // launched `evals run` from its shell outside the loop).
  logEvent("reconciliation", {
    total: ledger.length,
    byStage: countByStage(ledger),
    ledger,
  });

  const result: LoopResult = {
    baselineDev: baseline.score,
    seedSha,
    nomineeSha,
    nomineeIsSeed,
    championDev,
    finalists: finalists.map((f) => ({ sha: f.sha, devScore: f.devScore })),
    selection,
    confirmation,
    accepted,
    generations: cfg.generations,
  };
  // SAFETY: LoopResult is a plain JSON-serialisable record; logEvent only reads
  // its enumerable keys. The cast is needed because LoopResult has no index
  // signature, not because any non-record value is passed.
  logEvent("loop.done", result as unknown as Record<string, unknown>);
  return result;
}

/** Average of `attempts` independent evaluations of `sha` on `slice`. */
async function confirmMean(
  cfg: LoopConfig,
  evals: Evals,
  sha: string,
  entry: PlanEntry,
  slice: { start: number; stop: number },
  attempts: number,
  stage: string,
  record: (
    stage: string,
    sha: string,
    entry: PlanEntry,
    subset: { start?: number; stop?: number } | null,
    r: EvalResult,
  ) => void,
): Promise<number | null> {
  await resetTo(cfg.targetDir, sha);
  const scores: number[] = [];
  for (let i = 0; i < attempts; i++) {
    const r = await evals.evaluate(entry, slice, `${stage}#${i + 1}`);
    record(`${stage}#${i + 1}`, sha, entry, slice, r);
    if (typeof r.score === "number" && Number.isFinite(r.score))
      scores.push(r.score);
  }
  if (!scores.length) return null;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

/**
 * Choose disjoint selection/confirmation panel sizes under two constraints:
 *   - case RANGES are disjoint: selCases + confCases <= valTotal;
 *   - case-PASS budget: (nFinalists+1)*selCases + attempts*2*confCases <= remainingVal;
 *   - each panel >= the k-anonymity floor.
 * Returns null when even a floor-sized selection panel cannot be afforded.
 */
export function planValidationPanels(opts: {
  valTotal: number;
  remainingVal: number;
  nFinalists: number;
  confirmAttempts: number;
  valFloor: number;
  reserveValCases: number;
  selCasesReq: number | null;
  confCasesReq: number | null;
}): { selCases: number; confCases: number } | null {
  const { valTotal, remainingVal, nFinalists, confirmAttempts, valFloor } =
    opts;
  if (valTotal < valFloor) return null;

  const selContenders = nFinalists + 1; // seed + finalists
  const half = Math.floor(valTotal / 2);

  // Preferred selection panel: explicit request, else half the partition, but at
  // least the floor and at most valTotal - floor (leave room for confirmation).
  let selCases =
    opts.selCasesReq ?? Math.max(valFloor, Math.min(half, valTotal - valFloor));
  selCases = Math.max(
    valFloor,
    Math.min(
      selCases,
      valTotal - valFloor >= valFloor ? valTotal - valFloor : valTotal,
    ),
  );

  // Preferred confirmation panel: explicit request, else the remaining disjoint
  // cases, at least the reserve/floor.
  const reserve = Math.max(valFloor, opts.reserveValCases || 0);
  let confCases =
    opts.confCasesReq ?? Math.max(reserve, Math.min(valTotal - selCases, half));
  confCases = Math.min(confCases, valTotal - selCases);
  if (confCases < valFloor)
    confCases = valTotal - selCases >= valFloor ? valFloor : 0;

  // Enforce the case-pass budget; shrink panels toward the floor if needed.
  const passesNeeded = () =>
    selContenders * selCases + confirmAttempts * 2 * confCases;
  let guard = 0;
  while (passesNeeded() > remainingVal && guard++ < 10000) {
    if (confCases > valFloor) confCases -= 1;
    else if (selCases > valFloor) selCases -= 1;
    else break;
  }
  if (selContenders * selCases > remainingVal) return null; // cannot even select at floor
  if (selCases < valFloor) return null;
  // Confirmation may be dropped (confCases 0) if it does not fit; selection alone
  // still gives a defensible, if weaker, nomination.
  if (confCases > 0 && confCases < valFloor) confCases = 0;
  if (confCases > 0 && passesNeeded() > remainingVal) confCases = 0;
  return { selCases, confCases };
}

function countByStage(ledger: LedgerEntry[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const e of ledger) m[e.stage] = (m[e.stage] ?? 0) + 1;
  return m;
}

/** Diagnostics fed to the proposer: a hard failure (with root cause) takes priority over low cases. */
function diagnose(r: EvalResult): string {
  if (r.error)
    return `The current agent's evaluation is FAILING (fix this first):\n${r.error}`;
  const withErr = r.cases
    .filter((c) => c.error)
    .slice(0, 6)
    .map((c) => `${c.caseId}: ${c.error}`);
  if (withErr.length) return `Cases with errors:\n${withErr.join("\n")}`;
  const low = r.cases
    .filter((c) => (c.score ?? 0) <= 0)
    .slice(0, 12)
    .map((c) => c.caseId)
    .filter(Boolean);
  return low.length
    ? `Failing/low-scoring cases (sample): ${low.join(", ")}`
    : "(agent runs; look for quality improvements)";
}
function fmt(n: number | null): string {
  return n == null ? "n/a" : n.toFixed(4);
}
