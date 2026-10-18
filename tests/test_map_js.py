"""Run the Node checks of the navigation map's pure functions (spec RF13 / RF15)."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

HERE = Path(__file__).parent


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_map_mutations_js():
    res = subprocess.run(
        ["node", str(HERE / "map_mutations.test.js")], capture_output=True, text=True, timeout=60, check=False
    )
    assert res.returncode == 0, res.stderr or res.stdout
    assert "map mutations: ok" in res.stdout
