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
