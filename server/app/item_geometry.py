"""Compact inclusive item bounds and position translation."""

from __future__ import annotations

from .models import COORDINATE_LIMIT, WorldItem

ITEM_SPAN_LIMIT = 1000
END_COORDINATES = ("endX", "endY", "endZ")
ITEM_DIMENSIONS = (
    ("width", "x", "endX"),
    ("depth", "y", "endY"),
    ("height", "z", "endZ"),
)


def item_bounds(item: WorldItem) -> tuple[int, int, int, int, int, int]:
    """Return start and inclusive end coordinates without enumerating cells."""

    return (
        item.x,
        item.y,
        item.z,
        item.endX if item.endX is not None else item.x,
        item.endY if item.endY is not None else item.y,
        item.endZ if item.endZ is not None else item.z,
    )


def validate_item_bounds(item: WorldItem) -> None:
    """Reject reversed, excessive or unsupported variable bounds."""

    starts = (item.x, item.y, item.z)
    ends = item_bounds(item)[3:]
    for start, end in zip(starts, ends):
        if abs(start) > COORDINATE_LIMIT or abs(end) > COORDINATE_LIMIT:
            raise ValueError("Item coordinates must be between -1000000 and 1000000.")
        if end < start:
            raise ValueError(
                "Ending coordinates must be at or beyond the starting coordinates."
            )
        if end - start + 1 > ITEM_SPAN_LIMIT:
            raise ValueError("Item dimensions cannot exceed 1000 cells on any axis.")
    if item.type != "widget" and starts != ends:
        raise ValueError("Only widgets support editable dimensions.")


def move_item(item: WorldItem, x: int, y: int, z: int) -> None:
    """Translate the anchor and optional endpoints together, preserving dimensions."""

    for field, old, new in zip(END_COORDINATES, (item.x, item.y, item.z), (x, y, z)):
        endpoint = getattr(item, field)
        if endpoint is not None:
            setattr(item, field, endpoint + new - old)
    item.x, item.y, item.z = x, y, z
