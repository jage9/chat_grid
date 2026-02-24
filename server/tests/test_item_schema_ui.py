from __future__ import annotations

import asyncio

import pytest

from app.server import SignalingServer


def test_ui_definitions_are_complete_for_all_item_types() -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    definitions = server._build_ui_definitions()

    item_type_order = definitions.get("itemTypeOrder")
    item_types = definitions.get("itemTypes")
    assert isinstance(item_type_order, list)
    assert isinstance(item_types, list)
    assert item_type_order
    assert len(item_types) == len(item_type_order)
    assert [entry.get("type") for entry in item_types] == item_type_order

    required_global_keys = {
        "useSound",
        "emitSound",
        "useCooldownMs",
        "emitRange",
        "directional",
        "emitSoundSpeed",
        "emitSoundTempo",
    }

    for entry in item_types:
        assert isinstance(entry.get("type"), str)
        assert isinstance(entry.get("label"), str)
        assert isinstance(entry.get("editableProperties"), list)
        assert isinstance(entry.get("propertyMetadata"), dict)
        assert isinstance(entry.get("propertyOptions"), dict)
        assert isinstance(entry.get("globalProperties"), dict)

        editable_properties = entry["editableProperties"]
        property_metadata = entry["propertyMetadata"]
        property_options = entry["propertyOptions"]
        global_properties = entry["globalProperties"]

        assert required_global_keys.issubset(set(global_properties.keys()))
        for property_key in editable_properties:
            if property_key == "title":
                continue
            assert property_key in property_metadata
            metadata = property_metadata[property_key]
            assert isinstance(metadata, dict)
            if metadata.get("valueType") == "list":
                options = property_options.get(property_key)
                assert isinstance(options, list)
                assert options


@pytest.mark.asyncio
async def test_state_save_requests_are_debounced(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    save_calls: list[str] = []

    def fake_save_state() -> None:
        save_calls.append("saved")

    monkeypatch.setattr(server.item_service, "save_state", fake_save_state)

    server._request_state_save()
    server._request_state_save()
    server._request_state_save()
    await asyncio.sleep(0.25)
    assert len(save_calls) == 1

    server._request_state_save()
    await asyncio.sleep(0.25)
    assert len(save_calls) == 2
