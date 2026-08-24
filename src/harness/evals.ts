/**
 * Client for the Harbor optimizer's `evals` sidecar CLI (vero.evals_cli), OpenRSI's
 * replacement for the old AtCoder AleEvalServer. Grounded in the real CLI + the
 * on-disk `.evals/` schema (vero/src/vero/evals_cli.py), not guessed:
 *
 *   evals run --backend B --evaluation-set S --partition P [--start N --stop M | --case-id ID]
 *   evals submit --version COMMIT
 *
 * `run` BLOCKS, prints a summary, and persists the full record under
 * `.evals/results/`. There is NO `--json` on `run`; we therefore read the score
 * back from the persisted JSON (authoritative) rather than scraping stdout.
 *
 * `.evals/` layout (context dir = $VERO_CONTEXT_PATH, else the nearest ancestor
 * holding `.evals/manifest.json`):
 *   plan.json      -> {evaluations:[{name,partition,backend,cases,disclosure,
 *                                     agent_can_evaluate,budget:{remaining_runs,remaining_cases}}]}
 *   results/index.json -> {evaluations:[{evaluation_id,partition,path,...}]}
 *   results/<path>     -> {result:{objective:{value}|metrics:{score}|report:{metrics:{score}},
 *                                  case_files:[{path}],total_cases,...}}
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { logEvent } from "./log.js";

const pexec = promisify(execFile);

export interface PlanEntry {
  name: string; // evaluation-set name (e.g. "gaia", "conformance")
  partition: string; // development | validation | test
  backend: string;
  cases: number | null;
  disclosure: string; // full | aggregate | withheld
  canEvaluate: boolean;
  remainingRuns: number | null;
  remainingCases: number | null;
}

export interface EvalResult {
  score: number | null; // null = the evaluation itself failed (target errored / eval infra 502)
  numCases: number | null;
  cases: Array<{ caseId: string; score: number | null; status?: string; error?: string }>;
  evaluationId: string | null;
  /** Present when the eval failed: the CLI error plus any per-case root cause (e.g. model_denied). */
  error?: string;
  raw: string;
}

export class Evals {
  private bin: string;
  private cwd: string;
  private context: string;
  private timeoutMs: number;

  constructor(opts: { cwd?: string; bin?: string; timeoutMs?: number; context?: string } = {}) {
    this.bin = opts.bin ?? "evals";
    this.cwd = opts.cwd ?? process.cwd();
    this.timeoutMs = opts.timeoutMs ?? 60 * 60 * 1000; // 60 min; a real eval can take many minutes
    this.context = opts.context ?? resolveContext(this.cwd);
  }

  get contextDir(): string {
    return this.context;
  }

  private async exec(args: string[]): Promise<string> {
    const { stdout } = await pexec(this.bin, args, {
      cwd: this.cwd,
      timeout: this.timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  }

  /** The evaluations the optimizer may run, with per-partition backend + budget. */
  plan(): PlanEntry[] {
    const p = join(this.context, "plan.json");
    const doc = JSON.parse(readFileSync(p, "utf8"));
    return (doc.evaluations ?? []).map((e: any) => ({
      name: e.name,
      partition: e.partition,
      backend: e.backend,
      cases: e.cases ?? null,
      disclosure: e.disclosure,
      canEvaluate: !!(e.agent_can_evaluate ?? e.can_evaluate),
      remainingRuns: e.budget?.remaining_runs ?? null,
      remainingCases: e.budget?.remaining_cases ?? null,
    }));
  }

  /**
   * Score the CURRENT git commit on `entry`'s partition. A failed evaluation is a
   * NORMAL outcome (the target may be a broken seed that must be fixed by editing
   * its code) — we NEVER throw for it. Instead we return `score: null` with the
   * failure captured in `error` (CLI message + any per-case root cause such as a
   * `model_denied`), so the loop can keep going and hand the diagnosis to the
   * proposer. We only retry genuinely transient infra errors (socket/connection).
   */
  async evaluate(
    entry: PlanEntry,
    subset?: { start?: number; stop?: number; caseIds?: string[] },
  ): Promise<EvalResult> {
    const args = ["run", "--backend", entry.backend, "--evaluation-set", entry.name, "--partition", entry.partition];
    if (subset?.start != null) args.push("--start", String(subset.start));
    if (subset?.stop != null) args.push("--stop", String(subset.stop));
    for (const id of subset?.caseIds ?? []) args.push("--case-id", id);

    const t0 = Date.now();
    logEvent("eval.run", { backend: entry.backend, evalSet: entry.name, partition: entry.partition, subset: subset ?? null, args });
    let raw: string;
    try {
      raw = await this.runTransientRetry(args);
    } catch (e: any) {
      // The eval RAN but the target failed (e.g. 502 "evaluation failed" wrapping a
      // model_denied), or infra gave up. Record it, and enrich with the per-case
      // root cause from the persisted (failed) result so the proposer can act on it.
      const cliErr = String(e?.message || e).slice(0, 800);
      const recorded = this.readNewestResult(entry.partition, cliErr, true);
      const perCase = recorded.cases.map((c) => c.error).filter(Boolean).slice(0, 4).join(" | ");
      const res = { ...recorded, score: null, error: perCase ? `${cliErr}\nroot cause: ${perCase}` : cliErr };
      logEvent("eval.result", { partition: entry.partition, ok: false, score: null, numCases: res.numCases, durationMs: Date.now() - t0, error: res.error, cases: res.cases });
      return res;
    }
    const res = this.readNewestResult(entry.partition, raw);
    logEvent("eval.result", { partition: entry.partition, ok: true, score: res.score, numCases: res.numCases, durationMs: Date.now() - t0, evaluationId: res.evaluationId, cases: res.cases, raw: raw.slice(-1200) });
    return res;
  }

  /** Retry ONLY transient infra errors; a deterministic eval failure is returned, not retried. */
  private async runTransientRetry(args: string[], attempts = 2): Promise<string> {
    let lastErr: any;
    for (let i = 0; i < attempts; i++) {
      try {
        return await this.exec(args);
      } catch (e: any) {
        lastErr = e;
        const msg = String(e?.message || e);
        const transient = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|EAI_AGAIN|network|timeout/i.test(msg);
        if (!transient || i === attempts - 1) throw e; // deterministic eval failure -> caller records it
        process.stderr.write(`[evals] transient run error (attempt ${i + 1}/${attempts}): ${msg.slice(0, 120)} — retry in 10s\n`);
        await new Promise((r) => setTimeout(r, 10000));
      }
    }
    throw lastErr;
  }

  /** Nominate a commit as the shipped candidate H+. Deliberate; never rely on auto-best. */
  async submit(commit: string): Promise<void> {
    await this.exec(["submit", "--version", commit]);
  }

  /**
   * Read the newest persisted result for `partition` from `.evals/results/`.
   * Also used after a FAILED eval to recover the per-case root cause; on a read
   * problem it returns an empty (null-score) result rather than throwing.
   */
  private readNewestResult(partition: string, raw: string, failing = false): EvalResult {
    const empty = (): EvalResult => ({ score: null, numCases: null, cases: [], evaluationId: null, raw, ...(failing ? { error: raw } : {}) });
    try {
      const idxPath = join(this.context, "results", "index.json");
      if (!existsSync(idxPath)) return empty();
      const idx = JSON.parse(readFileSync(idxPath, "utf8"));
      const entries = (idx.evaluations ?? []).filter((e: any) => e.partition === partition);
      const entry = entries[entries.length - 1]; // sequential loop => newest is last appended
      if (!entry) return empty();
      const docPath = join(this.context, "results", String(entry.path));
      const doc = JSON.parse(readFileSync(docPath, "utf8"));
      const r = doc.result ?? {};
      const score = firstNum(dig(r, "objective", "value"), dig(r, "metrics", "score"), dig(r, "report", "metrics", "score"));
      const caseFiles = Array.isArray(r.case_files) ? r.case_files : [];
      const cases = caseFiles.map((cf: any) => {
        try {
          const cdoc = JSON.parse(readFileSync(join(dirname(docPath), String(cf.path)), "utf8"));
          const c = cdoc.result ?? {};
          const errs = Array.isArray(c.errors) ? c.errors : [];
          const error = errs[0]?.code ?? errs[0]?.message ?? dig(c, "output", "error_category") ?? dig(c, "output", "error");
          return { caseId: String(c.case_id ?? ""), score: firstNum(dig(c, "metrics", "score")), status: c.status, error: error ? String(error).slice(0, 400) : undefined };
        } catch {
          return { caseId: "", score: null };
        }
      });
      return {
        score,
        numCases: firstNum(r.total_cases, caseFiles.length),
        cases,
        evaluationId: (entry.evaluation_id ?? null) as string | null,
        raw,
      };
    } catch {
      return empty();
    }
  }
}

function resolveContext(cwd: string): string {
  const env = process.env.VERO_CONTEXT_PATH;
  if (env) return env;
  let cur = cwd;
  for (;;) {
    const p = join(cur, ".evals");
    if (existsSync(join(p, "manifest.json"))) return p;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return join(cwd, ".evals");
}

function dig(o: any, ...keys: string[]): any {
  let v = o;
  for (const k of keys) {
    if (v == null || typeof v !== "object" || !(k in v)) return undefined;
    v = v[k];
  }
  return v;
}

/** First finite number among args (0 is valid; null/undefined skipped). */
function firstNum(...vals: any[]): number | null {
  for (const v of vals) if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}
