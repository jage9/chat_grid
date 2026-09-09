"""Server-authoritative item teleport transition tests."""

from __future__ import annotations

import asyncio
import json

import pytest

from app.models import (
    BroadcastPositionPacket,
    BroadcastTeleportCompletePacket,
    ItemActionResultPacket,
    ItemUpsertPacket,
    TeleportTransitionPacket,
)


class ControlledSleep:
    """Gate each injected transition half so tests advance time explicitly."""

    def __init__(self) -> None:
        self.calls: list[float] = []
        self._called = asyncio.Event()
        self._release_events: list[asyncio.Event] = []
        self._released = 0

    async def __call__(self, seconds: float) -> None:
        self.calls.append(seconds)
        release = asyncio.Event()
        self._release_events.append(release)
        self._called.set()
        await release.wait()

    async def wait_for_call(self, count: int) -> None:
        """Wait until the runtime reaches one requested half-transition."""

        while len(self.calls) < count:
            self._called.clear()
            if len(self.calls) >= count:
                return
            await self._called.wait()

    def release_next(self) -> None:
        """Release the next pending half-transition."""

        if self._released >= len(self._release_events):
            raise AssertionError("no pending transition half to release")
        self._release_events[self._released].set()
        self._released += 1


async def _drain_transition_half(sleep: ControlledSleep, count: int) -> None:
    """Release one gate after its task is known to be waiting."""

    await sleep.wait_for_call(count)
    sleep.release_next()


async def _wait_for_transition_end(server, client) -> None:
    """Yield until the runtime removes the actor's active reservation."""

    for _ in range(20):
        if not server.item_runtime.is_teleporting(client):
            return
        await asyncio.sleep(0)
    raise AssertionError("teleport transition did not finish")


@pytest.mark.asyncio
async def test_item_use_starts_authoritative_transition_and_moves_held_items(
    world,
) -> None:
    """A valid item intent starts, arrives, and completes on server timing."""

    server, transport = world.server, world.transport
    observer = world.join("observer", x=40, y=40)
    client = world.join("tester", x=5, y=6, z=0, client_id="u1", facing_deg=225)
    teleporter = server.item_service.default_item(client, "teleporter")
    teleporter.params["destination"] = "10, 11, 40"
    server.item_service.add_item(teleporter)
    held = server.item_service.default_item(client, "widget")
    held.carrierId = client.id
    server.item_service.add_item(held)
    sleep = ControlledSleep()
    server.item_runtime.teleport._sleep = sleep

    await server._handle_message(
        client, json.dumps({"type": "item_use", "itemId": teleporter.id})
    )

    action = transport.last_packet_of_type(client, ItemActionResultPacket)
    assert action.ok is True
    assert (client.x, client.y, client.z, client.facing_deg) == (5, 6, 0, 225)
    assert server.item_runtime.is_teleporting(client)
    starts = transport.packets_of_type(client, TeleportTransitionPacket)
    assert [
        (packet.phase, packet.x, packet.y, packet.z, packet.durationMs)
        for packet in starts
    ] == [("start", 10, 11, 40, 1000)]

    await _drain_transition_half(sleep, 1)
    await sleep.wait_for_call(2)
    assert (client.x, client.y, client.z, client.facing_deg) == (10, 11, 40, 225)
    assert (
        transport.last_packet_of_type(client, TeleportTransitionPacket).phase
        == "arrive"
    )
    position = transport.last_packet_of_type(observer, BroadcastPositionPacket)
    assert (position.x, position.y, position.z, position.facingDeg) == (10, 11, 40, 225)
    held_update = transport.last_packet_of_type(observer, ItemUpsertPacket)
    assert (held_update.item.x, held_update.item.y, held_update.item.z) == (10, 11, 40)

    sleep.release_next()
    await _wait_for_transition_end(server, client)
    assert not server.item_runtime.is_teleporting(client)
    assert (
        transport.last_packet_of_type(client, TeleportTransitionPacket).phase
        == "complete"
    )
    arrival = transport.last_packet_of_type(observer, BroadcastTeleportCompletePacket)
    assert (arrival.x, arrival.y, arrival.z, arrival.facingDeg) == (10, 11, 40, 225)


@pytest.mark.asyncio
async def test_destination_validation_precedes_cooldown_and_transition_start(
    world,
) -> None:
    """Invalid coordinates produce no success, cooldown, sound, or task."""

    server, transport = world.server, world.transport
    client = world.join("tester", x=5, y=6, client_id="u1")
    teleporter = server.item_service.default_item(client, "teleporter")
    teleporter.params["destination"] = "41, 6, 40"
    server.item_service.add_item(teleporter)

    await server._handle_message(
        client, json.dumps({"type": "item_use", "itemId": teleporter.id})
    )

    action = transport.last_packet_of_type(client, ItemActionResultPacket)
    assert action.ok is False
    assert "out of bounds" in action.message.lower()
    assert teleporter.id not in server.item_runtime.item_last_use_ms
    assert not server.item_runtime.is_teleporting(client)
    assert not transport.packets_of_type(client, TeleportTransitionPacket)

    teleporter.params["destination"] = "7, 8, 40"
    await server._handle_message(
        client, json.dumps({"type": "item_use", "itemId": teleporter.id})
    )
    assert transport.last_packet_of_type(client, ItemActionResultPacket).ok is True
    await server.item_runtime.teleport.shutdown()


@pytest.mark.asyncio
async def test_transition_rejects_duplicate_use_and_client_completion(world) -> None:
    """Movement, legacy completion, and another use cannot control an active task."""

    server, transport = world.server, world.transport
    observer = world.join("observer", x=40, y=40)
    client = world.join("tester", x=5, y=6, client_id="u1")
    teleporter = server.item_service.default_item(client, "teleporter")
    teleporter.params["destination"] = "10, 11, 0"
    server.item_service.add_item(teleporter)
    sleep = ControlledSleep()
    server.item_runtime.teleport._sleep = sleep

    await server._handle_message(
        client, json.dumps({"type": "item_use", "itemId": teleporter.id})
    )
    await server._handle_message(
        client, json.dumps({"type": "item_use", "itemId": teleporter.id})
    )
    await server._handle_message(
        client,
        json.dumps({"type": "item_secondary_use", "itemId": teleporter.id}),
    )
    assert (
        transport.last_packet_of_type(client, ItemActionResultPacket).action
        == "secondary_use"
    )
    assert transport.last_packet_of_type(client, ItemActionResultPacket).ok is False
    await server._handle_message(
        client, json.dumps({"type": "update_facing", "facingDeg": 90})
    )
    await server._handle_message(
        client, json.dumps({"type": "turn", "direction": "right"})
    )
    assert client.facing_deg == 0
    await server._handle_message(
        client, json.dumps({"type": "update_position", "x": 8, "y": 8, "z": 0})
    )
    await server._handle_message(
        client,
        json.dumps({"type": "teleport_complete", "x": 30, "y": 30, "z": 0}),
    )
    assert (client.x, client.y, client.z) == (5, 6, 0)
    assert transport.packets_of_type(observer, BroadcastTeleportCompletePacket) == []
    await server.item_runtime.teleport.shutdown()


@pytest.mark.asyncio
async def test_elevator_rider_cannot_start_item_teleport(world) -> None:
    """An actor must leave an elevator before starting a floor transition."""

    server, transport = world.server, world.transport
    client = world.join("tester", x=5, y=6, client_id="u1", elevator_id="car-1")
    teleporter = server.item_service.default_item(client, "teleporter")
    teleporter.params["destination"] = "10, 11, 40"
    server.item_service.add_item(teleporter)

    await server._handle_message(
        client, json.dumps({"type": "item_use", "itemId": teleporter.id})
    )

    action = transport.last_packet_of_type(client, ItemActionResultPacket)
    assert action.ok is False
    assert "elevator" in action.message.lower()
    assert not server.item_runtime.is_teleporting(client)


@pytest.mark.parametrize(
    ("permissions", "offset", "expected_text"),
    [
        (set(), (0, 0), "not authorized"),
        ({"item.use"}, (1, 0), "not on your square"),
    ],
)
@pytest.mark.asyncio
async def test_teleporter_keeps_generic_permission_and_proximity_checks(
    world, permissions: set[str], offset: tuple[int, int], expected_text: str
) -> None:
    """Teleport intents still pass through shared item-use eligibility rules."""

    server, transport = world.server, world.transport
    client = world.join("tester", x=5, y=6, client_id="u1", permissions=permissions)
    teleporter = server.item_service.default_item(client, "teleporter")
    teleporter.x += offset[0]
    teleporter.y += offset[1]
    teleporter.params["destination"] = "10, 11, 40"
    server.item_service.add_item(teleporter)

    await server._handle_message(
        client, json.dumps({"type": "item_use", "itemId": teleporter.id})
    )

    action = transport.last_packet_of_type(client, ItemActionResultPacket)
    assert action.ok is False
    assert expected_text in action.message.lower()
    assert not server.item_runtime.is_teleporting(client)
    assert not transport.packets_of_type(client, TeleportTransitionPacket)


@pytest.mark.asyncio
async def test_disconnect_before_midpoint_cancels_transition_task(world) -> None:
    """Disconnect cleanup cancels a pending task before it changes authority."""

    server, transport = world.server, world.transport
    client = world.join("tester", x=5, y=6, client_id="u1")
    teleporter = server.item_service.default_item(client, "teleporter")
    teleporter.params["destination"] = "10, 11, 40"
    server.item_service.add_item(teleporter)
    sleep = ControlledSleep()
    server.item_runtime.teleport._sleep = sleep

    await server._handle_message(
        client, json.dumps({"type": "item_use", "itemId": teleporter.id})
    )
    await sleep.wait_for_call(1)
    server.clients.pop(client.websocket)
    await server.item_runtime.prepare_client_disconnect(client)

    assert not server.item_runtime.is_teleporting(client)
    assert (client.x, client.y, client.z) == (5, 6, 0)
    assert [
        packet.phase
        for packet in transport.packets_of_type(client, TeleportTransitionPacket)
    ] == ["start"]
    await server.item_runtime.shutdown()


@pytest.mark.asyncio
async def test_disconnect_after_midpoint_retains_authoritative_destination(
    world,
) -> None:
    """Disconnect cleanup after arrival keeps the endpoint already applied."""

    server, transport = world.server, world.transport
    client = world.join("tester", x=5, y=6, client_id="u1")
    teleporter = server.item_service.default_item(client, "teleporter")
    teleporter.params["destination"] = "10, 11, 40"
    server.item_service.add_item(teleporter)
    sleep = ControlledSleep()
    server.item_runtime.teleport._sleep = sleep

    await server._handle_message(
        client, json.dumps({"type": "item_use", "itemId": teleporter.id})
    )
    await _drain_transition_half(sleep, 1)
    await sleep.wait_for_call(2)
    server.clients.pop(client.websocket)
    await server.item_runtime.prepare_client_disconnect(client)

    assert not server.item_runtime.is_teleporting(client)
    assert (client.x, client.y, client.z) == (10, 11, 40)
    assert [
        packet.phase
        for packet in transport.packets_of_type(client, TeleportTransitionPacket)
    ] == ["start", "arrive"]
    await server.item_runtime.shutdown()


@pytest.mark.asyncio
async def test_shutdown_cleans_active_transition_task(world) -> None:
    """Server shutdown removes active transition reservations and tasks."""

    server = world.server
    client = world.join("tester", x=5, y=6, client_id="u1")
    teleporter = server.item_service.default_item(client, "teleporter")
    teleporter.params["destination"] = "10, 11, 40"
    server.item_service.add_item(teleporter)
    sleep = ControlledSleep()
    server.item_runtime.teleport._sleep = sleep

    await server._handle_message(
        client, json.dumps({"type": "item_use", "itemId": teleporter.id})
    )
    await sleep.wait_for_call(1)
    await server.item_runtime.shutdown()

    assert not server.item_runtime.is_teleporting(client)
    assert server.item_runtime.teleport._tasks == {}


@pytest.mark.asyncio
async def test_transition_captures_destination_and_cancels_on_task_failure(
    world,
) -> None:
    """A task failure sends cancel and keeps the endpoint already reached."""

    server, transport = world.server, world.transport
    client = world.join("tester", x=5, y=6, client_id="u1")
    teleporter = server.item_service.default_item(client, "teleporter")
    teleporter.params["destination"] = "10, 11, 40"
    server.item_service.add_item(teleporter)

    calls = 0

    async def sleep_with_failure(_seconds: float) -> None:
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("injected transition failure")

    server.item_runtime.teleport._sleep = sleep_with_failure
    await server._handle_message(
        client, json.dumps({"type": "item_use", "itemId": teleporter.id})
    )
    await _wait_for_transition_end(server, client)

    assert (client.x, client.y, client.z) == (10, 11, 40)
    phases = [
        packet.phase
        for packet in transport.packets_of_type(client, TeleportTransitionPacket)
    ]
    assert phases == ["start", "arrive", "cancel"]
    assert not server.item_runtime.is_teleporting(client)
