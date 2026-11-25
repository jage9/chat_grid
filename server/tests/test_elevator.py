"""Floor, footprint, and elevator state-machine tests."""

from __future__ import annotations

import asyncio
import json
from dataclasses import replace
from pathlib import Path

import pytest

from app.item_service import ItemService
from app.items.types.elevator.validator import validate_update

from app.models import (
    BroadcastPositionPacket,
    ItemActionResultPacket,
    ItemElevatorStatusPacket,
    ItemUpsertPacket,
    ItemUseSoundPacket,
)
from app.items.types.elevator.runtime import (
    ELEVATOR_DOOR_CLOSE_SOUND_SECONDS,
    ELEVATOR_DOOR_OPEN_SECONDS,
    ELEVATOR_DOOR_OPEN_SOUND_SECONDS,
)


def test_elevator_single_square_occupies_both_floors(make_world) -> None:
    """One elevator entity should expose its anchor square on both landings."""

    world = make_world(grid_size=41)
    server = world.server
    client = world.join("tester", x=10, y=10, z=0, client_id="u1")
    elevator = server.item_service.default_item(client, "elevator")
    elevator.z = 0

    assert server.item_runtime.item_is_on_client_square(elevator, client)
    client.z = 40
    assert server.item_runtime.item_is_on_client_square(elevator, client)
    client.x = 11
    assert not server.item_runtime.item_is_on_client_square(elevator, client)


@pytest.mark.asyncio
async def test_multi_stop_riders_choose_unique_fifo_destinations(world, monkeypatch):
    rider = world.join("Rider", x=10, y=10, z=0)
    other = world.join("Other", x=10, y=10, z=0)
    elevator = world.server.item_service.default_item(rider, "elevator")
    elevator.params.update(floorZs=[0, 20, 40], doorOpen=True, state="door_open")
    world.server.item_service.add_item(elevator)
    monkeypatch.setattr(
        world.server.item_runtime.elevator, "_restart_task", lambda _: None
    )
    runtime = world.server.item_runtime.elevator
    await runtime.use(rider, elevator)
    await runtime.use(other, elevator)
    assert elevator.params["requestedZs"] == []
    await runtime.select_floor(rider, elevator, 40)
    await runtime.select_floor(other, elevator, 20)
    version = elevator.version
    await runtime.select_floor(other, elevator, 40)
    assert elevator.version == version
    assert elevator.params["requestedZs"] == [40, 20]
    assert runtime._next_destination(elevator, 0) == 40
    assert runtime._next_destination(elevator, 40) == 20
    rider.elevator_id = None
    await runtime.select_floor(rider, elevator, 0)
    assert elevator.params["requestedZs"] == []
    assert not world.transport.last_packet_of_type(rider, ItemActionResultPacket).ok


@pytest.mark.asyncio
async def test_away_call_does_not_depart_before_open_door_finishes(world):
    caller = world.join("Caller", x=10, y=10, z=40)
    elevator = world.server.item_service.default_item(caller, "elevator")
    elevator.params.update(currentZ=0, doorOpen=True, state="door_open")
    world.server.item_service.add_item(elevator)
    await world.server.item_runtime.elevator.use(caller, elevator)
    assert elevator.params["state"] == "door_open"
    assert elevator.params["doorOpen"] is True
    assert elevator.params["requestedZs"] == [40]
    assert elevator.params["targetZ"] is None


@pytest.mark.asyncio
async def test_open_air_exit_lands_on_highest_surface_and_carries_items(world):
    rider = world.join("Rider", x=10, y=10, z=80)
    observer = world.join("Observer", x=11, y=10, z=40)
    elevator = world.server.item_service.default_item(rider, "elevator")
    elevator.params.update(
        floorZs=[0, 80], currentZ=80, doorOpen=True, state="door_open"
    )
    world.server.item_service.add_item(elevator)
    rider.elevator_id = elevator.id
    held = world.server.item_service.default_item(rider, "widget")
    held.carrierId = rider.id
    world.server.item_service.add_item(held)
    await world.server.item_runtime.elevator.use(rider, elevator)
    assert rider.z == held.z == 40
    assert rider.elevator_id is None
    packet = world.transport.last_packet_of_type(observer, BroadcastPositionPacket)
    assert packet.z == 40 and packet.acousticZoneId == "floor:40"


@pytest.mark.asyncio
async def test_open_air_exit_with_no_surface_keeps_rider_aboard(world):
    rider = world.join("Rider", x=10, y=10, z=-20)
    elevator = world.server.item_service.default_item(rider, "elevator")
    elevator.params.update(
        floorZs=[-20, 0], currentZ=-20, doorOpen=True, state="door_open"
    )
    world.server.item_service.add_item(elevator)
    rider.elevator_id = elevator.id
    await world.server.item_runtime.elevator.use(rider, elevator)
    assert rider.z == -20 and rider.elevator_id == elevator.id
    assert (
        "no platform below"
        in world.transport.last_packet_of_type(rider, ItemActionResultPacket).message
    )


@pytest.mark.asyncio
async def test_travel_time_scales_with_distance_and_speed(world, monkeypatch):
    rider = world.join("Rider")
    elevator = world.server.item_service.default_item(rider, "elevator")
    elevator.params["speed"] = 10
    sleeps = []

    async def record_sleep(seconds):
        sleeps.append(seconds)

    monkeypatch.setattr(asyncio, "sleep", record_sleep)
    await world.server.item_runtime.elevator.advance_travel(elevator, 0, 40)
    assert sum(sleeps) == pytest.approx(4)
    sleeps.clear()
    await world.server.item_runtime.elevator.advance_travel(elevator, 40, -40)
    assert sum(sleeps) == pytest.approx(8)
    sleeps.clear()
    elevator.params["speed"] = 0.1
    await world.server.item_runtime.elevator.advance_travel(elevator, 0, 1)
    assert sleeps == [10]


def test_open_air_recovery_uses_supported_landing_or_spawn(world):
    rider = world.join("Rider", x=10, y=10, z=70)
    elevator = world.server.item_service.default_item(rider, "elevator")
    elevator.params.update(floorZs=[0, 80], currentZ=80)
    world.server.item_service.add_item(elevator)
    rider.elevator_id = elevator.id
    runtime = world.server.item_runtime.elevator
    assert runtime.recovery_position(rider) == (10, 10, 40)
    elevator.params["currentZ"] = -20
    assert runtime.recovery_position(rider) == (0, 0, 0)
    assert (rider.x, rider.y, rider.z) == (10, 10, 70)


@pytest.mark.asyncio
async def test_failed_trip_ejection_clears_browser_cabin_state(world):
    rider = world.join("Rider", x=10, y=10, z=70)
    elevator = world.server.item_service.default_item(rider, "elevator")
    elevator.params.update(floorZs=[0, 80], currentZ=80, state="moving", targetZ=0)
    world.server.item_service.add_item(elevator)
    rider.elevator_id = elevator.id
    await world.server.item_runtime.elevator._return_to_idle(elevator.id)
    assert rider.elevator_id is None and rider.z == 40
    packet = world.transport.last_packet_of_type(rider, ItemElevatorStatusPacket)
    assert packet.event == "exited" and packet.z == 40
    assert "stopped unexpectedly" in packet.message


@pytest.mark.asyncio
async def test_arrival_sets_all_riders_before_exits_and_does_not_send_stale_arrival(
    world,
):
    rider = world.join("Rider", x=10, y=10, z=20)
    other = world.join("Other", x=10, y=10, z=20)
    elevator = world.server.item_service.default_item(rider, "elevator")
    elevator.params.update(currentZ=40, state="door_open", doorOpen=True)
    world.server.item_service.add_item(elevator)
    rider.elevator_id = other.elevator_id = elevator.id
    held = world.server.item_service.default_item(rider, "widget")
    held.carrierId = rider.id
    world.server.item_service.add_item(held)
    runtime = world.server.item_runtime.elevator
    original = runtime.callbacks.broadcast_item
    exited = False

    async def exit_during_broadcast(item):
        nonlocal exited
        if not exited:
            exited = True
            assert rider.z == other.z == held.z == 40
            await runtime.use(rider, elevator)
        await original(item)

    runtime.callbacks = replace(runtime.callbacks, broadcast_item=exit_during_broadcast)
    await runtime._move_occupants(elevator, 40)
    await runtime._announce_arrival(elevator, 40)
    events = world.transport.packets_of_type(rider, ItemElevatorStatusPacket)
    assert [packet.event for packet in events] == ["exited"]
    assert (
        world.transport.last_packet_of_type(other, ItemElevatorStatusPacket).event
        == "arrived"
    )


def test_same_xy_on_another_floor_is_not_the_same_item_square(make_world) -> None:
    """Ordinary item occupancy should compare height as well as x and y."""

    world = make_world(grid_size=41)
    server = world.server
    client = world.join("tester", x=10, y=10, z=40, client_id="u1")
    item = server.item_service.default_item(client, "dice")
    item.z = 0

    assert not server.item_runtime.item_is_on_client_square(item, client)


def test_elevator_timing_and_emitter_are_editable_but_runtime_state_is_not(
    make_world,
) -> None:
    """Elevator edits should accept timing/audio without exposing runtime state."""

    world = make_world(grid_size=41)
    server = world.server
    client = world.join("tester", x=10, y=10, z=0, client_id="u1")
    elevator = server.item_service.default_item(client, "elevator")

    params = validate_update(
        elevator,
        {
            **elevator.params,
            "directional": True,
            "facing": 123.4,
            "doorOpenSeconds": 8.25,
            "speed": 12.34,
            "emitRange": 12,
            "emitVolume": 65,
            "emitSoundSpeed": 40.5,
            "emitSoundTempo": 62.5,
            "emitInitialDelay": 1.2,
            "emitLoopDelay": 3.4,
            "emitEffect": "echo",
            "emitEffectValue": 44.4,
            "emitSound": "elevator_motor.ogg",
            "state": "moving",
        },
    )

    assert {
        key: params[key]
        for key in (
            "directional",
            "facing",
            "doorOpenSeconds",
            "speed",
            "emitRange",
            "emitVolume",
            "emitSoundSpeed",
            "emitSoundTempo",
            "emitInitialDelay",
            "emitLoopDelay",
            "emitEffect",
            "emitEffectValue",
            "emitSound",
        )
    } == {
        "directional": True,
        "facing": 123,
        "doorOpenSeconds": 8.2,
        "speed": 12.3,
        "emitRange": 12,
        "emitVolume": 65,
        "emitSoundSpeed": 40.5,
        "emitSoundTempo": 62.5,
        "emitInitialDelay": 1.2,
        "emitLoopDelay": 3.4,
        "emitEffect": "echo",
        "emitEffectValue": 44.4,
        "emitSound": "sounds/elevator_motor.ogg",
    }
    assert params["state"] == "idle"


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("doorOpenSeconds", -0.1),
        ("doorOpenSeconds", 300.1),
        ("speed", "not a number"),
    ],
)
def test_elevator_rejects_invalid_editable_durations(
    make_world, key: str, value: object
) -> None:
    """Editable elevator timing must remain finite and within its UI range."""

    world = make_world(grid_size=41)
    server = world.server
    client = world.join("tester", x=10, y=10, z=0, client_id="u1")
    elevator = server.item_service.default_item(client, "elevator")

    with pytest.raises(ValueError):
        validate_update(elevator, {**elevator.params, key: value})


@pytest.mark.parametrize(
    ("params", "expected"),
    [
        (
            {"currentZ": 0, "state": "door_open", "doorOpen": True},
            "Elevator is on Ground floor, door open.",
        ),
        (
            {"currentZ": 40, "state": "idle", "doorOpen": False},
            "Elevator is on Second floor, door closed.",
        ),
        (
            {"currentZ": 0, "targetZ": 40, "state": "moving"},
            "Elevator is headed to Second floor, traveling up, from Ground floor.",
        ),
        (
            {"currentZ": 40, "targetZ": 0, "state": "moving"},
            "Elevator is headed to Ground floor, traveling down, from Second floor.",
        ),
    ],
)
def test_elevator_secondary_use_reports_simple_car_state(
    make_world, params: dict[str, object], expected: str
) -> None:
    """Secondary use should report only landing/door or destination/direction."""

    world = make_world(grid_size=41)
    server = world.server
    client = world.join("tester", x=10, y=10, z=0, client_id="u1")
    elevator = server.item_service.default_item(client, "elevator")
    elevator.params.update(params)

    assert server.item_runtime.elevator.status(elevator) == expected


@pytest.mark.asyncio
async def test_elevator_opens_then_second_use_enters(
    make_world,
) -> None:
    """A present elevator should reject boarding until its opening sound ends."""

    world = make_world(grid_size=41)
    server, transport = world.server, world.transport
    observer = world.join("observer", x=40, y=40)
    client = world.join("tester", x=10, y=10, z=0, client_id="u1")
    elevator = server.item_service.default_item(client, "elevator")
    elevator.z = 0
    server.item_service.add_item(elevator)

    await server.item_runtime.elevator.use(client, elevator)
    assert elevator.params["state"] == "opening"
    assert elevator.params["doorOpen"] is False
    assert client.elevator_id is None
    door_packets = transport.packets_of_type(observer, ItemUseSoundPacket)
    door_sounds = [packet.sound for packet in door_packets]
    assert door_sounds == [
        "/sounds/elevator_up.ogg",
        "/sounds/elevator_open.ogg",
    ]
    assert all(packet.acousticZoneId == "floor:0" for packet in door_packets)
    opening_index = next(
        index
        for index, packet in enumerate(transport.packets_to(observer))
        if isinstance(packet, ItemUpsertPacket)
        and packet.item.params["state"] == "opening"
    )
    first_sound_index = next(
        index
        for index, packet in enumerate(transport.packets_to(observer))
        if isinstance(packet, ItemUseSoundPacket)
    )
    assert opening_index < first_sound_index

    await server.item_runtime.elevator.use(client, elevator)
    assert client.elevator_id is None
    result = transport.last_packet_of_type(client, ItemActionResultPacket)
    assert result.message == "The elevator door is opening."

    elevator.params["state"] = "closing"
    await server.item_runtime.elevator.use(client, elevator)
    assert client.elevator_id is None
    result = transport.last_packet_of_type(client, ItemActionResultPacket)
    assert result.message == "The elevator door is closing."

    elevator.params["state"] = "door_open"
    elevator.params["doorOpen"] = True
    elevator.params["doorOpenSeconds"] = 8.2
    await server.item_runtime.elevator.use(client, elevator)
    assert client.elevator_id == elevator.id
    assert elevator.params["requestedZs"] == [40]
    assert any(
        packet.event == "entered"
        for packet in transport.packets_of_type(client, ItemElevatorStatusPacket)
    )
    presence = transport.last_packet_of_type(observer, BroadcastPositionPacket)
    assert presence.acousticZoneId == f"elevator:{elevator.id}"
    result = transport.last_packet_of_type(client, ItemActionResultPacket)
    assert result.message == "You enter Elevator. The door will close in 8.2 seconds."

    await server.item_runtime.elevator.use(client, elevator)
    assert client.elevator_id is None
    exit_presence = transport.last_packet_of_type(observer, BroadcastPositionPacket)
    assert exit_presence.acousticZoneId == "floor:0"

    await server.item_runtime.elevator.cancel(elevator.id)


@pytest.mark.asyncio
async def test_absent_elevator_is_called_and_moving_calls_are_queued(
    make_world,
) -> None:
    """A landing use should call an absent car and queue a later opposite call."""

    world = make_world(grid_size=41)
    server = world.server
    ground_client = world.join("ground", x=10, y=10, z=0, client_id="ground")
    second_client = world.join("second", x=10, y=10, z=40, client_id="second")
    elevator = server.item_service.default_item(ground_client, "elevator")
    elevator.params["currentZ"] = 40
    server.item_service.add_item(elevator)

    await server.item_runtime.elevator.use(ground_client, elevator)
    assert elevator.params["state"] == "moving"
    assert elevator.params["targetZ"] == 0
    assert ground_client.elevator_id is None

    await server.item_runtime.elevator.use(second_client, elevator)
    assert elevator.params["requestedZs"] == [40]

    await server.item_runtime.elevator.cancel(elevator.id)


@pytest.mark.asyncio
async def test_opposite_landing_call_is_queued_while_door_is_closing(
    make_world,
) -> None:
    """A closing door should block traversal without dropping an away-floor call."""

    world = make_world(grid_size=41)
    server, transport = world.server, world.transport
    client = world.join("tester", x=10, y=10, z=40, client_id="u1")
    elevator = server.item_service.default_item(client, "elevator")
    elevator.params.update({"currentZ": 0, "state": "closing", "doorOpen": False})
    server.item_service.add_item(elevator)

    await server.item_runtime.elevator.use(client, elevator)

    assert client.elevator_id is None
    assert elevator.params["state"] == "closing"
    assert elevator.params["requestedZs"] == [40]
    result = transport.packets_of_type(client, ItemActionResultPacket)[0]
    assert result.message == "You call Elevator."


@pytest.mark.asyncio
async def test_multiple_elevators_keep_independent_state(
    make_world,
) -> None:
    """Using one elevator must not mutate another elevator object."""

    world = make_world(grid_size=41)
    server = world.server
    client = world.join("tester", x=10, y=10, z=0, client_id="u1")
    first = server.item_service.default_item(client, "elevator")
    second = server.item_service.default_item(client, "elevator")
    second.x = 20
    second.y = 20
    server.item_service.add_item(first)
    server.item_service.add_item(second)

    await server.item_runtime.elevator.use(client, first)

    assert first.params["state"] == "opening"
    assert first.params["doorOpen"] is False
    assert second.params["doorOpen"] is False
    assert second.params["state"] == "idle"

    await server.item_runtime.elevator.cancel(first.id)


@pytest.mark.asyncio
async def test_elevator_arrival_moves_rider_and_carried_item(
    make_world,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Arrival should move the rider and held item to the destination floor."""

    world = make_world(grid_size=41)
    server, transport = world.server, world.transport
    observer = world.join("observer", x=40, y=40)
    client = world.join(
        "tester", x=10, y=10, z=0, elevator_id="elevator-1", client_id="u1"
    )
    elevator = server.item_service.default_item(client, "elevator")
    elevator.id = "elevator-1"
    elevator.z = 0
    elevator.params.update(
        {
            "currentZ": 0,
            "targetZ": 40,
            "state": "moving",
            "doorOpen": False,
            "requestedZs": [],
        }
    )
    server.item_service.add_item(elevator)
    carried = server.item_service.default_item(client, "dice")
    carried.carrierId = client.id
    server.item_service.add_item(carried)
    carried_two = server.item_service.default_item(client, "wheel")
    carried_two.carrierId = client.id
    server.item_service.add_item(carried_two)

    sleeps: list[tuple[float, str]] = []

    async def immediate_sleep(seconds: float) -> None:
        sleeps.append((seconds, str(elevator.params["state"])))
        return None

    monkeypatch.setattr(asyncio, "sleep", immediate_sleep)

    await server.item_runtime.elevator.run_cycle(elevator.id)

    assert elevator.params["currentZ"] == 40
    assert elevator.params["state"] == "idle"
    assert client.z == 40
    assert client.elevator_id == elevator.id
    assert carried.z == 40
    assert carried_two.z == 40
    arrival = next(
        packet
        for packet in transport.packets_of_type(client, ItemElevatorStatusPacket)
        if packet.event == "arrived"
    )
    assert arrival.message == "Elevator arrives on Second floor. The door opens."
    elevator_sounds = transport.packets_of_type(observer, ItemUseSoundPacket)
    assert [packet.sound for packet in elevator_sounds] == [
        "/sounds/elevator_down.ogg",
        "/sounds/elevator_open.ogg",
        "/sounds/elevator_close.ogg",
    ]
    assert (ELEVATOR_DOOR_OPEN_SOUND_SECONDS, "arriving") in sleeps
    assert (ELEVATOR_DOOR_OPEN_SECONDS, "door_open") in sleeps
    assert (ELEVATOR_DOOR_CLOSE_SOUND_SECONDS, "closing") in sleeps
    close_index = sleeps.index((ELEVATOR_DOOR_CLOSE_SOUND_SECONDS, "closing"))
    assert all(state == "moving" for _, state in sleeps[close_index + 1 :])
    rider_packets = transport.packets_to(client)
    landing_position = next(
        packet
        for packet in rider_packets
        if isinstance(packet, BroadcastPositionPacket)
        and packet.id == client.id
        and packet.z == 40
    )
    chime, door, _ = transport.packets_of_type(client, ItemUseSoundPacket)
    assert (
        rider_packets.index(landing_position)
        < rider_packets.index(chime)
        < rider_packets.index(door)
        < rider_packets.index(arrival)
    )
    assert chime.acousticZoneId == f"elevator:{elevator.id}"
    assert door.acousticZoneId == "floor:40"
    for sound in elevator_sounds:
        assert (sound.x, sound.y, sound.z) == (10, 10, 40)
        assert sound.acousticZoneId == "floor:40"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("queue", "direction"),
    [([], "up"), ([20, 999, -10, 40], "down"), ([40, -10], "up")],
)
async def test_middle_stop_opening_chime(world, monkeypatch, queue, direction) -> None:
    """Hear the next trip or the default chime without consuming a request."""
    client = world.join("tester", x=10, y=10, z=20)
    elevator = world.server.item_service.default_item(client, "elevator")
    elevator.params.update(floorZs=[-10, 20, 40], currentZ=20, requestedZs=queue.copy())
    rider = world.join("rider", x=10, y=10, z=20, elevator_id=elevator.id)
    runtime = world.server.item_runtime.elevator
    monkeypatch.setattr(runtime, "_restart_task", lambda _: None)

    await runtime.use(client, elevator)

    for listener in (client, rider):
        sounds = world.transport.packets_of_type(listener, ItemUseSoundPacket)
        assert [packet.sound for packet in sounds] == [
            f"/sounds/elevator_{direction}.ogg",
            "/sounds/elevator_open.ogg",
        ]
        expected_zone = f"elevator:{elevator.id}" if listener is rider else "floor:20"
        assert [packet.acousticZoneId for packet in sounds] == [
            expected_zone,
            "floor:20",
        ]
    assert elevator.params["requestedZs"] == queue


@pytest.mark.asyncio
async def test_elevator_waits_for_closing_sound_before_travel(
    make_world,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The runtime must not begin car movement until the closing clip finishes."""

    world = make_world(grid_size=41)
    server, transport = world.server, world.transport
    client = world.join("tester", x=10, y=10, z=0, client_id="u1")
    elevator = server.item_service.default_item(client, "elevator")
    elevator.params.update(
        {
            "state": "closing",
            "doorOpen": False,
            "requestedZs": [40],
        }
    )
    server.item_service.add_item(elevator)
    completed_sleeps: list[float] = []
    travel_started = False

    async def immediate_sleep(seconds: float) -> None:
        completed_sleeps.append(seconds)

    async def stop_at_travel(
        _item: object, _origin_z: int, _destination_z: int
    ) -> None:
        nonlocal travel_started
        travel_started = True
        assert completed_sleeps == [ELEVATOR_DOOR_CLOSE_SOUND_SECONDS]
        raise asyncio.CancelledError

    monkeypatch.setattr(asyncio, "sleep", immediate_sleep)
    monkeypatch.setattr(server.item_runtime.elevator, "advance_travel", stop_at_travel)

    await server.item_runtime.elevator.run_cycle(elevator.id)

    assert travel_started is True
    assert elevator.params["state"] == "moving"
    assert transport.packets_of_type(client, ItemUseSoundPacket) == []


@pytest.mark.asyncio
async def test_editable_elevator_durations_drive_runtime_timing(
    make_world,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Door dwell and floor travel should use each elevator's editable values."""

    world = make_world(grid_size=41)
    server = world.server
    client = world.join("tester", x=10, y=10, z=0, client_id="u1")
    elevator = server.item_service.default_item(client, "elevator")
    elevator.params.update(
        {
            "state": "door_open",
            "doorOpen": True,
            "doorOpenSeconds": 7.5,
            "speed": 1.25,
        }
    )
    server.item_service.add_item(elevator)
    sleeps: list[float] = []

    async def immediate_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    monkeypatch.setattr(asyncio, "sleep", immediate_sleep)

    await server.item_runtime.elevator.run_cycle(elevator.id)
    assert sleeps[:2] == [7.5, ELEVATOR_DOOR_CLOSE_SOUND_SECONDS]

    sleeps.clear()
    await server.item_runtime.elevator.advance_travel(elevator, 0, 0)
    assert sleeps == [0.0]


@pytest.mark.asyncio
async def test_stopped_rider_waits_for_reopened_door_before_exiting(
    make_world,
) -> None:
    """A rider should remain inside until a stopped car finishes reopening."""

    world = make_world(grid_size=41)
    server, transport = world.server, world.transport
    observer = world.join("observer", x=40, y=40)
    client = world.join(
        "tester", x=10, y=10, z=40, elevator_id="elevator-1", client_id="u1"
    )
    elevator = server.item_service.default_item(client, "elevator")
    elevator.id = "elevator-1"
    elevator.params["currentZ"] = 40
    server.item_service.add_item(elevator)

    await server.item_runtime.elevator.use(client, elevator)

    assert client.elevator_id == elevator.id
    assert elevator.params["state"] == "opening"
    assert elevator.params["doorOpen"] is False
    assert not any(
        packet.event == "exited"
        for packet in transport.packets_of_type(client, ItemElevatorStatusPacket)
    )
    door_sounds = [
        packet.sound
        for packet in transport.packets_of_type(observer, ItemUseSoundPacket)
    ]
    assert door_sounds == [
        "/sounds/elevator_down.ogg",
        "/sounds/elevator_open.ogg",
    ]

    await server.item_runtime.elevator.use(client, elevator)
    assert client.elevator_id == elevator.id

    elevator.params["state"] = "door_open"
    elevator.params["doorOpen"] = True
    await server.item_runtime.elevator.use(client, elevator)
    assert client.elevator_id is None
    assert any(
        packet.event == "exited"
        for packet in transport.packets_of_type(client, ItemElevatorStatusPacket)
    )

    await server.item_runtime.elevator.cancel(elevator.id)


@pytest.mark.asyncio
async def test_rider_cannot_exit_while_elevator_is_moving(
    make_world,
) -> None:
    """A rider must remain in the car until it reaches a landing."""

    world = make_world(grid_size=41)
    server, transport = world.server, world.transport
    client = world.join(
        "tester", x=10, y=10, z=20, elevator_id="elevator-1", client_id="u1"
    )
    elevator = server.item_service.default_item(client, "elevator")
    elevator.id = "elevator-1"
    elevator.params.update({"state": "moving", "targetZ": 40})
    server.item_service.add_item(elevator)

    await server.item_runtime.elevator.use(client, elevator)

    assert client.elevator_id == elevator.id
    assert not any(
        packet.event == "exited"
        for packet in transport.packets_of_type(client, ItemElevatorStatusPacket)
    )
    result = transport.packets_of_type(client, ItemActionResultPacket)[0]
    assert result.message == "The elevator is moving."


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("origin_z", "destination_z", "first_height", "last_height"),
    [(0, 40, 2, 38), (40, 0, 38, 2)],
)
async def test_elevator_travel_height_progresses_between_acoustic_floors(
    make_world,
    monkeypatch: pytest.MonkeyPatch,
    origin_z: int,
    destination_z: int,
    first_height: int,
    last_height: int,
) -> None:
    """Travel should progressively move riders without publishing either landing."""

    world = make_world(grid_size=41)
    server, transport = world.server, world.transport
    observer = world.join("observer", x=40, y=40)
    client = world.join(
        "tester", x=10, y=10, z=origin_z, elevator_id="elevator-1", client_id="u1"
    )
    elevator = server.item_service.default_item(client, "elevator")
    elevator.id = "elevator-1"
    elevator.params["currentZ"] = origin_z
    server.item_service.add_item(elevator)

    async def immediate_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr(asyncio, "sleep", immediate_sleep)

    await server.item_runtime.elevator.advance_travel(elevator, origin_z, destination_z)

    heights = [
        packet.z
        for packet in transport.packets_of_type(observer, BroadcastPositionPacket)
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
        for packet in transport.packets_of_type(client, ItemElevatorStatusPacket)
        if packet.event == "moving"
    ]
    assert status_heights == heights
    assert [
        packet.z
        for packet in transport.packets_of_type(client, BroadcastPositionPacket)
    ] == heights
    assert not transport.packets_of_type(observer, ItemUpsertPacket)
    assert elevator.z == origin_z


def test_disconnecting_rider_returns_to_last_landing(make_world) -> None:
    """An unfinished trip must never persist an intermediate elevator height."""

    world = make_world(grid_size=41)
    server = world.server
    client = world.join(
        "tester", x=10, y=10, z=20, elevator_id="elevator-1", client_id="u1"
    )
    elevator = server.item_service.default_item(client, "elevator")
    elevator.id = "elevator-1"
    elevator.params["currentZ"] = 0
    elevator.params["state"] = "moving"
    server.item_service.add_item(elevator)

    server.item_runtime.elevator.restore_rider_to_landing(client)

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
                    "z": 20,
                    "createdBy": "u1",
                    "createdAt": 1,
                    "updatedAt": 2,
                    "version": 3,
                    "params": {
                        "floorZs": [0, 40],
                        "currentZ": 0,
                        "targetZ": 40,
                        "requestedZs": [40],
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
    assert elevator.params["requestedZs"] == []
    assert elevator.params["state"] == "idle"
    assert elevator.params["doorOpen"] is False
    assert elevator.params["doorOpenSeconds"] == 5
    assert elevator.params["speed"] == 10
    assert elevator.z == 0


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
