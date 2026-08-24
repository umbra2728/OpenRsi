/**
 * OpenRSI HarnessOpt entry point — launched by the `openrsi` Harbor agent adapter
 * as the `main` optimizer inside the container.
 *
 *   node dist/runHarnessOpt.js "<instruction.md text>"
 *
 * It discovers what it may evaluate from `.evals/plan.json` (backend + partition +
 * disclosure + budget per evaluation — authoritative, no instruction parsing),
 * builds the optimizer model against the injected gateway (producer scope), and
 * runs the budget-aware loop (src/harness/harnessOptLoop.ts).
 *
 * Env (set by the adapter / operator):
 *   OPENRSI_OPTIMIZER_MODEL   gateway model id (e.g. anthropic/claude-opus-5)
 *   OPENAI_BASE_URL / OPENAI_API_KEY   producer-scope gateway (OpenAI-compatible)
 *   VERO_CONTEXT_PATH         path to the .evals context (harbor sets this)
 *   OPENRSI_TARGET_DIR        default /work/agent
 *   OPENRSI_GENERATIONS       default 6
 *   OPENRSI_DEV_SUBSET        dev cases per iteration (default 8)
 *   OPENRSI_RESERVE_VAL       val cases for the final confirmation (default 8)
 */
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { Model } from "@earendil-works/pi-ai";
import { Evals, type PlanEntry } from "./harness/evals.js";
import { runLoop, type LoopConfig } from "./harness/harnessOptLoop.js";

/** Build the optimizer model against the gateway (OpenAI-compatible producer scope). */
function buildOptimizerModel(): Model<any> {
  const id = process.env.OPENRSI_OPTIMIZER_MODEL?.trim() || "anthropic/claude-opus-5";
  const provider = process.env.OPENRSI_PROVIDER?.trim() || "openai";
  const factory = getBuiltinModel as unknown as (p: string, id: string) => Model<any> | null;
  let model: Model<any> | null = null;
  try {
    model = factory(provider, id);
  } catch {
    model = null;
  }
  if (!model) {
    // Non-catalog id: clone a known OpenAI-compatible model and override the id
    // (the id is the model string the gateway forwards), mirroring provider.ts.
    const base = factory("openai", "gpt-4o") ?? factory("openrouter", "anthropic/claude-sonnet-5");
    if (!base) throw new Error(`cannot build optimizer model "${id}"`);
    model = { ...(base as any), id, name: id } as Model<any>;
    process.stderr.write(`[runHarnessOpt] built non-catalog gateway model "${id}" via ${provider}\n`);
  }
  const maxTok = Number(process.env.OPENRSI_MODEL_MAX_TOKENS || 0);
  if (maxTok > 0) (model as any).maxTokens = maxTok;
  return model;
}

/** Choose the development (iterate) and validation (select) evaluations from the plan. */
function pickEvals(plan: PlanEntry[]): { dev: PlanEntry; val: PlanEntry } {
  const runnable = plan.filter((p) => p.canEvaluate);
  const dev =
    runnable.find((p) => p.disclosure === "full") ??
    runnable.find((p) => p.partition === "development") ??
    runnable[0];
  const val =
    runnable.find((p) => p.disclosure === "aggregate") ??
    runnable.find((p) => p.partition === "validation") ??
    dev;
  if (!dev || !val) throw new Error(`no runnable evaluations in plan: ${JSON.stringify(plan)}`);
  return { dev, val };
}

async function main() {
  const instruction = process.argv.slice(2).join(" ") || process.env.OPENRSI_INSTRUCTION || "";
  if (instruction === "--help" || instruction === "-h") {
    process.stdout.write('usage: node dist/runHarnessOpt.js "<instruction.md text>"\n');
    process.exit(0);
  }
  const targetDir = process.env.OPENRSI_TARGET_DIR?.trim() || "/work/agent";
  const log = (m: string) => process.stderr.write(`[openrsi ${new Date().toISOString().slice(11, 19)}] ${m}\n`);

  const evals = new Evals({ cwd: targetDir });
  const plan = evals.plan();
  log(`context=${evals.contextDir} plan=${plan.map((p) => `${p.partition}/${p.backend}(${p.disclosure},${p.cases})`).join(" ")}`);
  const { dev, val } = pickEvals(plan);
  log(`iterate on ${dev.partition} (${dev.backend}); select on ${val.partition} (${val.backend}); model=${process.env.OPENRSI_OPTIMIZER_MODEL}`);

  const cfg: LoopConfig = {
    targetDir,
    evals,
    dev,
    val,
    model: buildOptimizerModel(),
    generations: Number(process.env.OPENRSI_GENERATIONS || 6),
    devSubset: Math.min(Number(process.env.OPENRSI_DEV_SUBSET || 8), dev.cases ?? Number(process.env.OPENRSI_DEV_SUBSET || 8)),
    reserveValCases: Number(process.env.OPENRSI_RESERVE_VAL || 8),
    thinkingLevel: (process.env.OPENRSI_THINKING as any) || "medium",
    log,
  };
  const res = await runLoop(cfg);
  log(`DONE champion=${res.championSha.slice(0, 8)} baseline=${res.baselineDev} dev=${res.championDev} val=${res.championVal} accepted=${res.accepted}/${res.generations}`);
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`[openrsi] FATAL: ${e?.stack || e}\n`);
  process.exit(1);
});
