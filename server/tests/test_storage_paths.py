"""Per-grid storage settings and existing world compatibility."""

from pathlib import Path

import pytest

from app.config import AppConfig, load_config, resolve_storage_paths


@pytest.mark.parametrize(
    ("storage", "auth", "state", "db"),
    [
        ({}, {}, "runtime/items.json", "runtime/chatgrid.db"),
        (
            {"state_file": "saved/items-alt.json"},
            {},
            "saved/items-alt.json",
            "runtime/chatgrid.db",
        ),
        ({"data_dir": "tt", "state_file": ""}, {}, None, "tt/chatgrid.db"),
        (
            {"data_dir": "tt"},
            {"db_file": "accounts/custom.db"},
            "tt/items.json",
            "accounts/custom.db",
        ),
        (
            {"data_dir": "tt", "state_file": "old/world.json"},
            {},
            "old/world.json",
            "tt/chatgrid.db",
        ),
    ],
)
def test_storage_paths(tmp_path, storage, auth, state, db):
    cfg = AppConfig.model_validate({"storage": storage, "auth": auth})
    assert resolve_storage_paths(cfg, tmp_path / "config.toml") == (
        tmp_path / state if state else None,
        tmp_path / db,
    )


def test_absolute_data_directory(tmp_path: Path):
    directory = tmp_path / "volume"
    cfg = AppConfig.model_validate({"storage": {"data_dir": str(directory)}})
    assert resolve_storage_paths(cfg, tmp_path / "conf" / "grid.toml") == (
        directory / "items.json",
        directory / "chatgrid.db",
    )


def test_switch_to_data_dir_reopens_restored_world_and_accounts(
    tmp_path: Path, make_world
):
    config_path = tmp_path / "grid.toml"

    def open_grid(settings):
        config_path.write_text("[network]\nallow_insecure_ws = true\n" + settings)
        state, db = resolve_storage_paths(load_config(config_path), config_path)
        return make_world(state_file=state, auth_db_path=db).server

    grid = open_grid(
        '[storage]\nstate_file="tt/items.json"\n[auth]\ndb_file="tt/chatgrid.db"'
    )
    grid.auth_service.bootstrap_admin("first-admin", "password99")
    checkpoint = grid.world_store.capture("Original world", "admin")

    other = open_grid('[storage]\ndata_dir="other"')
    other.world_store.capture("Other world", "admin")
    other.auth_service.close()

    revision = grid.world_store.preview(checkpoint["id"])["worldRevision"]
    grid.world_store.restore(checkpoint["id"], revision, "admin")
    grid.auth_service.close()

    restarted = open_grid('[storage]\ndata_dir="tt"')
    assert restarted.auth_service.has_admin()
    assert restarted.world_store.using_generation
    assert len(restarted.world_store.list_checkpoints(0)["checkpoints"]) == 2
    restarted.auth_service.close()
    other = open_grid('[storage]\ndata_dir="other"')
    assert not other.world_store.using_generation
    assert [
        c["label"] for c in other.world_store.list_checkpoints(0)["checkpoints"]
    ] == ["Other world"]
    assert not other.auth_service.has_admin()
    other.auth_service.close()
