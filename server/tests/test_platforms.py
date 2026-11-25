"""Platform union geometry, persistence, and dependent world validation."""

import json
import uuid

import pytest

from app.platform_service import PlatformError, PlatformService
from app.models import (
    BroadcastPositionPacket,
    PlatformActionResultPacket,
    WorldRestoredPacket,
)


def rectangle(identifier, x1, y1, x2, y2, z=0):
    return dict(
        id=identifier, name=identifier, startX=x1, startY=y1, endX=x2, endY=y2, z=z
    )


def test_connected_bridge_island_and_diagonal_corner():
    geometry = PlatformService(state_file=None)
    geometry.restore_state(
        [
            rectangle("room", -3, -3, 0, 0),
            rectangle("bridge", 1, 0, 4, 0),
            rectangle("island", 5, 1, 6, 2),
            rectangle("upper", -3, -3, 0, 0, 40),
        ]
    )
    assert geometry.valid_step(0, 0, 0, 1, 0)
    assert not geometry.valid_step(4, 0, 0, 5, 1)
    assert not geometry.contains(4, 0, 40)
    assert geometry.covers_rectangle(-3, 0, 4, 0, 0)
    assert not geometry.covers_rectangle(-3, -1, 4, 0, 0)
    assert geometry.find_placement(8, 1, 0, (0, 0)) == (-3, 0)


def test_overlap_and_failed_mutation_preserve_original():
    geometry = PlatformService(state_file=None)
    before = geometry.dump_state()
    with pytest.raises(PlatformError, match="overlaps"):
        geometry.mutate(None, rectangle("overlap", 40, 40, 45, 45))
    assert geometry.dump_state() == before
    added = geometry.mutate(
        None, dict(name="Bridge", startX=45, endX=41, startY=-1, endY=-1, z=0)
    )
    assert (added.startX, added.endX) == (41, 45)
    with pytest.raises(PlatformError, match="support"):
        geometry.mutate(
            added.id,
            {},
            delete=True,
            validate_world=lambda _geometry: (_ for _ in ()).throw(
                PlatformError("support")
            ),
        )
    assert added.id in geometry.platforms
    renamed = geometry.mutate(
        added.id,
        {"name": "Renamed bridge"},
        validate_world=lambda _geometry: (_ for _ in ()).throw(
            PlatformError("support")
        ),
    )
    assert renamed.name == "Renamed bridge"


def test_restart_keeps_authored_platforms_and_deleted_defaults(tmp_path):
    path = tmp_path / "platforms.json"
    geometry = PlatformService(state_file=path)
    geometry.restore_state([rectangle("island", -10, 100, 2, 105, -40)])
    geometry.save_state()
    restarted = PlatformService(state_file=path)
    assert restarted.dump_state() == geometry.dump_state()
    assert not restarted.contains(0, 0, 0)
    assert restarted.spawn() == (-10, 100, -40)
    assert json.loads(path.read_text())[0]["id"] == "island"


def test_extreme_rectangles_are_checked_without_expanding_cells():
    geometry = PlatformService(state_file=None)
    geometry.restore_state([rectangle("large", -1000000, -1000000, 1000000, 1000000)])
    assert geometry.covers_rectangle(-999999, -999999, 999999, 999999, 0)


def test_fallback_prefers_origin_then_first_platform_after_edit_and_restart(tmp_path):
    path = tmp_path / "platforms.json"
    geometry = PlatformService(state_file=path)
    geometry.restore_state(
        [
            rectangle("first", 10, 20, 15, 25, 80),
            rectangle("lower", -10, -20, -5, -15, -40),
            rectangle("origin", -1, -1, 1, 1),
        ]
    )
    assert geometry.spawn() == (0, 0, 0)
    geometry.mutate("origin", {}, delete=True)
    geometry.mutate("first", {"name": "Renamed first", "startX": 9})
    assert geometry.spawn() == (9, 20, 80)
    geometry.save_state()
    assert PlatformService(state_file=path).spawn() == (9, 20, 80)


@pytest.mark.asyncio
@pytest.mark.parametrize("origin_exists", [True, False])
async def test_delete_relocates_occupants_and_persists_and_broadcasts_positions(
    make_world, tmp_path, origin_exists
):
    world = make_world(auth_db_path=tmp_path / "auth.db")
    server = world.server
    remaining = [rectangle("first", 100, 200, 105, 205, 80)]
    if origin_exists:
        remaining.append(rectangle("origin", -2, -2, 2, 2))
    server.platform_service.restore_state(
        [rectangle("removed", 10, 10, 15, 15, 40), *remaining]
    )
    session = server.auth_service.register("deleted_platform_user", "password99")
    builder = world.join("Builder", x=11, y=11, z=40)
    occupant = world.join(
        "Occupant", x=12, y=13, z=40, user_id=session.user.id, facing_deg=90
    )
    unaffected = world.join("Observer", x=101, y=201, z=80)
    server._persist_client_position(occupant, force=True)

    await server._handle_message(
        builder,
        json.dumps(dict(type="platform_delete", platformId="removed")),
    )

    assert world.transport.last_packet_of_type(builder, PlatformActionResultPacket).ok
    assert "removed" not in server.platform_service.platforms
    expected = (0, 0, 0) if origin_exists else (100, 200, 80)
    assert (builder.x, builder.y, builder.z) == expected
    assert (occupant.x, occupant.y, occupant.z) == expected
    assert occupant.facing_deg == 90
    assert (unaffected.x, unaffected.y, unaffected.z) == (101, 201, 80)
    saved = server.auth_service.get_user_by_id(session.user.id)
    assert saved is not None
    assert (saved.last_x, saved.last_y, saved.last_z) == expected
    for recipient in (builder, occupant, unaffected):
        updates = world.transport.packets_of_type(recipient, BroadcastPositionPacket)
        assert {packet.id for packet in updates} == {builder.id, occupant.id}
        assert all((packet.x, packet.y, packet.z) == expected for packet in updates)


@pytest.mark.asyncio
@pytest.mark.parametrize("floor,expected", [(40, (0, 0, 0)), (0, (5, 0, 0))])
async def test_shrink_moves_only_users_who_lose_support(world, floor, expected):
    builder = world.join("Builder", x=5, y=4, z=floor)
    displaced = world.join("Displaced", x=4, y=4, z=floor)
    platform_id = "ground" if floor == 0 else "second-floor"
    await world.server._handle_message(
        builder,
        json.dumps(dict(type="platform_update", platformId=platform_id, startX=5)),
    )
    assert world.transport.last_packet_of_type(builder, PlatformActionResultPacket).ok
    assert (builder.x, builder.y, builder.z) == (5, 4, floor)
    assert (displaced.x, displaced.y, displaced.z) == expected
    for viewer in (builder, displaced):
        updates = world.transport.packets_of_type(viewer, BroadcastPositionPacket)
        expected_ids = (
            {builder.id, displaced.id} if viewer is builder else {displaced.id}
        )
        assert {packet.id for packet in updates} == expected_ids
    retained_position = next(
        packet
        for packet in world.transport.packets_of_type(builder, BroadcastPositionPacket)
        if packet.id == builder.id
    )
    assert (retained_position.x, retained_position.y, retained_position.z) == (
        5,
        4,
        floor,
    )


@pytest.mark.asyncio
async def test_resize_resynchronizes_retained_player_after_list_travel_is_cancelled(
    world,
):
    builder = world.join("Builder", x=20, y=4)
    traveller = world.join("Traveller", x=10, y=4)
    await world.server._handle_message(
        builder,
        json.dumps(dict(type="platform_update", platformId="ground", startX=5)),
    )
    # The traveller's original animation started at x=1, which no longer exists.
    # Its browser cancels at a fractional x while its server cell remains valid.
    position = next(
        packet
        for packet in world.transport.packets_of_type(
            traveller, BroadcastPositionPacket
        )
        if packet.id == traveller.id
    )
    assert (position.x, position.y, position.z) == (10, 4, 0)
    await world.server._handle_message(
        traveller,
        json.dumps(dict(type="update_position", x=11, y=4, z=0)),
    )
    assert (traveller.x, traveller.y, traveller.z) == (11, 4, 0)


@pytest.mark.asyncio
async def test_item_in_trimmed_area_blocks_resize_and_relocation(world):
    builder = world.join("Builder", x=1, y=1)
    server = world.server
    server.item_service.add_item(server.item_service.default_item(builder, "widget"))
    await server._handle_message(
        builder, json.dumps(dict(type="platform_update", platformId="ground", startX=5))
    )
    result = world.transport.last_packet_of_type(builder, PlatformActionResultPacket)
    assert not result.ok and "support" in result.message
    assert server.platform_service.platforms["ground"].startX == 0
    assert (builder.x, builder.y, builder.z) == (1, 1, 0)
    assert not world.transport.packets_of_type(builder, BroadcastPositionPacket)


@pytest.mark.asyncio
async def test_platform_deleted_between_welcome_and_activation(world):
    builder = world.join("Builder")
    account = world.server.auth_service.register(
        f"joining_{uuid.uuid4().hex[:8]}", "password99"
    )
    joining = world.connect(
        "Joining", authenticated=True, user_id=account.user.id, x=10, y=10, z=40
    )
    await world.server._handle_message(
        builder, json.dumps(dict(type="platform_delete", platformId="second-floor"))
    )
    await world.server._handle_message(joining, json.dumps(dict(type="welcome_ready")))
    assert (joining.x, joining.y, joining.z) == (0, 0, 0)
    refresh = world.transport.last_packet_of_type(joining, WorldRestoredPacket)
    assert [platform["id"] for platform in refresh.platforms] == ["ground"]
    assert world.transport.last_packet_of_type(joining, BroadcastPositionPacket).z == 0


@pytest.mark.asyncio
async def test_delete_rejected_by_item_does_not_relocate_occupants(world):
    world.server.platform_service.mutate(
        None, dict(name="Island", startX=100, startY=100, endX=105, endY=105, z=40)
    )
    island = next(
        platform
        for platform in world.server.platform_service.platforms.values()
        if platform.name == "Island"
    )
    builder = world.join("Builder", x=101, y=102, z=40)
    item = world.server.item_service.default_item(builder, "widget")
    world.server.item_service.add_item(item)
    await world.server._handle_message(
        builder, json.dumps(dict(type="platform_delete", platformId=island.id))
    )
    result = world.transport.last_packet_of_type(builder, PlatformActionResultPacket)
    assert not result.ok and "support" in result.message
    assert island.id in world.server.platform_service.platforms
    assert (builder.x, builder.y, builder.z) == (101, 102, 40)
    assert not world.transport.packets_of_type(builder, BroadcastPositionPacket)


@pytest.mark.asyncio
async def test_delete_final_platform_is_rejected_without_moving_player(world):
    world.server.platform_service.restore_state([rectangle("last", 5, 6, 7, 8)])
    builder = world.join("Builder", x=6, y=7)
    await world.server._handle_message(
        builder, json.dumps(dict(type="platform_delete", platformId="last"))
    )
    assert not world.transport.last_packet_of_type(
        builder, PlatformActionResultPacket
    ).ok
    assert "last" in world.server.platform_service.platforms
    assert (builder.x, builder.y, builder.z) == (6, 7, 0)
    assert not world.transport.packets_of_type(builder, BroadcastPositionPacket)


def test_corrupt_geometry_cannot_reinterpret_other_saved_world_files(
    make_world, tmp_path
):
    path = tmp_path / "platforms.json"
    path.write_text("[{truncated")
    structures = tmp_path / "structures.json"
    structures.write_text("important authored geometry")
    with pytest.raises(PlatformError, match="unreadable"):
        make_world(state_file=tmp_path / "items.json")
    assert structures.read_text() == "important authored geometry"
    assert path.read_text() == "[{truncated"
    assert not list(tmp_path.glob("*.unreadable-*"))


@pytest.mark.asyncio
async def test_platform_packets_validate_permissions_dependencies_and_request_identity(
    world,
):
    builder = world.join("Builder", x=4, y=4)
    denied = world.join("Guest", permissions=set())
    fields = dict(name="Bridge", startX=41, startY=4, endX=45, endY=4, z=0)
    await world.server._handle_message(
        denied, json.dumps(dict(type="platform_add", requestId="denied", **fields))
    )
    result = world.transport.last_packet_of_type(denied, PlatformActionResultPacket)
    assert not result.ok and result.requestId == "denied"
    await world.server._handle_message(
        builder, json.dumps(dict(type="platform_add", requestId="added", **fields))
    )
    result = world.transport.last_packet_of_type(builder, PlatformActionResultPacket)
    assert result.ok and result.requestId == "added"
    item = world.server.item_service.default_item(builder, "widget")
    item.x, item.y = 43, 4
    world.server.item_service.add_item(item)
    await world.server._handle_message(
        builder,
        json.dumps(
            dict(
                type="platform_delete", platformId=result.platformId, requestId="delete"
            )
        ),
    )
    rejected = world.transport.last_packet_of_type(builder, PlatformActionResultPacket)
    assert not rejected.ok and "support" in rejected.message
    assert result.platformId in world.server.platform_service.platforms


def test_legacy_checkpoint_upgrade_and_new_generation_missing_platforms_fail_closed(
    tmp_path,
):
    from .test_world_checkpoints import create_store
    from app.world_state import WorldStateStore, CheckpointError

    path = tmp_path / "items.json"
    legacy, *_ = create_store(path)
    checkpoint = legacy.capture("Old two floors", "owner")
    preview = legacy.preview(checkpoint["id"])
    legacy.restore(checkpoint["id"], preview["worldRevision"], "owner")

    from app.item_service import ItemService
    from app.structure_service import StructureService
    from app.ambiance_service import AmbianceService
    from app.region_service import RegionService

    upgraded = WorldStateStore(path)
    selected = upgraded.active_state_file()
    geometry = PlatformService(
        state_file=selected.with_name("platforms.json"), grid_size=50
    )
    upgraded.bind_services(
        ItemService(selected, geometry=geometry),
        StructureService(
            state_file=selected.with_name("structures.json"),
            grid_size=50,
            presets={},
            geometry=geometry,
        ),
        AmbianceService(
            state_file=selected.with_name("ambiances.json"),
            grid_size=50,
            geometry=geometry,
        ),
        RegionService(
            state_file=selected.with_name("regions.json"),
            grid_size=50,
            geometry=geometry,
        ),
        geometry,
    )
    assert geometry.contains(49, 49, 40)
    old_preview = upgraded.preview(checkpoint["id"])
    assert old_preview["changes"]["platforms"]["added"] == 0
    upgraded.restore(checkpoint["id"], old_preview["worldRevision"], "owner")
    active = upgraded.active_state_file()
    assert WorldStateStore(path).active_state_file() == active
    active.with_name("platforms.json").unlink()
    with pytest.raises(CheckpointError, match="platform dataset"):
        WorldStateStore(path)
