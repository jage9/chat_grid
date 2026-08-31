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
                "height": 40,
                "contactSound": "/sounds/wall.ogg",
            },
            "curtain": {
                "title": "Curtain",
                "movementBlocked": False,
                "soundTransmission": 0.5,
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
    assert structures.blocking_wall_for_move(x=5, y=4, z=0, next_x=5, next_y=5) == wall

    structures.save_state()
    reloaded = service(tmp_path)
    assert reloaded.structures[wall.id] == wall


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
