from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
from scipy.integrate import solve_ivp

from .io import sha256_file
from .models import RunResult


WEIGHTS = {"numerical": 50.0, "cuda": 20.0, "reproducibility": 15.0, "artifacts": 15.0}


def _three_body_metrics(path: Path) -> dict[str, float | bool]:
    data = np.load(path, allow_pickle=False)
    t = np.asarray(data["t"], dtype=np.float64)
    positions = np.asarray(data["positions"], dtype=np.float64)
    velocities = np.asarray(data["velocities"], dtype=np.float64)
    if positions.shape != (len(t), 3, 2) or velocities.shape != positions.shape or len(t) < 2 or not np.all(np.diff(t) > 0):
        raise ValueError("invalid trajectory schema")
    r0 = np.array([[-0.97000436, 0.24308753], [0.97000436, -0.24308753], [0.0, 0.0]])
    v0 = np.array([[0.466203685, 0.43236573], [0.466203685, 0.43236573], [-0.93240737, -0.86473146]])
    def rhs(_t, state):
        r = state[:6].reshape(3, 2); v = state[6:].reshape(3, 2); a = np.zeros_like(r)
        for i in range(3):
            for j in range(3):
                if i != j:
                    d = r[j] - r[i]; a[i] += d / np.linalg.norm(d) ** 3
        return np.concatenate((v.ravel(), a.ravel()))
    reference = solve_ivp(rhs, (float(t[0]), float(t[-1])), np.concatenate((r0.ravel(), v0.ravel())), method="DOP853", t_eval=t, rtol=2e-14, atol=2e-14)
    ref_r = reference.y[:6].T.reshape(-1, 3, 2); ref_v = reference.y[6:].T.reshape(-1, 3, 2)
    rms = float(np.sqrt(np.mean(np.square(np.concatenate(((positions-ref_r).ravel(), (velocities-ref_v).ravel()))))))
    kinetic = 0.5 * np.sum(velocities * velocities, axis=(1, 2)); potential = np.zeros(len(t))
    for i, j in ((0, 1), (0, 2), (1, 2)): potential -= 1 / np.linalg.norm(positions[:, i] - positions[:, j], axis=1)
    energy = kinetic + potential; energy_drift = float(np.max(np.abs((energy-energy[0])/energy[0])))
    momentum_drift = float(np.max(np.linalg.norm(np.sum(velocities, axis=1)-np.sum(velocities[0], axis=0), axis=1)))
    return {"rms_state_error": rms, "energy_drift": energy_drift, "momentum_drift": momentum_drift}


def _heat_metrics(path: Path, config_path: Path) -> dict[str, float | bool]:
    data = np.load(path, allow_pickle=False); cfg = json.loads(config_path.read_text())
    x = np.asarray(data["x"], dtype=np.float64); y = np.asarray(data["y"], dtype=np.float64); u = np.asarray(data["u"], dtype=np.float64)
    if u.shape != (len(y), len(x)) or not np.isfinite(u).all(): raise ValueError("invalid heat solution schema")
    exact = np.exp(-2*np.pi**2*float(cfg["alpha"])*float(cfg["final_time"])) * np.sin(np.pi*x)[None, :] * np.sin(np.pi*y)[:, None]
    rel = float(np.linalg.norm(u-exact)/np.linalg.norm(exact)); parity = float(np.max(np.abs(u-exact)))
    boundary = float(max(np.max(np.abs(u[0])), np.max(np.abs(u[-1])), np.max(np.abs(u[:, 0])), np.max(np.abs(u[:, -1]))))
    return {"relative_l2_error": rel, "cpu_parity_error": parity, "boundary_error": boundary, "finite": True}


def evaluate(run_id: str, workspace: Path, exit_code: int, gpu_evidence: dict | None = None) -> RunResult:
    metrics_path = workspace / "output" / "metrics.json"
    if exit_code != 0 or not metrics_path.exists():
        return RunResult(run_id, "failed", exit_code, error="agent failed or output/metrics.json missing")
    try:
        metrics = json.loads(metrics_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        return RunResult(run_id, "failed", exit_code, error=f"invalid metrics: {exc}")
    task = "three-body" if run_id.startswith("three-body") else "heat-2d"
    try:
        independent = _three_body_metrics(workspace / "output" / "trajectory.npz") if task == "three-body" else _heat_metrics(workspace / "output" / "solution.npz", workspace / "config.json")
        metrics.update({f"independent/{k}": v for k, v in independent.items()})
    except Exception as exc:
        independent = {}; metrics["independent/error"] = str(exc)
    if task == "three-body":
        numerical = float(independent.get("rms_state_error", 1)) <= 1e-8 and float(independent.get("energy_drift", 1)) <= 1e-9 and float(independent.get("momentum_drift", 1)) <= 1e-10
    else:
        numerical = float(independent.get("relative_l2_error", 1)) <= 1e-5 and float(independent.get("cpu_parity_error", 1)) <= 1e-8 and float(independent.get("boundary_error", 1)) <= 1e-10
    gpu_evidence = gpu_evidence or {}
    cuda = bool(gpu_evidence.get("cuda_process_verified", False)) and int(metrics.get("cuda_device_count", 0)) > 0
    metrics["orchestrator_cuda_process_verified"] = cuda
    metrics["orchestrator_peak_gpu_memory_mib"] = gpu_evidence.get("peak_new_process_memory_mib", 0)
    reproducible = bool(metrics.get("deterministic", False))
    required = [workspace / "output" / x for x in (("trajectory.npz", "orbit.png", "orbit.mp4") if task == "three-body" else ("solution.npz", "heatmap.png", "heatmap.mp4"))]
    artifacts_ok = all(p.exists() and p.stat().st_size > 0 for p in required)
    gates = {"numerical": numerical, "cuda": cuda, "reproducibility": reproducible, "artifacts": artifacts_ok}
    score = sum(WEIGHTS[name] for name, passed in gates.items() if passed)
    artifacts = {p.name: sha256_file(p) for p in required if p.exists()}
    passed = score >= 80 and all(gates.values())
    return RunResult(run_id, "finished", exit_code, score, passed, gates, metrics=metrics, artifacts=artifacts)
