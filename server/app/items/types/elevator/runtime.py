"""Authoritative elevator lifecycle, timing, movement, and sound runtime."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass
from math import ceil, isfinite
from typing import Literal

from .actions import describe_car
from ....item_geometry import move_item
from ....runtime_tasks import cancel_and_join
from ....acoustic_zones import (
    client_position_packet,
    elevator_acoustic_zone_id,
    floor_acoustic_zone_id,
)
from ....client import ClientConnection
from ....delivery import Delivery
from ....models import (
    ItemElevatorStatusPacket,
    ItemUseSoundPacket,
    WorldItem,
)

ELEVATOR_DOOR_OPEN_SECONDS = 5.0
ELEVATOR_DOOR_OPEN_SOUND_SECONDS = 2.563107
ELEVATOR_DOOR_CLOSE_SOUND_SECONDS = 3.765601
ELEVATOR_SPEED = 10.0
ELEVATOR_TRAVEL_UPDATE_SECONDS = 0.25

LOGGER = logging.getLogger("chgrid.server.elevator")

ItemResultCallback = Callable[
    [ClientConnection, bool, Literal["use"], str, str | None], Awaitable[None]
]


@dataclass(frozen=True)
class ElevatorRuntimeCallbacks:
    """Server orchestration hooks required by the elevator runtime."""

    get_item: Callable[[str], WorldItem | None]
    iter_clients: Callable[[], Iterable[ClientConnection]]
    delivery: Delivery
    broadcast_item: Callable[[WorldItem], Awaitable[None]]
    send_item_result: ItemResultCallback
    request_state_save: Callable[[], None]
    persist_client_position: Callable[[ClientConnection], None]
    find_carried_items: Callable[[str], list[WorldItem]]
    now_ms: Callable[[], int]
    floor_name: Callable[[int, int, int], str]
    get_emit_range: Callable[[WorldItem], int]
    landing_position: Callable[[int, int, int], tuple[int, int, int] | None]
    fallback_spawn: Callable[[], tuple[int, int, int]]


class ElevatorRuntime:
    """Own independent elevator tasks and all server-authoritative car behavior."""

    def __init__(self, callbacks: ElevatorRuntimeCallbacks) -> None:
        """Create an elevator runtime using generic server delivery callbacks."""

        self.callbacks = callbacks
        self.delivery = callbacks.delivery
        self._tasks: dict[str, asyncio.Task[None]] = {}

    def shutdown(self) -> Awaitable[None]:
        """Cancel and await every active elevator transition task."""

        tasks = list(self._tasks.values())
        self._tasks.clear()
        return cancel_and_join(tasks)

    async def cancel(self, item_id: str) -> None:
        """Cancel one elevator's active transition task, if present."""

        task = self._tasks.pop(item_id, None)
        if task is None:
            return
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    def restore_rider_to_landing(self, client: ClientConnection) -> None:
        """Return a disconnecting rider to the car's last completed landing."""

        if not client.elevator_id:
            return
        client.x, client.y, client.z = self.recovery_position(client)
        client.elevator_id = None

    def recovery_position(self, client: ClientConnection) -> tuple[int, int, int]:
        """Find supported saved placement for a rider at the car's last stop."""
        item = (
            self.callbacks.get_item(client.elevator_id) if client.elevator_id else None
        )
        if item is not None and item.type == "elevator":
            current_z = int(item.params.get("currentZ", item.z))
            landing = self.callbacks.landing_position(item.x, item.y, current_z)
        else:
            landing = self.callbacks.landing_position(client.x, client.y, client.z)
        return landing if landing is not None else self.callbacks.fallback_spawn()

    def status(self, item: WorldItem) -> str:
        """Describe the actual landing, destination and direction for this shaft."""
        return describe_car(item, self.callbacks.floor_name)

    async def select_floor(
        self, client: ClientConnection, item: WorldItem, destination_z: int
    ) -> None:
        """Queue a configured destination requested by a rider still in this car."""
        if client.elevator_id != item.id:
            await self.callbacks.send_item_result(
                client,
                False,
                "use",
                "Enter the elevator before choosing a floor.",
                item.id,
            )
            return
        if destination_z not in self._floor_elevations(item):
            await self.callbacks.send_item_result(
                client, False, "use", "That elevator stop is unavailable.", item.id
            )
            return
        state = str(item.params.get("state", "idle"))
        current_z = int(item.params.get("currentZ", item.z))
        if destination_z == current_z and state != "moving":
            await self._send_result(client, "Already at that stop.", item.id)
            return
        if not self._queue_destination(item, destination_z):
            await self._send_result(client, "That stop is already requested.", item.id)
            return
        if state == "idle":
            next_z = self._next_destination(item, current_z)
            if next_z is not None:
                self._set_moving(item, next_z)
        self._touch(item)
        await self.callbacks.broadcast_item(item)
        if state == "idle":
            self._restart_task(item.id)
        name = self.callbacks.floor_name(item.x, item.y, destination_z)
        await self._send_result(client, f"Requested {name}.", item.id)

    async def use(self, client: ClientConnection, item: WorldItem) -> None:
        """Apply one context-sensitive elevator call, enter, open, or exit action."""

        state = str(item.params.get("state", "idle"))
        if state == "arriving":
            state = "opening"
        current_z = int(item.params.get("currentZ", 0))
        if client.elevator_id == item.id:
            if state == "moving":
                await self._send_result(client, "The elevator is moving.", item.id)
                return
            if state in {"opening", "closing"}:
                await self._send_result(
                    client, f"The elevator door is {state}.", item.id
                )
                return
            if not bool(item.params.get("doorOpen", False)):
                await self._begin_opening(item, current_z)
                await self._send_result(
                    client, "The elevator door is opening.", item.id
                )
                return
            landing = self.callbacks.landing_position(item.x, item.y, current_z)
            if landing is None:
                await self._send_result(
                    client,
                    "There is no platform below this exit. You remain aboard.",
                    item.id,
                )
                return
            landing_z = landing[2]
            client.elevator_id = None
            client.x, client.y, client.z = item.x, item.y, landing_z
            client.last_position_update_ms = self.callbacks.now_ms()
            self.callbacks.persist_client_position(client)
            for carried in self.callbacks.find_carried_items(client.id):
                move_item(carried, client.x, client.y, client.z)
                carried.updatedAt = self.callbacks.now_ms()
                carried.updatedBy = client.user_id or client.id
                carried.updatedByName = client.username or client.nickname
                await self.callbacks.broadcast_item(carried)
            await self.delivery.broadcast(client_position_packet(client))
            await self.delivery.send(
                client,
                ItemElevatorStatusPacket(
                    type="item_elevator_status",
                    itemId=item.id,
                    event="exited",
                    z=landing_z,
                ),
            )
            await self._send_result(
                client,
                f"You {'exit' if landing_z == current_z else 'exit and fall from'} {item.title} on {self.callbacks.floor_name(item.x, item.y, landing_z)}.",
                item.id,
            )
            return

        if client.z not in self._floor_elevations(item):
            await self.callbacks.send_item_result(
                client, False, "use", "The elevator does not stop here.", item.id
            )
            return

        if state == "moving":
            if self._queue_destination(item, client.z):
                self._touch(item)
                await self.callbacks.broadcast_item(item)
            await self._send_result(client, f"You call {item.title}.", item.id)
            return

        if state in {"opening", "closing"}:
            if client.z != current_z:
                if self._queue_destination(item, client.z):
                    self._touch(item)
                    await self.callbacks.broadcast_item(item)
                await self._send_result(client, f"You call {item.title}.", item.id)
                return
            await self._send_result(client, f"The elevator door is {state}.", item.id)
            return

        if current_z != client.z:
            queued = self._queue_destination(item, client.z)
            if state == "door_open":
                if queued:
                    self._touch(item)
                    await self.callbacks.broadcast_item(item)
                await self._send_result(client, f"You call {item.title}.", item.id)
                return
            target_z = self._next_destination(item, current_z)
            if target_z is None:
                return
            self._set_moving(item, target_z)
            self._touch(item)
            await self.callbacks.broadcast_item(item)
            self._restart_task(item.id)
            await self._send_result(client, f"You call {item.title}.", item.id)
            return

        if not bool(item.params.get("doorOpen", False)):
            await self._begin_opening(item, current_z)
            await self._send_result(client, "The elevator door is opening.", item.id)
            return

        client.elevator_id = item.id
        floors = self._floor_elevations(item)
        if len(floors) == 2:
            self._queue_destination(item, next(z for z in floors if z != current_z))
        self._touch(item)
        await self.delivery.broadcast(client_position_packet(client))
        await self.callbacks.broadcast_item(item)
        self._restart_task(item.id)
        door_open_seconds = self._duration_seconds(
            item, "doorOpenSeconds", ELEVATOR_DOOR_OPEN_SECONDS
        )
        seconds_label = f"{door_open_seconds:g} second"
        if door_open_seconds != 1:
            seconds_label += "s"
        await self._send_result(
            client,
            f"You enter {item.title}. The door will close in {seconds_label}.",
            item.id,
        )
        await self.delivery.send(
            client,
            ItemElevatorStatusPacket(
                type="item_elevator_status",
                itemId=item.id,
                event="entered",
                z=current_z,
            ),
        )

    async def run_cycle(self, item_id: str) -> None:
        """Advance one elevator through travel, arrival, and door timing."""

        try:
            while True:
                item = self.callbacks.get_item(item_id)
                if item is None or item.type != "elevator":
                    return
                state = str(item.params.get("state", "idle"))
                if state == "moving":
                    origin_z = int(item.params.get("currentZ", 0))
                    target_z = int(item.params.get("targetZ", origin_z))
                    await self.advance_travel(item, origin_z, target_z)
                    item.params["currentZ"] = target_z
                    item.params["targetZ"] = None
                    item.params["state"] = "arriving"
                    item.params["doorOpen"] = False
                    self._touch(item)
                    await self.callbacks.broadcast_item(item)
                    await self._move_occupants(item, target_z)
                    await self._broadcast_opening_sounds(item, target_z)
                    continue
                if state in {"opening", "arriving"}:
                    await asyncio.sleep(ELEVATOR_DOOR_OPEN_SOUND_SECONDS)
                    current_z = int(item.params.get("currentZ", 0))
                    item.params["state"] = "door_open"
                    item.params["doorOpen"] = True
                    self._touch(item)
                    if state == "arriving":
                        await self._announce_arrival(item, current_z)
                    await self.callbacks.broadcast_item(item)
                    continue
                if state == "door_open":
                    await asyncio.sleep(
                        self._duration_seconds(
                            item, "doorOpenSeconds", ELEVATOR_DOOR_OPEN_SECONDS
                        )
                    )
                    current_z = int(item.params.get("currentZ", 0))
                    item.params["state"] = "closing"
                    item.params["doorOpen"] = False
                    self._touch(item)
                    await self.callbacks.broadcast_item(item)
                    await self._broadcast_sound(
                        item, current_z, "/sounds/elevator_close.ogg"
                    )
                    continue
                if state == "closing":
                    await asyncio.sleep(ELEVATOR_DOOR_CLOSE_SOUND_SECONDS)
                    current_z = int(item.params.get("currentZ", 0))
                    next_z = self._next_destination(item, current_z)
                    if next_z is None:
                        item.params["state"] = "idle"
                        item.params["targetZ"] = None
                    else:
                        self._set_moving(item, next_z)
                    self._touch(item)
                    await self.callbacks.broadcast_item(item)
                    if next_z is None:
                        return
                    continue
                return
        except asyncio.CancelledError:
            return
        except Exception:
            LOGGER.exception("elevator cycle failed item_id=%s", item_id)
            await self._return_to_idle(item_id)
        finally:
            current = self._tasks.get(item_id)
            if current is asyncio.current_task():
                self._tasks.pop(item_id, None)

    async def advance_travel(
        self, item: WorldItem, origin_z: int, destination_z: int
    ) -> None:
        """Publish progressive rider heights over the elevator travel interval."""

        distance = destination_z - origin_z
        try:
            speed = float(item.params.get("speed", ELEVATOR_SPEED))
        except (ValueError, TypeError):
            speed = ELEVATOR_SPEED
        if not isfinite(speed) or speed <= 0:
            speed = ELEVATOR_SPEED
        travel_seconds = abs(distance) / speed
        if distance == 0:
            await asyncio.sleep(travel_seconds)
            return
        direction = 1 if distance > 0 else -1
        update_count = max(
            1, min(abs(distance), ceil(travel_seconds / ELEVATOR_TRAVEL_UPDATE_SECONDS))
        )
        last_z = origin_z

        for update_index in range(1, update_count + 1):
            await asyncio.sleep(travel_seconds / update_count)
            if update_index == update_count:
                continue
            travel_z = round(origin_z + (distance * update_index / update_count))
            if direction > 0:
                travel_z = max(origin_z + 1, min(destination_z - 1, travel_z))
            else:
                travel_z = max(destination_z + 1, min(origin_z - 1, travel_z))
            if travel_z == last_z:
                continue
            last_z = travel_z
            await self._broadcast_travel_position(item, travel_z)

    async def _broadcast_opening_sounds(self, item: WorldItem, current_z: int) -> None:
        """Start the direction chime and door clip together at this landing."""

        next_z = self._next_destination(item, current_z, consume=False)
        going_down = (
            next_z < current_z
            if next_z is not None
            else current_z == max(self._floor_elevations(item))
        )
        chime = "/sounds/elevator_down.ogg" if going_down else "/sounds/elevator_up.ogg"
        await self._broadcast_sound(item, current_z, chime, inside_cabin=True)
        await self._broadcast_sound(item, current_z, "/sounds/elevator_open.ogg")

    async def _begin_opening(self, item: WorldItem, current_z: int) -> None:
        """Enter the non-traversable opening phase and start its sound."""

        item.params["state"] = "opening"
        item.params["doorOpen"] = False
        self._touch(item)
        await self.callbacks.broadcast_item(item)
        await self._broadcast_opening_sounds(item, current_z)
        self._restart_task(item.id)

    async def _move_occupants(self, item: WorldItem, destination_z: int) -> None:
        """Place riders and carried items at the landing as the doors start opening."""

        riders = [
            rider
            for rider in self.callbacks.iter_clients()
            if rider.elevator_id == item.id
        ]
        carried_items: list[WorldItem] = []
        for rider in riders:
            rider.x = item.x
            rider.y = item.y
            rider.z = destination_z
            rider.last_position_update_ms = self.callbacks.now_ms()
            self.callbacks.persist_client_position(rider)
            for carried in self.callbacks.find_carried_items(rider.id):
                move_item(carried, rider.x, rider.y, rider.z)
                carried.updatedAt = self.callbacks.now_ms()
                carried.updatedBy = rider.user_id or rider.id
                carried.updatedByName = rider.username or rider.nickname
                carried_items.append(carried)
        for carried in carried_items:
            if self.callbacks.get_item(carried.id) is carried:
                await self.callbacks.broadcast_item(carried)
        for rider in riders:
            if rider.elevator_id != item.id:
                continue
            await self.delivery.broadcast(client_position_packet(rider))

    async def _announce_arrival(self, item: WorldItem, destination_z: int) -> None:
        """Tell passengers when the fully open car can be exited."""

        for rider in tuple(self.callbacks.iter_clients()):
            if rider.elevator_id != item.id:
                continue
            await self.delivery.send(
                rider,
                ItemElevatorStatusPacket(
                    type="item_elevator_status",
                    itemId=item.id,
                    event="arrived",
                    z=destination_z,
                    message=(
                        f"{item.title} arrives on "
                        f"{self.callbacks.floor_name(item.x, item.y, destination_z)}. The door opens."
                    ),
                ),
            )

    async def _broadcast_sound(
        self, item: WorldItem, current_z: int, sound: str, *, inside_cabin: bool = False
    ) -> None:
        """Emit a landing sound, with a direct cabin feed for the direction chime."""

        packet = ItemUseSoundPacket(
            type="item_use_sound",
            itemId=item.id,
            sound=sound,
            x=item.x,
            y=item.y,
            z=current_z,
            acousticZoneId=floor_acoustic_zone_id(current_z),
            range=self.callbacks.get_emit_range(item),
        )
        if not inside_cabin:
            await self.delivery.broadcast(packet)
            return
        cabin = packet.model_copy(
            update={"acousticZoneId": elevator_acoustic_zone_id(item.id)}
        )
        await asyncio.gather(
            *(
                self.delivery.send(
                    listener, cabin if listener.elevator_id == item.id else packet
                )
                for listener in tuple(self.callbacks.iter_clients())
            )
        )

    async def _broadcast_travel_position(self, item: WorldItem, travel_z: int) -> None:
        """Move riders to one intermediate elevator height."""

        for rider in tuple(self.callbacks.iter_clients()):
            if rider.elevator_id != item.id:
                continue
            rider.x = item.x
            rider.y = item.y
            rider.z = travel_z
            carried_items = self.callbacks.find_carried_items(rider.id)
            for carried in carried_items:
                move_item(carried, rider.x, rider.y, rider.z)
                await self.callbacks.broadcast_item(carried)
            await self.delivery.broadcast(client_position_packet(rider))
            await self.delivery.send(
                rider,
                ItemElevatorStatusPacket(
                    type="item_elevator_status",
                    itemId=item.id,
                    event="moving",
                    z=travel_z,
                ),
            )

    async def _return_to_idle(self, item_id: str) -> None:
        """Park a car whose cycle failed at its last landing with the door closed.

        Riders and their carried items are placed at that landing too, since the
        failure may have left them at a travel height. Positions are broadcast
        but not saved, because saving may be what failed.
        """

        # Leave the task table so a use() during the broadcasts below starts a
        # new cycle without cancelling this recovery.
        if self._tasks.get(item_id) is asyncio.current_task():
            self._tasks.pop(item_id, None)
        item = self.callbacks.get_item(item_id)
        if item is None or item.type != "elevator":
            return
        # Settle all state before the first await, so a cycle started during
        # the broadcasts sees a parked car with riders at the landing.
        item.params.update(
            {
                "targetZ": None,
                "requestedZs": [],
                "state": "idle",
                "doorOpen": False,
            }
        )
        self._touch(item)
        landing_z = int(item.params.get("currentZ", 0))
        riders = [
            rider
            for rider in self.callbacks.iter_clients()
            if rider.elevator_id == item.id
        ]
        carried_items: list[WorldItem] = []
        ejected: list[ClientConnection] = []
        for rider in riders:
            landing = self.callbacks.landing_position(item.x, item.y, landing_z)
            if landing is None or landing[2] != landing_z:
                rider.x, rider.y, rider.z = landing or self.callbacks.fallback_spawn()
                rider.elevator_id = None
                ejected.append(rider)
            else:
                rider.x, rider.y, rider.z = item.x, item.y, landing_z
            for carried in self.callbacks.find_carried_items(rider.id):
                move_item(carried, rider.x, rider.y, rider.z)
                carried_items.append(carried)
        await self.callbacks.broadcast_item(item)
        # Items and riders can leave during these awaits; don't resurrect them.
        for carried in carried_items:
            if self.callbacks.get_item(carried.id) is carried:
                await self.callbacks.broadcast_item(carried)
        for rider in riders:
            if any(client is rider for client in self.callbacks.iter_clients()):
                await self.delivery.broadcast(client_position_packet(rider))
                if rider in ejected and rider.elevator_id is None:
                    await self.delivery.send(
                        rider,
                        ItemElevatorStatusPacket(
                            type="item_elevator_status",
                            itemId=item.id,
                            event="exited",
                            z=rider.z,
                            message=f"{item.title} stopped unexpectedly. You are on {self.callbacks.floor_name(rider.x, rider.y, rider.z)}.",
                        ),
                    )

    def _touch(self, item: WorldItem) -> None:
        """Mark elevator state changed and schedule persistence."""

        item.updatedAt = self.callbacks.now_ms()
        item.updatedBy = "system"
        item.updatedByName = "system"
        item.version += 1
        self.callbacks.request_state_save()

    def _restart_task(self, item_id: str) -> None:
        """Restart the timer/state-machine task for one elevator."""

        existing = self._tasks.get(item_id)
        if existing is not None and existing is not asyncio.current_task():
            existing.cancel()
        self._tasks[item_id] = asyncio.create_task(self.run_cycle(item_id))

    async def _send_result(
        self, client: ClientConnection, message: str, item_id: str
    ) -> None:
        """Send a successful elevator-use result through the server callback."""

        await self.callbacks.send_item_result(client, True, "use", message, item_id)

    @staticmethod
    def _floor_elevations(item: WorldItem) -> list[int]:
        """Return this elevator's configured floors in ascending order."""

        floors = item.params.get("floorZs", [0, 40])
        return sorted(int(z) for z in floors if isinstance(z, int))

    @staticmethod
    def _next_destination(
        item: WorldItem, current_z: int, *, consume: bool = True
    ) -> int | None:
        """Find the next requested stop, advancing the queue only for departure."""
        queue = item.params.get("requestedZs", [])
        floors = ElevatorRuntime._floor_elevations(item)
        for index, destination in enumerate(queue):
            if destination in floors and destination != current_z:
                if consume:
                    item.params["requestedZs"] = queue[index + 1 :]
                return destination
        if consume:
            item.params["requestedZs"] = []
        return None

    @staticmethod
    def _queue_destination(item: WorldItem, destination_z: int) -> bool:
        """Append a new request and leave existing requests untouched."""
        queue = list(item.params.get("requestedZs", []))
        if destination_z == item.params.get("targetZ") or destination_z in queue:
            return False
        queue.append(destination_z)
        item.params["requestedZs"] = queue
        return True

    @staticmethod
    def _set_moving(item: WorldItem, destination_z: int) -> None:
        item.params["state"] = "moving"
        item.params["targetZ"] = destination_z
        item.params["doorOpen"] = False

    @staticmethod
    def _duration_seconds(item: WorldItem, key: str, default: float) -> float:
        """Read one validated duration with a safe default for older items."""

        try:
            value = float(item.params.get(key, default))
        except (TypeError, ValueError):
            return default
        if not isfinite(value):
            return default
        return max(0, min(300, value))
