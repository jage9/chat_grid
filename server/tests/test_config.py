from pathlib import Path

import pytest

from app.config import load_config


def test_load_config_defaults_when_path_none() -> None:
    cfg = load_config(None)
    assert cfg.server.bind_ip == "127.0.0.1"
    assert cfg.network.allow_insecure_ws is False
    assert cfg.storage.state_file == "runtime/items.json"
    assert cfg.storage.state_save_debounce_ms == 200
    assert cfg.storage.state_save_max_delay_ms == 1000
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


def test_load_config_reads_state_save_timing(tmp_path: Path) -> None:
    config_path = tmp_path / "config.toml"
    config_path.write_text(
        """
[network]
allow_insecure_ws = true

[storage]
state_file = "runtime/items.json"
state_save_debounce_ms = 150
state_save_max_delay_ms = 900
""".strip()
    )
    cfg = load_config(config_path)
    assert cfg.storage.state_save_debounce_ms == 150
    assert cfg.storage.state_save_max_delay_ms == 900
