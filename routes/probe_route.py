#!/usr/bin/env python3
"""Stage-1 OpenRouter route probe (SMALL paid spend -- NOT free, do not run in Stage 0).

Answers the questions the route overlay cannot answer statically:
  - which provider actually serves a model slug on this OpenRouter key;
  - whether a single provider can be pinned (provider.only + allow_fallbacks:false);
  - whether the exact request surface the seed uses is accepted;
  - the resolved provider/model reported back, so we can pin it.

It performs a handful of tiny requests (max_tokens small) and prints, per model,
the resolved provider from OpenRouter's response so `*.route.json` aliases can be
filled with a single-provider slug. Run it once, under a hard spend cap, at
Stage 1 -- never as part of the free Stage-0 config checks.

Usage:
  set -a; source /mnt/storage/harnessopt/vero/openrouter.secrets.env; set +a
  uv run python routes/probe_route.py --models gpt-5.4-mini xai/grok-build-0.1 \
      openai/gpt-5.6-sol fireworks_ai/deepseek-v4-flash

Environment: OPENAI_API_KEY (OpenRouter key), OPENAI_BASE_URL (https://openrouter.ai/api/v1).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from urllib.error import HTTPError, URLError


def chat_probe(base: str, key: str, model: str, pin_provider: str | None) -> dict:
    """One tiny /chat/completions call; returns status + resolved provider info."""
    body: dict = {
        "model": model,
        "messages": [{"role": "user", "content": "Reply with the single word OK."}],
        "max_tokens": 8,
    }
    # OpenRouter provider routing: pin one provider and forbid fallback so the
    # served deployment is deterministic. See https://openrouter.ai/docs (provider routing).
    if pin_provider:
        body["provider"] = {"only": [pin_provider], "allow_fallbacks": False}
    req = urllib.request.Request(
        base.rstrip("/") + "/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            doc = json.load(resp)
            return {
                "status": resp.status,
                "resolved_provider": doc.get("provider"),
                "resolved_model": doc.get("model"),
                "id": str(doc.get("id"))[:16],
            }
    except HTTPError as err:
        try:
            payload = json.loads(err.read().decode())
        except (ValueError, OSError):
            payload = {}
        return {"status": err.code, "error": payload.get("error") or payload}
    except (URLError, TimeoutError) as err:
        return {"status": None, "error": str(err)}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--models", nargs="+", required=True, help="model slugs to probe")
    ap.add_argument("--pin-provider", default=None, help="optional OpenRouter provider to force (provider.only)")
    args = ap.parse_args()

    base = os.environ.get("OPENAI_BASE_URL", "").strip()
    key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not base or not key:
        return _fail("source the run secrets first: OPENAI_BASE_URL and OPENAI_API_KEY must be set")
    if "openrouter" not in base:
        print(f"warning: OPENAI_BASE_URL is {base!r}, not an OpenRouter endpoint", file=sys.stderr)

    print(f"# probing {len(args.models)} model(s) via {base}")
    print("# NOTE: this spends a small amount. Keep it to Stage 1 under a hard cap.\n")
    results: dict[str, dict] = {}
    for model in args.models:
        res = chat_probe(base, key, model, args.pin_provider)
        results[model] = res
        prov = res.get("resolved_provider")
        if res.get("status") == 200:
            print(f"OK   {model:40s} provider={prov} resolved_model={res.get('resolved_model')}")
        else:
            print(f"FAIL {model:40s} status={res.get('status')} error={_short(res.get('error'))}")
    print("\n# fill *.route.json aliases with a single-provider slug once the resolved")
    print("# provider is confirmed and provider.only+allow_fallbacks:false is honored.")
    print(json.dumps(results, indent=2))
    return 0


def _short(v: object) -> str:
    s = v if isinstance(v, str) else json.dumps(v)
    return s[:200]


def _fail(msg: str) -> int:
    print(f"error: {msg}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
