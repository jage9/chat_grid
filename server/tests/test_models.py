from pydantic import ValidationError, TypeAdapter

from app.models import ClientPacket


def test_update_position_validates() -> None:
    adapter = TypeAdapter(ClientPacket)
    packet = adapter.validate_python({"type": "update_position", "x": 10, "y": 12})
    assert packet.type == "update_position"


def test_unknown_type_rejected() -> None:
    adapter = TypeAdapter(ClientPacket)
    try:
        adapter.validate_python({"type": "unknown"})
    except ValidationError:
        return
    assert False, "validation should fail"


def test_item_add_accepts_piano_type() -> None:
    adapter = TypeAdapter(ClientPacket)
    packet = adapter.validate_python({"type": "item_add", "itemType": "piano"})
    assert packet.type == "item_add"


def test_item_piano_recording_packet_validates() -> None:
    adapter = TypeAdapter(ClientPacket)
    packet = adapter.validate_python({"type": "item_piano_recording", "itemId": "p1", "action": "toggle_record"})
    assert packet.type == "item_piano_recording"
    stop_packet = adapter.validate_python({"type": "item_piano_recording", "itemId": "p1", "action": "stop_record"})
    assert stop_packet.type == "item_piano_recording"


def test_item_transfer_packet_validates() -> None:
    adapter = TypeAdapter(ClientPacket)
    packet = adapter.validate_python({"type": "item_transfer", "itemId": "i1", "targetId": "u2"})
    assert packet.type == "item_transfer"
