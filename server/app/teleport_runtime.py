"""Server-authoritative timing and state transitions for item teleports."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Literal, TypeAlias

from .acoustic_zones import client_position_packet
from .client import ClientConnection
from .delivery import Delivery
from .models import (
    BroadcastTeleportCompletePacket,
    FacingDeg,
    TeleportTransitionPacket,
)

LOGGER = logging.getLogger("chgrid.server.teleport")

TELEPORT_DURATION_MS = 2000
TELEPORT_HALF_DURATION_SECONDS = TELEPORT_DURATION_MS / 2000
TeleportDestination: TypeAlias = tuple[int, int, int]
TeleportPhase: TypeAlias = Literal["start", "arrive", "complete", "cancel"]
TeleportSleep: TypeAlias = Callable[[float], Awaitable[None]]


@dataclass(frozen=True)
class TeleportRuntimeCallbacks:
    """Server operations required by the generic teleport runtime."""

    delivery: Delivery
    is_in_bounds: Callable[[int, int], bool]
    is_supported_floor: Callable[[int], bool]
    persist_client_position: Callable[[ClientConnection], None]
    sync_carried_items: Callable[[ClientConnection], Awaitable[None]]
    now_ms: Callable[[], int]
    is_client_connected: Callable[[ClientConnection], bool] = lambda _client: True


@dataclass
class _ActiveTeleport:
    """Frozen state for one in-flight item teleport."""

    client: ClientConnection
    origin: TeleportDestination
    destination: TeleportDestination
    facing_deg: FacingDeg
    arrived: bool = False


class TeleportRuntime:
    """Run one server-authoritative transition per connected client."""

    def __init__(
        self,
        callbacks: TeleportRuntimeCallbacks,
        *,
        sleep: TeleportSleep = asyncio.sleep,
    ) -> None:
        """Create a runtime with injectable timing for deterministic tests."""

        self.callbacks = callbacks
        self.delivery = callbacks.delivery
        self._sleep = sleep
        self._active: dict[str, _ActiveTeleport] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}

    @property
    def active_client_ids(self) -> frozenset[str]:
        """Return ids currently reserved by an active teleport transition."""

        return frozenset(self._active)

    def is_active(self, client: ClientConnection) -> bool:
        """Return whether a client has an in-flight server transition."""

        return client.id in self._active

    def destination_error(self, destination: object) -> str | None:
        """Return a user-facing validation error for one requested destination."""

        if not isinstance(destination, tuple) or len(destination) != 3:
            return "Teleport destination must contain x, y, and z coordinates."
        if any(type(coordinate) is not int for coordinate in destination):
            return "Teleport destination coordinates must be integers."
        x, y, z = destination
        if not self.callbacks.is_in_bounds(x, y):
            return "Teleport destination is out of bounds."
        if not self.callbacks.is_supported_floor(z):
            return "Teleport destination is not a configured floor."
        return None

    async def begin(
        self, client: ClientConnection, destination: TeleportDestination
    ) -> bool:
        """Reserve a destination, notify the actor, and schedule its transition."""

        if self.destination_error(destination) is not None:
            return False
        if self.is_active(client) or client.elevator_id is not None:
            return False

        # Reserve before the first await so two uses cannot start concurrent
        # transitions for the same actor while packet delivery is in progress.
        frozen_destination: TeleportDestination = (
            destination[0],
            destination[1],
            destination[2],
        )
        state = _ActiveTeleport(
            client=client,
            origin=(client.x, client.y, client.z),
            destination=frozen_destination,
            facing_deg=client.facing_deg,
        )
        self._active[client.id] = state
        try:
            await self.delivery.send(
                client,
                self._transition_packet("start", frozen_destination),
            )
            self._tasks[client.id] = asyncio.create_task(self._run(state))
        except BaseException:
            self._active.pop(client.id, None)
            raise
        return True

    async def client_disconnected(self, client: ClientConnection) -> None:
        """Cancel one actor's task without sending packets to its closed socket."""

        self._active.pop(client.id, None)
        task = self._tasks.pop(client.id, None)
        if task is None:
            return
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    async def shutdown(self) -> None:
        """Cancel and await every active transition task."""

        tasks = list(self._tasks.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._tasks.clear()
        self._active.clear()

    async def _run(self, state: _ActiveTeleport) -> None:
        """Advance one transition through midpoint and completion phases."""

        client = state.client
        destination = state.destination
        try:
            await self._sleep(TELEPORT_HALF_DURATION_SECONDS)
            if not self.callbacks.is_client_connected(client):
                return

            # The destination is copied into the task state at activation. No
            # later item edit or deletion can change this authoritative move.
            client.x, client.y, client.z = destination
            client.facing_deg = state.facing_deg
            state.arrived = True
            client.last_position_update_ms = self.callbacks.now_ms()
            self.callbacks.persist_client_position(client)
            await self.delivery.broadcast(client_position_packet(client))
            await self.callbacks.sync_carried_items(client)
            await self.delivery.send(
                client,
                self._transition_packet("arrive", destination),
            )

            await self._sleep(TELEPORT_HALF_DURATION_SECONDS)
            if not self.callbacks.is_client_connected(client):
                return
            await self.delivery.send(
                client,
                self._transition_packet("complete", destination),
            )
            await self.delivery.broadcast(
                BroadcastTeleportCompletePacket(
                    type="teleport_complete",
                    id=client.id,
                    x=client.x,
                    y=client.y,
                    z=client.z,
                    facingDeg=client.facing_deg,
                    acousticZoneId=client_position_packet(client).acousticZoneId,
                ),
                exclude=client,
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            LOGGER.exception("teleport transition failed id=%s", client.id)
            if self.callbacks.is_client_connected(client):
                await self._send_cancel(state)
        finally:
            if self._active.get(client.id) is state:
                self._active.pop(client.id, None)
            if self._tasks.get(client.id) is asyncio.current_task():
                self._tasks.pop(client.id, None)

    async def _send_cancel(self, state: _ActiveTeleport) -> None:
        """Restore the actor's canonical endpoint after a failed transition."""

        client = state.client
        endpoint = (client.x, client.y, client.z) if state.arrived else state.origin
        client.facing_deg = state.facing_deg
        if not state.arrived:
            client.x, client.y, client.z = endpoint
        try:
            await self.delivery.send(client, client_position_packet(client))
            await self.delivery.send(
                client, self._transition_packet("cancel", endpoint)
            )
        except Exception:
            LOGGER.exception(
                "teleport cancellation notification failed id=%s", client.id
            )

    @staticmethod
    def _transition_packet(
        phase: TeleportPhase, destination: TeleportDestination
    ) -> TeleportTransitionPacket:
        """Build one actor-only transition packet with the shared duration."""

        return TeleportTransitionPacket(
            type="teleport_transition",
            phase=phase,
            x=destination[0],
            y=destination[1],
            z=destination[2],
            durationMs=TELEPORT_DURATION_MS,
        )
