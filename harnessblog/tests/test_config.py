from pathlib import Path

from harnessblog.config import CampaignConfig, build_specs


def test_matrix_has_twenty_four_unique_runs():
    root = Path(__file__).parents[1]
    specs = build_specs(root, CampaignConfig("test"))
    assert len(specs) == 24
    assert len({s.run_id for s in specs}) == 24
    assert {s.task for s in specs} == {"three-body", "heat-2d"}
