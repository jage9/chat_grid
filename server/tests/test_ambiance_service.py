"""Focused tests for ambiance catalogs, geometry, persistence, and packets."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import cast

import pytest

from app.ambiance_service import AmbianceError, AmbianceService
from app.client import ClientConnection
from app.models import (
    AmbianceActionResultPacket,
    AmbianceRemovePacket,
    AmbianceUpsertPacket,
    WelcomePacket,
)

from .conftest import World


def make_service(tmp_path: Path) -> AmbianceService:
    """Create a small service with deterministic test sound assets."""

    sounds_dir = tmp_path / "ambiances"
    sounds_dir.mkdir(exist_ok=True)
    (sounds_dir / "quiet-night.ogg").write_bytes(b"")
    (sounds_dir / "Rain Forest.mp3").write_bytes(b"")
    (sounds_dir / "ignored.txt").write_bytes(b"")
    return AmbianceService(
        state_file=tmp_path / "ambiances.json",
        grid_size=5,
        sounds_dir=sounds_dir,
        floor_elevations=(0, 40),
    )


def builder(*, x: int = 2, y: int = 2, z: int = 0) -> ClientConnection:
    """Return a minimal caller for direct service tests."""

    return ClientConnection(
        websocket=SimpleNamespace(),  # type: ignore[arg-type]
        id="builder",
        x=x,
        y=y,
        z=z,
    )


def test_catalog_is_sorted_and_quotes_asset_filenames(tmp_path: Path) -> None:
    """Only supported files become deterministic, client-safe catalog entries."""

    service = make_service(tmp_path)

    assert [sound_type.id for sound_type in service.ambiance_types] == [
        "quiet-night",
        "Rain Forest",
    ]
    assert service.ambiance_types[0].title == "Quiet Night"
    assert service.ambiance_types[1].url == "/sounds/ambiances/Rain%20Forest.mp3"


def test_catalog_skips_one_asset_with_invalid_display_metadata(tmp_path: Path) -> None:
    """A malformed filename cannot prevent valid ambiance types from loading."""

    sounds_dir = tmp_path / "ambiances"
    sounds_dir.mkdir()
    (sounds_dir / ("x" * 129 + ".ogg")).write_bytes(b"")
    (sounds_dir / "valid.ogg").write_bytes(b"")

    service = AmbianceService(
        state_file=None,
        grid_size=5,
        sounds_dir=sounds_dir,
        floor_elevations=(0, 40),
    )

    assert [sound_type.id for sound_type in service.ambiance_types] == ["valid"]


def test_add_rejects_invalid_floor(tmp_path: Path) -> None:
    """A region may only be added on one of the server's configured floors."""

    service = make_service(tmp_path)

    with pytest.raises(AmbianceError, match="valid floor"):
        service.add_ambiance(builder(z=1))

    assert service.ambiances == {}


def test_add_rejects_empty_catalog(tmp_path: Path) -> None:
    """Adding an ambiance fails cleanly when no supported asset exists."""

    sounds_dir = tmp_path / "empty-ambiances"
    sounds_dir.mkdir()
    service = AmbianceService(
        state_file=None,
        grid_size=5,
        sounds_dir=sounds_dir,
        floor_elevations=(0, 40),
    )

    with pytest.raises(AmbianceError, match="No ambiance sounds"):
        service.add_ambiance(builder())

    assert service.ambiances == {}


def test_overlapping_regions_are_allowed(tmp_path: Path) -> None:
    """Independent ambiance sources may cover the same tile."""

    service = make_service(tmp_path)
    first = service.add_ambiance(builder(x=2, y=2))
    second = service.add_ambiance(builder(x=2, y=2))

    assert first.id != second.id
    assert len(service.ambiances) == 2


@pytest.mark.parametrize(
    ("field", "value"),
    (
        ("name", ""),
        ("volume", -1),
        ("volume", 101),
        ("volume", 1.5),
        ("fade_distance", -1),
        ("fade_distance", float("nan")),
        ("fade_distance", float("inf")),
        ("fade_distance", float("-inf")),
    ),
)
def test_invalid_property_update_is_atomic(
    tmp_path: Path, field: str, value: object
) -> None:
    """Rejected blank, range, type, and finite-value edits preserve the region."""

    service = make_service(tmp_path)
    region = service.add_ambiance(builder())
    original = region.model_copy(deep=True)

    with pytest.raises(AmbianceError):
        if field == "name":
            service.update_ambiance(region.id, name=cast(str, value))
        elif field == "volume":
            service.update_ambiance(region.id, volume=cast(int, value))
        else:
            service.update_ambiance(region.id, fade_distance=cast(float, value))

    assert service.ambiances[region.id] == original


def test_shrinking_one_cell_region_below_positive_area_is_atomic(
    tmp_path: Path,
) -> None:
    """A one-cell rectangle cannot be shrunk into an empty region."""

    service = make_service(tmp_path)
    region = service.add_ambiance(builder())

    with pytest.raises(AmbianceError, match="positive area"):
        service.resize_ambiance(region.id, edge="east", delta=-1)

    assert service.ambiances[region.id] == region


def test_regions_validate_geometry_and_persist_missing_assets(tmp_path: Path) -> None:
    """Relative edits remain atomic and a removed asset does not drop a region."""

    service = make_service(tmp_path)
    region = service.add_ambiance(builder(x=1, y=1, z=40))
    updated = service.resize_ambiance(region.id, edge="east", delta=1)
    updated = service.slide_ambiance(updated.id, axis="y", delta=1)
    updated = service.update_ambiance(
        updated.id,
        name="Rainy",
        volume=0,
        fade_distance=100,
    )
    service.save_state()

    (tmp_path / "ambiances" / "quiet-night.ogg").unlink()
    reloaded = AmbianceService(
        state_file=tmp_path / "ambiances.json",
        grid_size=5,
        sounds_dir=tmp_path / "ambiances",
        floor_elevations=(0, 40),
    )
    assert reloaded.ambiances[region.id] == updated

    with pytest.raises(AmbianceError, match="Unknown ambiance sound"):
        reloaded.update_ambiance(region.id, sound_id="missing")
    assert reloaded.ambiances[region.id] == updated

    moved = reloaded.slide_ambiance(region.id, axis="x", delta=1)
    moved = reloaded.slide_ambiance(region.id, axis="x", delta=1)
    with pytest.raises(AmbianceError, match="outside"):
        reloaded.slide_ambiance(region.id, axis="x", delta=1)
    assert reloaded.ambiances[region.id] == moved


def test_invalid_persisted_state_is_rejected_transactionally(tmp_path: Path) -> None:
    """One malformed entry cannot leave a partially loaded ambiance map."""

    service = make_service(tmp_path)
    region = service.add_ambiance(builder())
    service.save_state()
    valid_payload = json.loads((tmp_path / "ambiances.json").read_text())
    valid_payload.append({"id": region.id, "name": "duplicate"})
    (tmp_path / "ambiances.json").write_text(json.dumps(valid_payload))

    reloaded = make_service(tmp_path)

    assert reloaded.ambiances == {}


@pytest.mark.asyncio
async def test_packet_mutations_require_permission_and_publish_before_result(
    make_world, tmp_path: Path
) -> None:
    """Permission checks, hydration, and delete broadcasts use server state."""

    sounds_dir = tmp_path / "ambiances"
    sounds_dir.mkdir()
    (sounds_dir / "city.ogg").write_bytes(b"")
    world: World = make_world(
        state_file=tmp_path / "items.json",
        auth_db_path=tmp_path / "auth.db",
        ambiance_sounds_dir=sounds_dir,
    )
    server, transport = world.server, world.transport
    denied = world.join("denied", permissions=set(), client_id="denied")
    editor = world.join(
        "editor",
        x=2,
        y=2,
        z=40,
        permissions={"world.structure.edit"},
        client_id="editor",
    )

    await server._handle_message(denied, json.dumps({"type": "ambiance_add"}))
    denied_result = transport.last_packet_of_type(denied, AmbianceActionResultPacket)
    assert denied_result.ok is False

    transport.clear()
    await server._handle_message(editor, json.dumps({"type": "ambiance_add"}))
    upsert = transport.last_packet_of_type(editor, AmbianceUpsertPacket)
    result = transport.last_packet_of_type(editor, AmbianceActionResultPacket)
    editor_packets = transport.packets_to(editor)
    assert editor_packets.index(upsert) < editor_packets.index(result)
    assert result.ok is True
    region_id = upsert.ambiance.id

    await server._send_welcome(denied)
    welcome = transport.last_packet_of_type(denied, WelcomePacket)
    assert [region["id"] for region in welcome.ambiances or []] == [region_id]
    assert welcome.worldConfig is not None
    assert welcome.worldConfig["ambianceTypes"][0]["id"] == "city"

    transport.clear()
    await server._handle_message(
        editor,
        json.dumps(
            {
                "type": "ambiance_update",
                "ambianceId": region_id,
                "name": "Garden",
            }
        ),
    )
    assert (
        transport.last_packet_of_type(editor, AmbianceActionResultPacket).message
        == "Garden"
    )

    transport.clear()
    await server._handle_message(
        editor,
        json.dumps(
            {
                "type": "ambiance_resize",
                "ambianceId": region_id,
                "edge": "east",
                "delta": 1,
            }
        ),
    )
    assert (
        transport.last_packet_of_type(editor, AmbianceActionResultPacket).message
        == "End X: 3"
    )

    transport.clear()
    await server._handle_message(
        editor,
        json.dumps(
            {
                "type": "ambiance_slide",
                "ambianceId": region_id,
                "axis": "y",
                "delta": 1,
            }
        ),
    )
    assert (
        transport.last_packet_of_type(editor, AmbianceActionResultPacket).message
        == "Y: 3 to 3"
    )

    transport.clear()
    await server._handle_message(
        editor,
        json.dumps(
            {
                "type": "ambiance_update",
                "ambianceId": region_id,
                "volume": 50,
            }
        ),
    )
    assert (
        transport.last_packet_of_type(editor, AmbianceActionResultPacket).message
        == "50 percent"
    )

    transport.clear()
    await server._handle_message(
        editor,
        json.dumps({"type": "ambiance_delete", "ambianceId": region_id}),
    )
    assert (
        transport.last_packet_of_type(denied, AmbianceRemovePacket).ambianceId
        == region_id
    )
    assert transport.last_packet_of_type(editor, AmbianceActionResultPacket).ok is True


@pytest.mark.asyncio
async def test_packet_mutations_without_permission_leave_existing_region_unchanged(
    make_world, tmp_path: Path
) -> None:
    """Every ambiance mutation is denied without changing the authoritative map."""

    sounds_dir = tmp_path / "ambiances"
    sounds_dir.mkdir()
    (sounds_dir / "city.ogg").write_bytes(b"")
    world: World = make_world(
        state_file=tmp_path / "items.json",
        auth_db_path=tmp_path / "auth.db",
        ambiance_sounds_dir=sounds_dir,
    )
    server, transport = world.server, world.transport
    editor = world.join(
        "editor",
        x=2,
        y=2,
        permissions={"world.structure.edit"},
        client_id="editor",
    )
    await server._handle_message(editor, json.dumps({"type": "ambiance_add"}))
    region = next(iter(server.ambiance_service.ambiances.values()))
    original = region.model_copy(deep=True)
    denied = world.join("denied", permissions=set(), client_id="denied")
    transport.clear()

    packets = (
        {
            "type": "ambiance_update",
            "ambianceId": region.id,
            "name": "Intrusion",
        },
        {
            "type": "ambiance_resize",
            "ambianceId": region.id,
            "edge": "east",
            "delta": 1,
        },
        {
            "type": "ambiance_slide",
            "ambianceId": region.id,
            "axis": "x",
            "delta": 1,
        },
        {"type": "ambiance_delete", "ambianceId": region.id},
    )
    for packet in packets:
        await server._handle_message(denied, json.dumps(packet))

    results = transport.packets_of_type(denied, AmbianceActionResultPacket)
    assert [result.action for result in results] == [
        "update",
        "resize",
        "slide",
        "delete",
    ]
    assert all(result.ok is False for result in results)
    assert server.ambiance_service.ambiances[region.id] == original
    assert transport.packets_of_type(denied, AmbianceRemovePacket) == []
