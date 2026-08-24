/**
 * Client for the Harbor optimizer's `evals` CLI (the trusted eval sidecar).
 *
 * Inside the Harbor optimizer container the ONLY way to score a candidate is the
 * `evals` command (see the compiled `instruction.md`): it blocks, scores the
 * current git commit on a partition, and persists the full record under
 * `.evals/results/`. This module is OpenRSI's replacement for the old
 * `AleEvalServer` — same role (submit code, get a score + diagnostics), different
 * boundary (a metered, disclosure-gated sidecar instead of the AtCoder judge).
 *
 * Contract (from harbor/build/templates/instruction.md.j2):
 *   evals run --backend B --evaluation-set S --partition development|validation
 *             [--start N --stop M | --case-id ID ...] [--detach] [--seed N]
 *   evals status                      # remaining budgets + jobs
 *   evals submit                      # nominate the current commit as H+
 *   evals list | show ID | cases ID   # recover persisted results
 *
 * development => FULL per-case + traces; validation => AGGREGATE over >=k cases.
 * Everything foreground: this is a single-shot headless run, so we never --detach
 * and never background a call (a parked long call loses unsubmitted work).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

export type Partition = "development" | "validation";

export interface EvalResult {
  /** Aggregate objective score on the requested cases (the selection signal). */
  score: number | null;
  /** Raw metric map as reported by the sidecar (reward, latency, etc.). */
  metrics: Record<string, number>;
  /** Number of cases actually scored. */
  numCases: number | null;
  /** Per-case rows when disclosure allows (development only); [] on aggregate. */
  cases: Array<{ caseId: string; score: number | null; status?: string }>;
  /** The evals result id, for later `evals show/cases`. */
  resultId: string | null;
  /** Raw stdout, kept for debugging / archival. */
  raw: string;
}

export interface Budget {
  /** Remaining case-passes per partition (the binding budget). */
  remainingCases: Record<string, number>;
  /** Remaining evaluation calls per partition. */
  remainingRuns: Record<string, number>;
  raw: string;
}

export interface EvalsOptions {
  backend: string;
  evaluationSet: string;
  /** `evals` binary (default "evals"; overridable for tests). */
  bin?: string;
  /** Working dir where `.evals/` lives (default process.cwd()). */
  cwd?: string;
  /** Hard cap per call in ms (a real eval can take many minutes — keep generous). */
  timeoutMs?: number;
}

export class Evals {
  private bin: string;
  private cwd: string;
  private timeoutMs: number;
  constructor(private opts: EvalsOptions) {
    this.bin = opts.bin ?? "evals";
    this.cwd = opts.cwd ?? process.cwd();
    this.timeoutMs = opts.timeoutMs ?? 60 * 60 * 1000; // 60 min
  }

  private async run(args: string[]): Promise<string> {
    // maxBuffer generous: a full-disclosure result can be large.
    const { stdout } = await pexec(this.bin, args, {
      cwd: this.cwd,
      timeout: this.timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  }

  /**
   * Score the CURRENT git commit on `partition`. Optionally restrict to a case
   * subset (cheaper iteration) via [start,stop) or explicit caseIds — always the
   * SAME subset across a comparison so case-sampling noise cancels.
   */
  async evaluate(
    partition: Partition,
    subset?: { start?: number; stop?: number; caseIds?: string[]; seed?: number },
  ): Promise<EvalResult> {
    const args = ["run", "--backend", this.opts.backend, "--evaluation-set", this.opts.evaluationSet, "--partition", partition, "--json"];
    if (subset?.start != null) args.push("--start", String(subset.start));
    if (subset?.stop != null) args.push("--stop", String(subset.stop));
    for (const id of subset?.caseIds ?? []) args.push("--case-id", id);
    if (subset?.seed != null) args.push("--seed", String(subset.seed));
    const raw = await this.run(args);
    return parseEvalResult(raw);
  }

  /** Remaining budgets (case-passes bind, not call counts). */
  async status(): Promise<Budget> {
    const raw = await this.run(["status", "--json"]).catch(() => this.run(["status"]));
    return parseBudget(raw);
  }

  /** Nominate the current commit as the shipped candidate H+. Do this deliberately. */
  async submit(): Promise<void> {
    await this.run(["submit"]);
  }
}

/**
 * Parse `evals run --json`. The sidecar's exact JSON shape is validated on the
 * first smoke run; we defensively accept a few key spellings and fall back to
 * scraping a leading number so a schema tweak degrades to "still usable".
 */
export function parseEvalResult(raw: string): EvalResult {
  const j = tryJson(raw);
  if (j) {
    const metrics: Record<string, number> = numericMap(j.metrics ?? j.overall ?? {});
    const score =
      pickNum(j.score, j.objective, j.overall_score, metrics.reward, metrics.score) ?? null;
    const cases = Array.isArray(j.cases ?? j.case_results)
      ? (j.cases ?? j.case_results).map((c: any) => ({
          caseId: String(c.case_id ?? c.id ?? ""),
          score: pickNum(c.score, c.reward, c.absolute_score) ?? null,
          status: c.status ?? c.judge_result,
        }))
      : [];
    return {
      score,
      metrics,
      numCases: pickNum(j.num_cases, j.n_cases, cases.length) ?? (cases.length || null),
      cases,
      resultId: (j.id ?? j.result_id ?? null) as string | null,
      raw,
    };
  }
  // Fallback: last float on stdout.
  const m = raw.match(/(-?\d+\.\d+)(?!.*\d)/s);
  return { score: m ? Number(m[1]) : null, metrics: {}, numCases: null, cases: [], resultId: null, raw };
}

export function parseBudget(raw: string): Budget {
  const j = tryJson(raw);
  const remainingCases: Record<string, number> = {};
  const remainingRuns: Record<string, number> = {};
  if (j) {
    for (const p of ["development", "validation"]) {
      const b = j[p] ?? j.budgets?.[p];
      if (b) {
        if (b.remaining_cases != null) remainingCases[p] = Number(b.remaining_cases);
        if (b.remaining_runs != null) remainingRuns[p] = Number(b.remaining_runs);
      }
    }
  }
  return { remainingCases, remainingRuns, raw };
}

function tryJson(s: string): any | null {
  const t = s.trim();
  // tolerate leading log lines before a JSON object/array
  const start = t.search(/[[{]/);
  if (start < 0) return null;
  try {
    return JSON.parse(t.slice(start));
  } catch {
    return null;
  }
}
function numericMap(o: any): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(o ?? {})) if (typeof v === "number") out[k] = v;
  return out;
}
function pickNum(...vals: any[]): number | undefined {
  for (const v of vals) if (typeof v === "number" && Number.isFinite(v)) return v;
  return undefined;
}
