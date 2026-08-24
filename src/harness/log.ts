/**
 * Structured troubleshooting log for the HarnessOpt optimizer.
 *
 * Everything the loop does is appended as one JSON object per line to
 * OPENRSI_LOG_FILE (default `/logs/agent/openrsi.jsonl`, which Harbor collects
 * into the run artifacts) AND mirrored as a short human line to stderr (which the
 * adapter tees into `openrsi.txt`). Nothing here throws — logging must never break
 * a run. Keep values JSON-serialisable; large blobs are truncated by callers.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const LOG_FILE = process.env.OPENRSI_LOG_FILE || "/logs/agent/openrsi.jsonl";
let ensured = false;

function ensure(): void {
  if (ensured) return;
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
  } catch {
    /* /logs may already exist or be unwritable; stderr mirror still works */
  }
  ensured = true;
}

function hhmmss(): string {
  return new Date().toISOString().slice(11, 19);
}

/** Append a structured event and mirror a compact line to stderr. */
export function logEvent(kind: string, data: Record<string, unknown> = {}): void {
  const rec = { t: new Date().toISOString(), kind, ...data };
  ensure();
  try {
    appendFileSync(LOG_FILE, JSON.stringify(rec, replacer) + "\n");
  } catch {
    /* best effort */
  }
  const brief = Object.entries(data)
    .filter(([k]) => !LONG_KEYS.has(k))
    .map(([k, v]) => `${k}=${short(v)}`)
    .join(" ");
  process.stderr.write(`[openrsi ${hhmmss()}] ${kind}${brief ? " " + brief : ""}\n`);
}

const LONG_KEYS = new Set(["events", "raw", "stack", "diff", "diagnostics", "plan", "output"]);

function short(v: unknown): string {
  const s = typeof v === "string" ? v : safeJson(v);
  const oneLine = s.replace(/\s+/g, " ");
  return oneLine.length > 220 ? oneLine.slice(0, 220) + "…" : oneLine;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, replacer) ?? String(v);
  } catch {
    return String(v);
  }
}

function replacer(_k: string, v: unknown): unknown {
  if (typeof v === "string" && v.length > 8000) return v.slice(0, 8000) + `…(+${v.length - 8000} chars)`;
  return v;
}
