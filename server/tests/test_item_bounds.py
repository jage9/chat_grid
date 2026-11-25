"""Variable widget bounds through normal editing, carrying and persistence."""

import json

import pytest

from app.item_geometry import item_bounds, move_item
from app.item_service import ItemService
from app.models import ItemActionResultPacket


async def action(world, actor, packet):
    await world.server._handle_message(actor, json.dumps(packet))
    return world.transport.packets_of_type(actor, ItemActionResultPacket)[-1]


@pytest.mark.asyncio
async def test_widget_size_edits_use_current_anchor_and_derived_display(world):
    actor = world.join("owner", x=10, y=12, z=40)
    service = world.server.item_service
    widget = service.default_item(actor, "widget")
    service.add_item(widget)
    runtime = world.server.item_runtime
    display = runtime.outbound_item(widget).display
    assert {key: display[key] for key in ("width", "depth", "height")} == {
        "width": "1",
        "depth": "1",
        "height": "1",
    }
    result = await action(
        world,
        actor,
        {
            "type": "item_update",
            "itemId": widget.id,
            "params": {"width": 3, "depth": 2, "height": 5},
        },
    )
    assert result.ok
    assert item_bounds(widget) == (10, 12, 40, 12, 13, 44)
    assert not {"width", "depth", "height"} & widget.params.keys()
    display = runtime.outbound_item(widget).display
    assert {key: display[key] for key in ("width", "depth", "height")} == {
        "width": "3",
        "depth": "2",
        "height": "5",
    }
    move_item(widget, 15, 18, 40)
    actor.x, actor.y = 15, 18
    result = await action(
        world,
        actor,
        {
            "type": "item_update",
            "itemId": widget.id,
            "params": {"width": 1, "depth": 1, "height": 1},
        },
    )
    assert result.ok
    assert item_bounds(widget) == (15, 18, 40, 15, 18, 40)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "params",
    [
        {"width": 0},
        {"depth": -1},
        {"height": 1001},
        {"width": True},
        {"width": 2.5},
        {"height": "3"},
        {"width": 2, "endX": 40},
        {"width": 3},
    ],
)
async def test_size_validation_keeps_rejected_edits_atomic(world, params):
    actor = world.join("owner", x=39, y=39)
    item = world.server.item_service.default_item(actor, "widget")
    world.server.item_service.add_item(item)
    result = await action(
        world,
        actor,
        {
            "type": "item_update",
            "itemId": item.id,
            "title": "Changed",
            "params": params,
        },
    )
    assert not result.ok
    assert item.title == "widget"
    assert item_bounds(item) == (39, 39, 0, 39, 39, 0)


@pytest.mark.asyncio
async def test_widget_resize_interaction_duplicate_and_restore(world):
    actor = world.join("owner", x=10, y=10)
    service = world.server.item_service
    item = service.default_item(actor, "widget")
    service.add_item(item)
    result = await action(
        world,
        actor,
        {
            "type": "item_update",
            "itemId": item.id,
            "params": {"endX": 12, "endY": 11, "endZ": 40},
        },
    )
    assert result.ok
    assert service.item_occupies_position(item, x=12, y=11, z=40)
    assert not service.item_occupies_position(item, x=13, y=11, z=40)
    actor.x, actor.y = 12, 11
    result = await action(world, actor, {"type": "item_duplicate", "itemId": item.id})
    assert result.ok
    duplicate = service.items[result.itemId]
    assert item_bounds(duplicate) == (12, 11, 0, 14, 12, 40)
    restored = ItemService()
    restored.restore_state(service.dump_state())
    assert item_bounds(restored.items[item.id]) == item_bounds(item)


@pytest.mark.asyncio
async def test_resize_rejection_is_atomic_and_whole_base_must_fit(world):
    actor = world.join("owner", x=39, y=39)
    item = world.server.item_service.default_item(actor, "widget")
    world.server.item_service.add_item(item)
    for params in ({"endX": 41}, {"endX": 38}, {"endY": True}, {"endZ": 1001}):
        result = await action(
            world,
            actor,
            {
                "type": "item_update",
                "itemId": item.id,
                "title": "Changed",
                "params": params,
            },
        )
        assert not result.ok
        assert item.title == "widget"
        assert item.endX is None


@pytest.mark.asyncio
async def test_carried_widget_preserves_size_and_disconnect_uses_fitting_position(
    world,
):
    actor = world.join("owner", x=10, y=10)
    service = world.server.item_service
    item = service.default_item(actor, "widget")
    item.endX, item.endY, item.endZ = 12, 11, 2
    service.add_item(item)
    result = await action(world, actor, {"type": "item_pickup", "itemId": item.id})
    assert result.ok
    actor.x, actor.y = 40, 40
    await world.server.item_runtime.sync_carried_items(actor)
    assert item_bounds(item) == (40, 40, 0, 42, 41, 2)
    result = await action(
        world, actor, {"type": "item_drop", "itemId": item.id, "x": 40, "y": 40, "z": 0}
    )
    assert not result.ok
    restored = ItemService()
    restored.restore_state(service.dump_state())
    assert item_bounds(restored.items[item.id]) == (10, 10, 0, 12, 11, 2)
    await world.server.item_runtime.finish_client_disconnect(actor)
    assert item_bounds(item) == (10, 10, 0, 12, 11, 2)
    assert item.carrierId is None


def test_point_records_keep_single_cell_and_move_optional_endpoints(world):
    actor = world.join("owner")
    item = world.server.item_service.default_item(actor, "widget")
    assert item_bounds(item) == (20, 20, 0, 20, 20, 0)
    item.endX = 22
    move_item(item, -5, -4, 40)
    assert item_bounds(item) == (-5, -4, 40, -3, -4, 40)


@pytest.mark.asyncio
async def test_carried_widget_resize_refreshes_resting_support(world):
    actor = world.join("owner", x=40, y=40)
    server = world.server
    service = server.item_service
    item = service.default_item(actor, "widget")
    service.add_item(item)
    assert (await action(world, actor, {"type": "item_pickup", "itemId": item.id})).ok
    actor.x, actor.y = 10, 10
    await server.item_runtime.sync_carried_items(actor)
    assert (
        await action(
            world,
            actor,
            {"type": "item_update", "itemId": item.id, "params": {"endX": 12}},
        )
    ).ok
    assert service.resting_positions[item.id] == (10, 10, 0)
    await server._handle_message(
        actor, json.dumps({"type": "platform_delete", "platformId": "second-floor"})
    )
    assert "second-floor" not in server.platform_service.platforms


@pytest.mark.asyncio
async def test_carried_widget_can_edit_settings_when_base_overhangs(world):
    actor = world.join("owner", x=10, y=10)
    service = world.server.item_service
    item = service.default_item(actor, "widget")
    item.endX = 12
    service.add_item(item)
    assert (await action(world, actor, {"type": "item_pickup", "itemId": item.id})).ok
    actor.x, actor.y = 40, 40
    await world.server.item_runtime.sync_carried_items(actor)
    result = await action(
        world,
        actor,
        {"type": "item_update", "itemId": item.id, "params": {"enabled": False}},
    )
    assert result.ok
    assert item.params["enabled"] is False
    assert service.resting_positions[item.id] == (10, 10, 0)


@pytest.mark.asyncio
async def test_bounds_keep_ownership_and_fixed_type_validation(world):
    owner = world.join("owner")
    visitor = world.join("visitor", permissions={"item.edit.own"})
    service = world.server.item_service
    widget = service.default_item(owner, "widget")
    service.add_item(widget)
    result = await action(
        world,
        visitor,
        {"type": "item_update", "itemId": widget.id, "params": {"width": 3}},
    )
    assert not result.ok
    assert widget.endX is None
    dice = service.default_item(owner, "dice")
    service.add_item(dice)
    result = await action(
        world, owner, {"type": "item_update", "itemId": dice.id, "params": {"width": 3}}
    )
    assert not result.ok
    assert dice.endX is None


def test_checkpoint_restores_sized_widget_on_nondefault_platform(make_world, tmp_path):
    path = tmp_path / "items.json"
    world = make_world(state_file=path)
    geometry = world.server.platform_service
    geometry.mutate(
        None,
        {
            "name": "Studio",
            "startX": -20,
            "startY": 100,
            "endX": -10,
            "endY": 110,
            "z": 80,
        },
    )
    actor = world.join("owner", x=-20, y=100, z=80)
    service = world.server.item_service
    widget = service.default_item(actor, "widget")
    widget.endX, widget.endY, widget.endZ = -17, 103, 100
    service.add_item(widget)
    checkpoint = world.server.world_store.capture("Sized widget", actor.id)
    service.remove_item(widget.id)
    preview = world.server.world_store.preview(checkpoint["id"])
    world.server.world_store.restore(
        checkpoint["id"], preview["worldRevision"], actor.id
    )
    assert item_bounds(service.items[widget.id]) == (-20, 100, 80, -17, 103, 100)
    restarted = make_world(state_file=path)
    assert item_bounds(restarted.server.items[widget.id]) == (
        -20,
        100,
        80,
        -17,
        103,
        100,
    )


def test_legacy_carried_widget_on_custom_elevation_stays_supported(world):
    geometry = world.server.platform_service
    geometry.mutate(
        None,
        {"name": "Upper", "startX": 0, "startY": 0, "endX": 40, "endY": 40, "z": 80},
    )
    actor = world.join("owner", z=80)
    item = world.server.item_service.default_item(actor, "widget")
    item.carrierId = actor.id
    raw = item.model_dump()
    restored = ItemService(geometry=geometry)
    restored.restore_state([raw])
    assert restored.items[item.id].z == 80
    assert restored.items[item.id].carrierId is None
