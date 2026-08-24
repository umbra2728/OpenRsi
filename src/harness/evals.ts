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
  score: number | null;
  numCases: number | null;
  cases: Array<{ caseId: string; score: number | null; status?: string }>;
  evaluationId: string | null;
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

  /** Score the CURRENT git commit on `entry`'s partition (optionally a case subset). */
  async evaluate(
    entry: PlanEntry,
    subset?: { start?: number; stop?: number; caseIds?: string[] },
  ): Promise<EvalResult> {
    const args = ["run", "--backend", entry.backend, "--evaluation-set", entry.name, "--partition", entry.partition];
    if (subset?.start != null) args.push("--start", String(subset.start));
    if (subset?.stop != null) args.push("--stop", String(subset.stop));
    for (const id of subset?.caseIds ?? []) args.push("--case-id", id);
    const raw = await this.runWithRetry(args);
    return this.readNewestResult(entry.partition, raw);
  }

  /**
   * `evals run`, resilient to TRANSIENT eval failures. The gateway occasionally
   * returns a 502 / model_denied while a scope token is warming up (observed: a
   * clean run still logs a few such hiccups and passes). We retry a couple of
   * times with backoff — but never retry a client-side usage error (bad flags),
   * and cap attempts so we don't burn the case-pass budget.
   */
  private async runWithRetry(args: string[], attempts = 6): Promise<string> {
    // The gateway's per-scope token warms up lazily: the first 1-2 evals after a
    // fresh container reliably 502 with model_denied, then it works (observed in a
    // known-good claude-code run: 2 denied dev evals, then 1.0/0.5). Failed evals
    // are not charged, so we retry generously (~4 min total) to clear the warmup.
    let lastErr: any;
    for (let i = 0; i < attempts; i++) {
      try {
        return await this.exec(args);
      } catch (e: any) {
        lastErr = e;
        const msg = String(e?.message || e);
        if (/No such option|Usage:|invalid evaluation request/i.test(msg)) throw e; // deterministic, don't retry
        if (i < attempts - 1) {
          const waitMs = Math.min((i + 1) * 25000, 60000);
          process.stderr.write(`[evals] run failed (attempt ${i + 1}/${attempts}): ${msg.slice(0, 160)} — retry in ${waitMs / 1000}s\n`);
          await new Promise((r) => setTimeout(r, waitMs));
        }
      }
    }
    throw lastErr;
  }

  /** Nominate a commit as the shipped candidate H+. Deliberate; never rely on auto-best. */
  async submit(commit: string): Promise<void> {
    await this.exec(["submit", "--version", commit]);
  }

  /** Read the newest persisted result for `partition` from `.evals/results/`. */
  private readNewestResult(partition: string, raw: string): EvalResult {
    const idxPath = join(this.context, "results", "index.json");
    if (!existsSync(idxPath)) return { score: null, numCases: null, cases: [], evaluationId: null, raw };
    const idx = JSON.parse(readFileSync(idxPath, "utf8"));
    const entries = (idx.evaluations ?? []).filter((e: any) => e.partition === partition);
    const entry = entries[entries.length - 1]; // sequential loop => newest is last appended
    if (!entry) return { score: null, numCases: null, cases: [], evaluationId: null, raw };
    const docPath = join(this.context, "results", String(entry.path));
    const doc = JSON.parse(readFileSync(docPath, "utf8"));
    const r = doc.result ?? {};
    const score = firstNum(dig(r, "objective", "value"), dig(r, "metrics", "score"), dig(r, "report", "metrics", "score"));
    const caseFiles = Array.isArray(r.case_files) ? r.case_files : [];
    const cases = caseFiles.map((cf: any) => {
      try {
        const cdoc = JSON.parse(readFileSync(join(dirname(docPath), String(cf.path)), "utf8"));
        const c = cdoc.result ?? {};
        return { caseId: String(c.case_id ?? ""), score: firstNum(dig(c, "metrics", "score")), status: c.status };
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
