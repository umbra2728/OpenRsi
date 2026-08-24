/**
 * OpenRSI HarnessOpt entry point — launched by the `openrsi` Harbor agent adapter
 * as the `main` optimizer inside the container.
 *
 *   node dist/runHarnessOpt.js "<instruction.md text>"
 *
 * It derives the sidecar's `evals` invocation (backend / evaluation-set /
 * selection partition) from the compiled instruction (which literally contains an
 * `evals run --backend … --evaluation-set … --partition …` block), builds the
 * optimizer model against the injected gateway (producer scope), and runs the
 * budget-aware loop (src/harness/harnessOptLoop.ts).
 *
 * Env (set by the adapter / operator):
 *   OPENRSI_OPTIMIZER_MODEL   gateway model id for the optimizer (e.g. anthropic/claude-opus-5)
 *   OPENAI_BASE_URL / OPENAI_API_KEY   producer-scope gateway (OpenAI-compatible)
 *   OPENRSI_TARGET_DIR        default /work/agent
 *   OPENRSI_GENERATIONS       default 6
 *   OPENRSI_DEV_SUBSET        dev cases per iteration (default 8)
 *   OPENRSI_HB_BACKEND / OPENRSI_HB_EVALSET / OPENRSI_HB_PARTITION  overrides if parsing fails
 */
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { Model } from "@earendil-works/pi-ai";
import { Evals } from "./harness/evals.js";
import { runLoop, type LoopConfig } from "./harness/harnessOptLoop.js";

/** Build the optimizer model against the gateway (OpenAI-compatible producer scope). */
function buildOptimizerModel(): Model<any> {
  const id = process.env.OPENRSI_OPTIMIZER_MODEL?.trim() || "anthropic/claude-opus-5";
  const provider = process.env.OPENRSI_PROVIDER?.trim() || "openai"; // gateway speaks OpenAI-compatible
  const factory = getBuiltinModel as unknown as (p: string, id: string) => Model<any> | null;
  let model: Model<any> | null = null;
  try {
    model = factory(provider, id);
  } catch {
    model = null;
  }
  if (!model) {
    // Non-catalog id: clone a known OpenAI-compatible model and override the id
    // (the id is what the gateway receives), mirroring provider.ts's fallback.
    const base = factory("openai", "gpt-4o") ?? factory("openrouter", "anthropic/claude-sonnet-5");
    if (!base) throw new Error(`cannot build optimizer model "${id}"`);
    model = { ...(base as any), id, name: id } as Model<any>;
    process.stderr.write(`[runHarnessOpt] built non-catalog gateway model "${id}" via ${provider}\n`);
  }
  const maxTok = Number(process.env.OPENRSI_MODEL_MAX_TOKENS || 0);
  if (maxTok > 0) (model as any).maxTokens = maxTok;
  return model;
}

/** Extract `evals run` coordinates from the compiled instruction; env overrides win. */
function parseEvalsCoords(instruction: string): { backend: string; evaluationSet: string } {
  const backend =
    process.env.OPENRSI_HB_BACKEND?.trim() ||
    instruction.match(/--backend\s+(\S+)/)?.[1] ||
    "";
  const evaluationSet =
    process.env.OPENRSI_HB_EVALSET?.trim() ||
    instruction.match(/--evaluation-set\s+(\S+)/)?.[1] ||
    "";
  if (!backend || !evaluationSet) {
    throw new Error(
      "could not determine evals backend/evaluation-set from instruction or env " +
        "(set OPENRSI_HB_BACKEND / OPENRSI_HB_EVALSET)",
    );
  }
  return { backend, evaluationSet };
}

async function main() {
  const instruction = process.argv.slice(2).join(" ") || process.env.OPENRSI_INSTRUCTION || "";
  if (instruction === "--help" || instruction === "-h") {
    process.stdout.write("usage: node dist/runHarnessOpt.js \"<instruction.md text>\"\n");
    process.exit(0);
  }
  const { backend, evaluationSet } = parseEvalsCoords(instruction);
  const targetDir = process.env.OPENRSI_TARGET_DIR?.trim() || "/work/agent";
  const log = (m: string) => process.stderr.write(`[openrsi ${new Date().toISOString().slice(11, 19)}] ${m}\n`);

  log(`backend=${backend} evalSet=${evaluationSet} target=${targetDir} model=${process.env.OPENRSI_OPTIMIZER_MODEL}`);

  const evals = new Evals({ backend, evaluationSet, cwd: targetDir });
  const cfg: LoopConfig = {
    targetDir,
    evals,
    model: buildOptimizerModel(),
    generations: Number(process.env.OPENRSI_GENERATIONS || 6),
    devSubset: Number(process.env.OPENRSI_DEV_SUBSET || 8),
    minValCases: Number(process.env.OPENRSI_MIN_VAL_CASES || 5),
    reserveValCalls: Number(process.env.OPENRSI_RESERVE_VAL || 8),
    thinkingLevel: (process.env.OPENRSI_THINKING as any) || "medium",
    log,
  };
  const res = await runLoop(cfg);
  log(`DONE champion=${res.championSha.slice(0, 8)} val=${res.championVal} accepted=${res.accepted}/${res.generations}`);
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`[openrsi] FATAL: ${e?.stack || e}\n`);
  process.exit(1);
});
