"""Floor, footprint, and elevator state-machine tests."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import cast

import pytest
from websockets.asyncio.server import ServerConnection

from app.client import ClientConnection
from app.item_service import ItemService
from app.models import (
    BroadcastPositionPacket,
    ItemElevatorStatusPacket,
    ItemUseSoundPacket,
)
from app.server import SignalingServer


def _fake_ws() -> ServerConnection:
    """Return a lightweight websocket identity for unit tests."""

    return cast(ServerConnection, object())


def test_elevator_single_square_occupies_both_floors() -> None:
    """One elevator entity should expose its anchor square on both landings."""

    server = SignalingServer("127.0.0.1", 8765, None, None, grid_size=41)
    client = ClientConnection(
        websocket=_fake_ws(), id="u1", nickname="tester", x=10, y=10, z=0
    )
    elevator = server.item_service.default_item(client, "elevator")
    elevator.z = 0

    assert server._item_is_on_client_square(elevator, client)
    client.z = 40
    assert server._item_is_on_client_square(elevator, client)
    client.x = 11
    assert not server._item_is_on_client_square(elevator, client)


def test_same_xy_on_another_floor_is_not_the_same_item_square() -> None:
    """Ordinary item occupancy should compare height as well as x and y."""

    server = SignalingServer("127.0.0.1", 8765, None, None, grid_size=41)
    client = ClientConnection(
        websocket=_fake_ws(), id="u1", nickname="tester", x=10, y=10, z=40
    )
    item = server.item_service.default_item(client, "dice")
    item.z = 0

    assert not server._item_is_on_client_square(item, client)


@pytest.mark.asyncio
async def test_elevator_opens_then_second_use_enters(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Using a present elevator twice should open it and then board it."""

    server = SignalingServer("127.0.0.1", 8765, None, None, grid_size=41)
    client = ClientConnection(
        websocket=_fake_ws(), id="u1", nickname="tester", x=10, y=10, z=0
    )
    elevator = server.item_service.default_item(client, "elevator")
    elevator.z = 0
    server.item_service.add_item(elevator)

    sent: list[object] = []
    broadcast: list[object] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        sent.append(packet)

    async def fake_broadcast(packet: object, exclude=None) -> None:
        broadcast.append(packet)

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_broadcast", fake_broadcast)

    await server._use_elevator(client, elevator)
    assert elevator.params["doorOpen"] is True
    assert client.elevator_id is None
    door_sound = next(
        packet for packet in broadcast if isinstance(packet, ItemUseSoundPacket)
    )
    assert door_sound.sound == "/sounds/elevator_up.ogg"

    await server._use_elevator(client, elevator)
    assert client.elevator_id == elevator.id
    assert elevator.params["departOnCloseZ"] == 40
    assert any(
        isinstance(packet, ItemElevatorStatusPacket) and packet.event == "entered"
        for packet in sent
    )

    task = server._elevator_tasks.pop(elevator.id)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_absent_elevator_is_called_and_moving_calls_are_queued(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A landing use should call an absent car and queue a later opposite call."""

    server = SignalingServer("127.0.0.1", 8765, None, None, grid_size=41)
    ground_client = ClientConnection(
        websocket=_fake_ws(), id="ground", nickname="ground", x=10, y=10, z=0
    )
    second_client = ClientConnection(
        websocket=_fake_ws(), id="second", nickname="second", x=10, y=10, z=40
    )
    elevator = server.item_service.default_item(ground_client, "elevator")
    elevator.params["currentZ"] = 40
    server.item_service.add_item(elevator)

    async def fake_send(_websocket: ServerConnection, _packet: object) -> None:
        return None

    async def fake_broadcast(_packet: object, exclude=None) -> None:
        return None

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_broadcast", fake_broadcast)

    await server._use_elevator(ground_client, elevator)
    assert elevator.params["state"] == "moving"
    assert elevator.params["targetZ"] == 0
    assert ground_client.elevator_id is None

    await server._use_elevator(second_client, elevator)
    assert elevator.params["queuedZ"] == 40

    task = server._elevator_tasks.pop(elevator.id)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_multiple_elevators_keep_independent_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Using one elevator must not mutate another elevator object."""

    server = SignalingServer("127.0.0.1", 8765, None, None, grid_size=41)
    client = ClientConnection(
        websocket=_fake_ws(), id="u1", nickname="tester", x=10, y=10, z=0
    )
    first = server.item_service.default_item(client, "elevator")
    second = server.item_service.default_item(client, "elevator")
    second.x = 20
    second.y = 20
    server.item_service.add_item(first)
    server.item_service.add_item(second)

    async def fake_send(_websocket: ServerConnection, _packet: object) -> None:
        return None

    async def fake_broadcast(_packet: object, exclude=None) -> None:
        return None

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_broadcast", fake_broadcast)

    await server._use_elevator(client, first)

    assert first.params["doorOpen"] is True
    assert second.params["doorOpen"] is False
    assert second.params["state"] == "idle"

    task = server._elevator_tasks.pop(first.id)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_elevator_arrival_moves_rider_and_carried_item(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Arrival should move the rider and held item to the destination floor."""

    server = SignalingServer("127.0.0.1", 8765, None, None, grid_size=41)
    websocket = _fake_ws()
    client = ClientConnection(
        websocket=websocket,
        id="u1",
        nickname="tester",
        x=10,
        y=10,
        z=0,
        elevator_id="elevator-1",
    )
    server.clients[websocket] = client
    elevator = server.item_service.default_item(client, "elevator")
    elevator.id = "elevator-1"
    elevator.z = 0
    elevator.params.update(
        {
            "currentZ": 0,
            "targetZ": 40,
            "state": "moving",
            "doorOpen": False,
            "departOnCloseZ": None,
            "queuedZ": None,
        }
    )
    server.item_service.add_item(elevator)
    carried = server.item_service.default_item(client, "dice")
    carried.carrierId = client.id
    server.item_service.add_item(carried)

    sent: list[object] = []
    broadcast: list[object] = []

    async def immediate_sleep(_seconds: float) -> None:
        return None

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        sent.append(packet)

    async def fake_broadcast(packet: object, exclude=None) -> None:
        broadcast.append(packet)

    monkeypatch.setattr(asyncio, "sleep", immediate_sleep)
    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_broadcast", fake_broadcast)

    await server._run_elevator_cycle(elevator.id)

    assert elevator.params["currentZ"] == 40
    assert elevator.params["state"] == "idle"
    assert client.z == 40
    assert client.elevator_id == elevator.id
    assert carried.z == 40
    arrival = next(
        packet
        for packet in sent
        if isinstance(packet, ItemElevatorStatusPacket) and packet.event == "arrived"
    )
    assert arrival.message == "Elevator arrives on Second floor. The door opens."
    arrival_sound = next(
        packet for packet in broadcast if isinstance(packet, ItemUseSoundPacket)
    )
    assert arrival_sound.sound == "/sounds/elevator_down.ogg"
    assert (arrival_sound.x, arrival_sound.y, arrival_sound.z) == (10, 10, 40)


@pytest.mark.asyncio
async def test_elevator_door_sound_announces_next_upward_trip(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A ground-floor door opening should announce the next upward trip."""

    server = SignalingServer("127.0.0.1", 8765, None, None, grid_size=41)
    client = ClientConnection(
        websocket=_fake_ws(), id="u1", nickname="tester", x=10, y=10, z=40
    )
    elevator = server.item_service.default_item(client, "elevator")
    broadcast: list[object] = []

    async def fake_broadcast(packet: object, exclude=None) -> None:
        broadcast.append(packet)

    monkeypatch.setattr(server, "_broadcast", fake_broadcast)

    await server._broadcast_elevator_door_open_sound(elevator, 0)

    arrival_sound = cast(ItemUseSoundPacket, broadcast[0])
    assert arrival_sound.sound == "/sounds/elevator_up.ogg"
    assert arrival_sound.z == 0


@pytest.mark.asyncio
async def test_stopped_rider_exits_with_one_use_after_door_closes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A rider should not need a separate use to reopen a stopped elevator."""

    server = SignalingServer("127.0.0.1", 8765, None, None, grid_size=41)
    websocket = _fake_ws()
    client = ClientConnection(
        websocket=websocket,
        id="u1",
        nickname="tester",
        x=10,
        y=10,
        z=40,
        elevator_id="elevator-1",
    )
    server.clients[websocket] = client
    elevator = server.item_service.default_item(client, "elevator")
    elevator.id = "elevator-1"
    elevator.params["currentZ"] = 40
    server.item_service.add_item(elevator)
    sent: list[object] = []
    broadcast: list[object] = []

    async def fake_send(_websocket: ServerConnection, packet: object) -> None:
        sent.append(packet)

    async def fake_broadcast(packet: object, exclude=None) -> None:
        broadcast.append(packet)

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_broadcast", fake_broadcast)

    await server._use_elevator(client, elevator)

    assert client.elevator_id is None
    assert elevator.params["doorOpen"] is True
    assert any(
        isinstance(packet, ItemElevatorStatusPacket) and packet.event == "exited"
        for packet in sent
    )
    door_sound = next(
        packet for packet in broadcast if isinstance(packet, ItemUseSoundPacket)
    )
    assert door_sound.sound == "/sounds/elevator_down.ogg"

    task = server._elevator_tasks.pop(elevator.id)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("origin_z", "destination_z", "first_height", "last_height"),
    [(0, 40, 1, 38), (40, 0, 39, 2)],
)
async def test_elevator_travel_height_progresses_between_acoustic_floors(
    monkeypatch: pytest.MonkeyPatch,
    origin_z: int,
    destination_z: int,
    first_height: int,
    last_height: int,
) -> None:
    """Travel should progressively move riders without publishing either landing."""

    server = SignalingServer("127.0.0.1", 8765, None, None, grid_size=41)
    websocket = _fake_ws()
    client = ClientConnection(
        websocket=websocket,
        id="u1",
        nickname="tester",
        x=10,
        y=10,
        z=origin_z,
        elevator_id="elevator-1",
    )
    server.clients[websocket] = client
    elevator = server.item_service.default_item(client, "elevator")
    elevator.id = "elevator-1"
    elevator.params["currentZ"] = origin_z
    server.item_service.add_item(elevator)
    broadcast: list[object] = []
    sent: list[object] = []

    async def fake_broadcast(packet: object, exclude=None) -> None:
        broadcast.append(packet)

    async def fake_send(_websocket: ServerConnection, packet: object) -> None:
        sent.append(packet)

    async def immediate_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr(asyncio, "sleep", immediate_sleep)
    monkeypatch.setattr(server, "_broadcast", fake_broadcast)
    monkeypatch.setattr(server, "_send", fake_send)

    await server._advance_elevator_travel(elevator, origin_z, destination_z)

    heights = [
        cast(BroadcastPositionPacket, packet).z
        for packet in broadcast
        if getattr(packet, "type", "") == "update_position"
    ]
    assert heights[0] == first_height
    assert heights[-1] == last_height
    assert len(set(heights)) == len(heights)
    assert all(
        next_height > height if destination_z > origin_z else next_height < height
        for height, next_height in zip(heights, heights[1:])
    )
    assert len(heights) > 2
    assert client.z == heights[-1]
    status_heights = [
        packet.z
        for packet in sent
        if isinstance(packet, ItemElevatorStatusPacket) and packet.event == "moving"
    ]
    assert status_heights == heights


def test_disconnecting_rider_returns_to_last_landing() -> None:
    """An unfinished trip must never persist an intermediate elevator height."""

    server = SignalingServer("127.0.0.1", 8765, None, None, grid_size=41)
    client = ClientConnection(
        websocket=_fake_ws(),
        id="u1",
        nickname="tester",
        x=10,
        y=10,
        z=20,
        elevator_id="elevator-1",
    )
    elevator = server.item_service.default_item(client, "elevator")
    elevator.id = "elevator-1"
    elevator.params["currentZ"] = 0
    elevator.params["state"] = "moving"
    server.item_service.add_item(elevator)

    server._restore_elevator_rider_to_landing(client)

    assert (client.x, client.y, client.z) == (10, 10, 0)
    assert client.elevator_id is None


def test_persisted_elevator_resets_to_resting_state(tmp_path: Path) -> None:
    """A restart should not leave an elevator stuck in an unfinished timer state."""

    state_file = tmp_path / "items.json"
    state_file.write_text(
        json.dumps(
            [
                {
                    "id": "elevator-1",
                    "type": "elevator",
                    "title": "Elevator",
                    "x": 10,
                    "y": 10,
                    "z": 0,
                    "createdBy": "u1",
                    "createdAt": 1,
                    "updatedAt": 2,
                    "version": 3,
                    "params": {
                        "floorZs": [0, 40],
                        "currentZ": 0,
                        "targetZ": 40,
                        "queuedZ": 0,
                        "departOnCloseZ": 40,
                        "state": "moving",
                        "doorOpen": False,
                    },
                }
            ]
        ),
        encoding="utf-8",
    )

    elevator = ItemService(state_file=state_file).items["elevator-1"]

    assert elevator.params["currentZ"] == 0
    assert elevator.params["targetZ"] is None
    assert elevator.params["queuedZ"] is None
    assert elevator.params["departOnCloseZ"] is None
    assert elevator.params["state"] == "idle"
    assert elevator.params["doorOpen"] is False


def test_persisted_transient_carried_item_is_dropped_safely(tmp_path: Path) -> None:
    """Connection-scoped carrying state must not survive a process restart."""

    state_file = tmp_path / "items.json"
    state_file.write_text(
        json.dumps(
            [
                {
                    "id": "dice-1",
                    "type": "dice",
                    "title": "Dice",
                    "x": 10,
                    "y": 10,
                    "z": 20,
                    "createdBy": "u1",
                    "createdAt": 1,
                    "updatedAt": 2,
                    "version": 3,
                    "params": {"sides": 6, "number": 2},
                    "carrierId": "old-connection-id",
                }
            ]
        ),
        encoding="utf-8",
    )

    item = ItemService(state_file=state_file).items["dice-1"]

    assert item.carrierId is None
    assert item.z == 0
