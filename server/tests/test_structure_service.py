"""Focused tests for authoritative wall-run geometry and persistence."""

from pathlib import Path

import pytest

from app.client import ClientConnection
from app.structure_service import StructureError, StructureService


class FakeWebSocket:
    """Minimal websocket stand-in for a structure-building client."""


def service(tmp_path: Path) -> StructureService:
    """Create a structure service with one test preset."""

    return StructureService(
        state_file=tmp_path / "structures.json",
        grid_size=10,
        presets={
            "solid": {
                "title": "Wall",
                "movementBlocked": True,
                "soundTransmission": 0.0,
                "occlusionLowpassHz": 800,
                "height": 40,
                "contactSound": "/sounds/wall.ogg",
            },
            "curtain": {
                "title": "Curtain",
                "movementBlocked": False,
                "soundTransmission": 0.5,
                "occlusionLowpassHz": 2200,
                "height": 40,
                "contactSound": "/sounds/wall.ogg",
            },
        },
    )


def builder() -> ClientConnection:
    """Return a builder standing away from world boundaries."""

    return ClientConnection(websocket=FakeWebSocket(), id="builder", x=4, y=4, z=0)  # type: ignore[arg-type]


def test_wall_run_resizes_and_persists(tmp_path: Path) -> None:
    structures = service(tmp_path)
    wall = structures.add_wall(builder(), preset_id="solid", direction="north")

    wall = structures.resize_wall(wall.id, endpoint="end", delta=1)
    assert wall.length == 2
    assert structures.wall_endpoint(wall, "start") == (4, 5, 0)
    assert structures.wall_endpoint(wall, "finish") == (6, 5, 0)
    assert structures.blocking_wall_for_move(x=5, y=4, z=0, next_x=5, next_y=5) == wall

    structures.save_state()
    reloaded = service(tmp_path)
    assert reloaded.structures[wall.id] == wall


def test_wall_run_slides_and_rotates_around_its_start(tmp_path: Path) -> None:
    structures = service(tmp_path)
    wall = structures.add_wall(builder(), preset_id="solid", direction="north")
    wall = structures.resize_wall(wall.id, endpoint="end", delta=1)

    wall = structures.slide_wall(wall.id, delta=1)
    assert structures.wall_endpoint(wall, "start") == (5, 5, 0)
    assert structures.wall_endpoint(wall, "finish") == (7, 5, 0)

    wall = structures.rotate_wall(wall.id, orientation="vertical")
    assert structures.wall_endpoint(wall, "start") == (5, 5, 0)
    assert structures.wall_endpoint(wall, "finish") == (5, 7, 0)


def test_failed_wall_rotation_preserves_the_original_run(tmp_path: Path) -> None:
    structures = service(tmp_path)
    edge_builder = builder()
    edge_builder.y = 9
    wall = structures.add_wall(edge_builder, preset_id="solid", direction="south")
    wall = structures.resize_wall(wall.id, endpoint="end", delta=1)

    with pytest.raises(StructureError, match="outside"):
        structures.rotate_wall(wall.id, orientation="vertical")

    assert structures.structures[wall.id] == wall
    assert structures.wall_endpoint(wall, "finish") == (6, 9, 0)


def test_diagonal_requires_both_origin_edges_to_be_blocked(tmp_path: Path) -> None:
    structures = service(tmp_path)
    north = structures.add_wall(builder(), preset_id="solid", direction="north")

    assert structures.blocking_wall_for_move(x=4, y=4, z=0, next_x=5, next_y=5) is None

    east = structures.add_wall(builder(), preset_id="solid", direction="east")
    assert structures.blocking_wall_for_move(x=4, y=4, z=0, next_x=5, next_y=5) in (
        north,
        east,
    )


def test_passable_curtain_is_reported_as_crossed_without_blocking(
    tmp_path: Path,
) -> None:
    structures = service(tmp_path)
    curtain = structures.add_wall(builder(), preset_id="curtain", direction="east")

    assert structures.walls_crossed_for_move(x=4, y=4, z=0, next_x=5, next_y=4) == [
        curtain
    ]
    assert structures.blocking_wall_for_move(x=4, y=4, z=0, next_x=5, next_y=4) is None


def test_overlapping_and_out_of_bounds_runs_are_rejected(tmp_path: Path) -> None:
    structures = service(tmp_path)
    wall = structures.add_wall(builder(), preset_id="solid", direction="north")
    with pytest.raises(StructureError, match="already occupies"):
        structures.add_wall(builder(), preset_id="solid", direction="north")

    edge_builder = builder()
    edge_builder.x = 9
    edge_wall = structures.add_wall(edge_builder, preset_id="solid", direction="south")
    with pytest.raises(StructureError, match="outside"):
        structures.resize_wall(edge_wall.id, endpoint="end", delta=1)
    assert structures.structures[wall.id] == wall


def test_wall_acoustic_properties_are_independently_editable(tmp_path: Path) -> None:
    structures = service(tmp_path)
    wall = structures.add_wall(builder(), preset_id="solid", direction="north")

    updated = structures.update_wall(
        wall.id,
        preset_id=None,
        sound_transmission=0.35,
        occlusion_lowpass_hz=3200,
        contact_sound="/sounds/custom-wall.ogg",
    )

    assert updated.soundTransmission == 0.35
    assert updated.occlusionLowpassHz == 3200
    assert updated.contactSound == "/sounds/custom-wall.ogg"
    assert updated.preset == "solid"
    assert (
        structures.blocking_wall_for_move(x=4, y=4, z=0, next_x=4, next_y=5) == updated
    )

    reset = structures.update_wall(
        wall.id,
        preset_id="curtain",
        sound_transmission=None,
        occlusion_lowpass_hz=None,
        contact_sound=None,
    )
    assert reset.title == "Curtain"
    assert reset.preset == "curtain"
    assert reset.movementBlocked is False
    assert reset.soundTransmission == 0.5
    assert reset.occlusionLowpassHz == 2200
