"""Shared emitter controls exposed by item plugins."""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any, cast

import pytest

from app.item_service import ItemService
from app.items.registry import ITEM_MODULES
from app.items.types.plugin_helpers import build_item_module


EMIT_TYPES = tuple(
    item_type for item_type in ITEM_MODULES if item_type != "radio_station"
)
EMIT_KEYS = {
    "emitSound",
    "emitVolume",
    "emitRange",
    "emitSoundSpeed",
    "emitSoundTempo",
    "emitInitialDelay",
    "emitLoopDelay",
    "emitEffect",
    "emitEffectValue",
    "directional",
    "facing",
}


def test_shared_emit_controls_are_composed_for_each_eligible_plugin(world) -> None:
    """Every non-radio plugin gets the same editable controls and defaults."""

    client = world.connect("tester", client_id="u1")
    service = ItemService()

    for item_type in EMIT_TYPES:
        module = cast(Any, ITEM_MODULES[item_type])
        item = service.default_item(client, item_type)

        assert EMIT_KEYS.issubset(module.EDITABLE_PROPERTIES)
        sound_index = module.EDITABLE_PROPERTIES.index("emitSound")
        assert set(module.EDITABLE_PROPERTIES[sound_index:]) == EMIT_KEYS
        assert all(
            module.EDITABLE_PROPERTIES.index(key) > sound_index
            for key in EMIT_KEYS - {"emitSound"}
        )
        assert EMIT_KEYS.issubset(module.PARAM_KEYS)
        assert EMIT_KEYS.issubset(item.params)
        assert item.params["emitSound"] == (
            {"clock": "sounds/clock.ogg", "teleporter": "/sounds/whirr.ogg"}.get(
                item_type, ""
            )
        )
        for key in EMIT_KEYS - {"emitSound"}:
            visible_when = module.PROPERTY_METADATA[key].get("visibleWhen", {})
            if item_type == "piano" and key == "emitRange":
                assert "emitSound" not in visible_when
            else:
                assert visible_when["emitSound"] == "!"
        assert module.PROPERTY_METADATA["facing"]["visibleWhen"]["directional"] is True
        assert (
            module.PROPERTY_METADATA["emitEffectValue"]["visibleWhen"]["emitEffect"]
            == "!off"
        )


@pytest.mark.parametrize("item_type", EMIT_TYPES)
def test_shared_emit_updates_normalize_and_persist(tmp_path, world, item_type) -> None:
    """Shared emitter updates survive persistence and normalize empty sound values."""

    state_file = tmp_path / "items.json"
    service = ItemService(state_file=state_file)
    client = world.connect("tester", client_id="u1")
    item = service.default_item(client, item_type)
    item.params.update(
        {
            "emitSound": "none",
            "emitVolume": 42,
            "emitRange": 12,
            "emitSoundSpeed": 25.55,
            "emitSoundTempo": 60,
            "emitInitialDelay": 1.22,
            "emitLoopDelay": 3.44,
            "emitEffect": "echo",
            "emitEffectValue": 63.24,
            "directional": "on",
            "facing": 45,
        }
    )
    item.params = ITEM_MODULES[item.type].validate_update(item, item.params)
    service.add_item(item)
    service.save_state()

    saved = json.loads(state_file.read_text(encoding="utf-8"))
    assert saved[0]["params"]["emitSound"] == ""
    loaded = ItemService(state_file=state_file).items[item.id]
    assert loaded.params["emitSound"] == ""
    assert loaded.params["emitEffect"] == "echo"
    assert loaded.params["directional"] is True


def test_shared_emit_composition_preserves_fields_after_fixture_filtering() -> None:
    """The plugin boundary restores shared fields after item-specific filtering."""

    definition = SimpleNamespace(
        DEFAULT_PARAMS={"fixtureValue": "default"},
        PARAM_KEYS=("fixtureValue",),
        EDITABLE_PROPERTIES=("title",),
        PROPERTY_METADATA={"title": {"valueType": "text", "tooltip": "Fixture title."}},
        EMIT_SOUND=None,
        EMIT_RANGE=15,
        DIRECTIONAL=False,
    )

    def validate_fixture(_item: Any, params: dict) -> dict:
        return {"fixtureValue": params.get("fixtureValue")}

    module = build_item_module(
        definition,
        validate_update=validate_fixture,
        use_item=lambda *_args: None,
    )
    item = SimpleNamespace(params={"emitSound": "", "fixtureValue": "old"})
    validated = module.validate_update(
        item,
        {
            "fixtureValue": "updated",
            "emitSound": "fixture.ogg",
            "emitRange": 12,
        },
    )

    assert validated["fixtureValue"] == "updated"
    assert validated["emitSound"] == "sounds/fixture.ogg"
    assert validated["emitRange"] == 12


def test_radio_station_does_not_receive_shared_emit_controls() -> None:
    """Radio playback settings remain separate from configurable emitters."""

    module = cast(Any, ITEM_MODULES["radio_station"])
    shared_only_keys = EMIT_KEYS - {"emitRange", "facing"}
    assert not shared_only_keys.intersection(module.EDITABLE_PROPERTIES)
    assert not shared_only_keys.intersection(module.PARAM_KEYS)
    assert "emitVolume" not in module.PROPERTY_METADATA
    assert "emitEffect" not in module.PROPERTY_METADATA


@pytest.mark.parametrize("item_type", ["clock", "teleporter"])
@pytest.mark.parametrize("saved_sound", [None, "sounds/custom.ogg", ""])
def test_old_item_volume_update_preserves_sound(
    tmp_path, world, item_type, saved_sound
) -> None:
    """Older persisted items acquire missing defaults without losing sound overrides."""

    state_file = tmp_path / "items.json"
    service = ItemService(state_file=state_file)
    item = service.default_item(world.connect("tester"), item_type)
    expected_sound = (
        saved_sound if saved_sound is not None else item.params["emitSound"]
    )
    for key in EMIT_KEYS:
        item.params.pop(key, None)
    if saved_sound is not None:
        item.params["emitSound"] = saved_sound
    service.add_item(item)
    service.save_state()

    loaded_service = ItemService(state_file=state_file)
    loaded = loaded_service.items[item.id]
    assert loaded.params["emitVolume"] == 100
    assert loaded.params["emitSound"] == expected_sound
    for volume in (0, 42):
        loaded.params = ITEM_MODULES[item_type].validate_update(
            loaded, {**loaded.params, "emitVolume": volume}
        )
        assert loaded.params["emitSound"] == expected_sound.lstrip("/")
        assert loaded.params["emitVolume"] == volume
        loaded_service.save_state()
        restored = ItemService(state_file=state_file).items[item.id]
        assert restored.params["emitSound"] == expected_sound.lstrip("/")
        assert restored.params["emitVolume"] == volume
