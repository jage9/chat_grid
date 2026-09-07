"""Shared server-authoritative acoustic placement helpers."""

from __future__ import annotations

from .client import ClientConnection
from .models import BroadcastPositionPacket


def floor_acoustic_zone_id(z: int) -> str:
    """Return the stable acoustic-zone identifier for one world floor."""

    return f"floor:{z}"


def elevator_acoustic_zone_id(item_id: str) -> str:
    """Return the stable acoustic-zone identifier for one elevator cabin."""

    return f"elevator:{item_id}"


def client_acoustic_zone_id(client: ClientConnection) -> str:
    """Return the client's current cabin or floor acoustic zone."""

    if client.elevator_id:
        return elevator_acoustic_zone_id(client.elevator_id)
    return floor_acoustic_zone_id(client.z)


def client_position_packet(client: ClientConnection) -> BroadcastPositionPacket:
    """Build the canonical presence packet for a connected client."""

    return BroadcastPositionPacket(
        type="update_position",
        id=client.id,
        x=client.x,
        y=client.y,
        z=client.z,
        facingDeg=client.facing_deg,
        acousticZoneId=client_acoustic_zone_id(client),
    )
