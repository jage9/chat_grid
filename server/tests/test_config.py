from pathlib import Path

import pytest

from app.config import load_config


def test_load_config_defaults_when_path_none() -> None:
    cfg = load_config(None)
    assert cfg.server.bind_ip == "127.0.0.1"
    assert cfg.network.allow_insecure_ws is True
    assert cfg.storage.state_file == "runtime/items.json"
    assert cfg.world.grid_size == 41


def test_load_config_requires_tls_when_insecure_disabled(tmp_path: Path) -> None:
    config_path = tmp_path / "config.toml"
    config_path.write_text(
        """
[network]
allow_insecure_ws = false
""".strip()
    )
    with pytest.raises(ValueError):
        load_config(config_path)
