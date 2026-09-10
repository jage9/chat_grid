"""Teleporter item plugin metadata, validation, and action tests."""

from __future__ import annotations

import pytest

from app.item_service import ItemService
from app.items.types.teleporter.actions import use_item
from app.items.types.teleporter.definition import (
    CAPABILITIES,
    DEFAULT_DESTINATION,
    DEFAULT_TITLE,
)
from app.items.types.teleporter.validator import validate_update


def test_teleporter_defaults_and_destination_metadata(world) -> None:
    """A new teleporter exposes its metadata through the UI catalog."""

    service = ItemService()
    item = service.default_item(world.connect("tester"), "teleporter")
    definitions = world.server._build_ui_definitions()
    teleporter = next(
        entry for entry in definitions["itemTypes"] if entry["type"] == "teleporter"
    )
    destination_metadata = teleporter["propertyMetadata"]["destination"]

    assert item.title == DEFAULT_TITLE
    assert item.params["destination"] == DEFAULT_DESTINATION
    assert item.params["emitSound"] == "/sounds/whirr.ogg"
    assert item.params["emitRange"] == 5
    assert item.params["emitVolume"] == 100
    assert item.params["emitEffect"] == "off"
    assert teleporter["capabilities"] == list(CAPABILITIES)
    assert destination_metadata["valueType"] == "text"
    assert destination_metadata["label"] == "Destination"
    assert destination_metadata["maxLength"] == 100


def test_teleporter_validator_normalizes_three_integer_coordinates(world) -> None:
    """Destination syntax is normalized while world bounds remain a runtime concern."""

    service = ItemService()
    item = service.default_item(world.connect("tester"), "teleporter")

    validated = validate_update(
        item,
        {
            "destination": "  -12, 003, +40  ",
            "unexpected": "discarded",
        },
    )

    assert validated == {"destination": "-12, 3, 40"}


@pytest.mark.parametrize(
    "destination",
    [
        "",
        "1, 2",
        "1, 2, 3, 4",
        "1, 2.5, 3",
        "1; 2; 3",
        None,
        [1, 2, 3],
        "1" * 101,
    ],
)
def test_teleporter_validator_rejects_non_coordinate_text(world, destination) -> None:
    """Destination edits must contain exactly three integer values."""

    service = ItemService()
    item = service.default_item(world.connect("tester"), "teleporter")

    expected_message = (
        "100 characters or less"
        if isinstance(destination, str) and len(destination) > 100
        else "exactly three integers"
    )
    with pytest.raises(ValueError, match=expected_message):
        validate_update(item, {"destination": destination})


def test_teleporter_use_returns_server_teleport_intent(world) -> None:
    """Using a teleporter returns its destination for generic runtime handling."""

    service = ItemService()
    item = service.default_item(world.connect("tester"), "teleporter")
    item.params["destination"] = "4, 5, 40"

    result = use_item(item, "tester", lambda _params: "")

    assert result.teleport_destination == (4, 5, 40)
    assert result.self_message == "You teleport to 4, 5, 40."
    assert result.others_message == "tester teleports to 4, 5, 40."
