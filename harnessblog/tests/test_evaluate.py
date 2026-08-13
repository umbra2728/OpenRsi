import json
from pathlib import Path

import numpy as np
from scipy.integrate import solve_ivp

from harnessblog.evaluate import evaluate


def _write(path: Path, data: bytes = b"x"):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def test_three_body_pass(tmp_path):
    metrics = {
        "rms_state_error": 1e-10,
        "energy_drift": 1e-11,
        "momentum_drift": 1e-12,
        "cuda_verified": True,
        "cuda_device_count": 1,
        "deterministic": True,
    }
    _write(tmp_path / "output" / "metrics.json", json.dumps(metrics).encode())
    r0 = np.array([[-0.97000436, 0.24308753], [0.97000436, -0.24308753], [0.0, 0.0]])
    v0 = np.array([[0.466203685, 0.43236573], [0.466203685, 0.43236573], [-0.93240737, -0.86473146]])
    def rhs(_t, state):
        r = state[:6].reshape(3, 2); v = state[6:].reshape(3, 2); a = np.zeros_like(r)
        for i in range(3):
            for j in range(3):
                if i != j:
                    d = r[j] - r[i]; a[i] += d / np.linalg.norm(d) ** 3
        return np.concatenate((v.ravel(), a.ravel()))
    t = np.linspace(0, 0.01, 5)
    sol = solve_ivp(rhs, (0, .01), np.concatenate((r0.ravel(), v0.ravel())), t_eval=t, method="DOP853", rtol=2e-14, atol=2e-14)
    np.savez(tmp_path / "output" / "trajectory.npz", t=t, positions=sol.y[:6].T.reshape(-1, 3, 2), velocities=sol.y[6:].T.reshape(-1, 3, 2))
    for name in ("orbit.png", "orbit.mp4"):
        _write(tmp_path / "output" / name)
    result = evaluate("three-body--pi--x", tmp_path, 0, {"cuda_process_verified": True, "peak_new_process_memory_mib": 10})
    assert result.passed
    assert result.score == 100


def test_self_report_without_artifacts_fails(tmp_path):
    _write(tmp_path / "output" / "metrics.json", b'{"cuda_verified":true,"cuda_device_count":1}')
    result = evaluate("heat-2d--pi--x", tmp_path, 0)
    assert not result.passed
