from __future__ import annotations

import json
from typing import cast

import pytest
from websockets.asyncio.server import ServerConnection

from app.server import ClientConnection, SignalingServer


def _fake_ws() -> ServerConnection:
    return cast(ServerConnection, object())


@pytest.mark.asyncio
async def test_item_use_has_global_cooldown(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="tester", x=5, y=6)
    server.clients[ws] = client
    item = server.item_service.default_item(client, "dice")
    server.item_service.add_item(item)

    send_payloads: list[object] = []
    now_ms = 10_000

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    async def fake_broadcast(packet: object, exclude: ServerConnection | None = None) -> None:
        return

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_broadcast", fake_broadcast)
    monkeypatch.setattr(server.item_service, "now_ms", lambda: now_ms)

    await server._handle_message(client, json.dumps({"type": "item_use", "itemId": item.id}))
    assert send_payloads[-1].ok is True

    now_ms += 400
    await server._handle_message(client, json.dumps({"type": "item_use", "itemId": item.id}))
    assert send_payloads[-1].ok is False
    assert "cooldown" in send_payloads[-1].message.lower()

    now_ms += 700
    await server._handle_message(client, json.dumps({"type": "item_use", "itemId": item.id}))
    assert send_payloads[-1].ok is True


@pytest.mark.asyncio
async def test_radio_use_toggles_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="tester", x=5, y=6)
    server.clients[ws] = client
    item = server.item_service.default_item(client, "radio_station")
    server.item_service.add_item(item)

    send_payloads: list[object] = []
    broadcast_payloads: list[object] = []
    now_ms = 20_000

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    async def fake_broadcast(packet: object, exclude: ServerConnection | None = None) -> None:
        broadcast_payloads.append(packet)

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_broadcast", fake_broadcast)
    monkeypatch.setattr(server.item_service, "now_ms", lambda: now_ms)

    assert item.params.get("enabled") is True
    await server._handle_message(client, json.dumps({"type": "item_use", "itemId": item.id}))
    assert item.params.get("enabled") is False
    assert send_payloads[-1].ok is True

    now_ms += 1200
    await server._handle_message(client, json.dumps({"type": "item_use", "itemId": item.id}))
    assert item.params.get("enabled") is True
    assert send_payloads[-1].ok is True

    assert any(getattr(packet, "type", "") == "item_upsert" for packet in broadcast_payloads)


@pytest.mark.asyncio
async def test_radio_media_fields_update_validate(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="tester", x=5, y=6)
    server.clients[ws] = client
    item = server.item_service.default_item(client, "radio_station")
    server.item_service.add_item(item)

    send_payloads: list[object] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    async def fake_broadcast(packet: object, exclude: ServerConnection | None = None) -> None:
        return

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_broadcast", fake_broadcast)

    await server._handle_message(
        client,
        json.dumps({"type": "item_update", "itemId": item.id, "params": {"mediaChannel": "left"}}),
    )
    assert send_payloads[-1].ok is True
    assert item.params.get("mediaChannel") == "left"

    await server._handle_message(
        client,
        json.dumps({"type": "item_update", "itemId": item.id, "params": {"mediaChannel": "invalid"}}),
    )
    assert send_payloads[-1].ok is False
    assert "mediachannel must be one of" in send_payloads[-1].message.lower()

    await server._handle_message(
        client,
        json.dumps({"type": "item_update", "itemId": item.id, "params": {"facing": 270}}),
    )
    assert send_payloads[-1].ok is True
    assert item.params.get("facing") == 270

    await server._handle_message(
        client,
        json.dumps({"type": "item_update", "itemId": item.id, "params": {"facing": 361}}),
    )
    assert send_payloads[-1].ok is False
    assert "facing must be between 0 and 360" in send_payloads[-1].message.lower()

    await server._handle_message(
        client,
        json.dumps({"type": "item_update", "itemId": item.id, "params": {"mediaVolume": 12}}),
    )
    assert send_payloads[-1].ok is True
    assert item.params.get("mediaVolume") == 12

    await server._handle_message(
        client,
        json.dumps({"type": "item_update", "itemId": item.id, "params": {"mediaEffect": "echo"}}),
    )
    assert send_payloads[-1].ok is True
    assert item.params.get("mediaEffect") == "echo"

    await server._handle_message(
        client,
        json.dumps({"type": "item_update", "itemId": item.id, "params": {"emitRange": 12}}),
    )
    assert send_payloads[-1].ok is True
    assert item.params.get("emitRange") == 12

    await server._handle_message(
        client,
        json.dumps({"type": "item_update", "itemId": item.id, "params": {"emitRange": 4}}),
    )
    assert send_payloads[-1].ok is False
    assert "emitrange must be between 5 and 20" in send_payloads[-1].message.lower()


@pytest.mark.asyncio
async def test_item_update_strips_unknown_params(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="tester", x=5, y=6)
    server.clients[ws] = client
    item = server.item_service.default_item(client, "radio_station")
    server.item_service.add_item(item)

    send_payloads: list[object] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    async def fake_broadcast(packet: object, exclude: ServerConnection | None = None) -> None:
        return

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_broadcast", fake_broadcast)

    await server._handle_message(
        client,
        json.dumps({"type": "item_update", "itemId": item.id, "params": {"mediaVolume": 25, "hackedFlag": True}}),
    )
    assert send_payloads[-1].ok is True
    assert item.params.get("mediaVolume") == 25
    assert "hackedFlag" not in item.params


@pytest.mark.asyncio
async def test_item_use_revalidates_updated_params(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="tester", x=5, y=6)
    server.clients[ws] = client
    item = server.item_service.default_item(client, "widget")
    item.params["hackedFlag"] = True
    server.item_service.add_item(item)

    send_payloads: list[object] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    async def fake_broadcast(packet: object, exclude: ServerConnection | None = None) -> None:
        return

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_broadcast", fake_broadcast)
    monkeypatch.setattr(server.item_service, "now_ms", lambda: 40_000)

    await server._handle_message(client, json.dumps({"type": "item_use", "itemId": item.id}))

    assert send_payloads[-1].ok is True
    assert item.params.get("enabled") is False
    assert "hackedFlag" not in item.params


@pytest.mark.asyncio
async def test_clock_use_reports_time_without_use_sound_packet(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="tester", x=5, y=6)
    server.clients[ws] = client
    item = server.item_service.default_item(client, "clock")
    server.item_service.add_item(item)

    send_payloads: list[object] = []
    broadcast_payloads: list[object] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    async def fake_broadcast(packet: object, exclude: ServerConnection | None = None) -> None:
        broadcast_payloads.append(packet)

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_broadcast", fake_broadcast)
    monkeypatch.setattr(server.item_service, "now_ms", lambda: 30_000)
    await server._handle_message(client, json.dumps({"type": "item_use", "itemId": item.id}))

    assert send_payloads[-1].ok is True
    assert send_payloads[-1].message == ""
    assert not any(getattr(packet, "type", "") == "item_use_sound" for packet in broadcast_payloads)
    assert any(getattr(packet, "type", "") == "item_clock_announce" for packet in broadcast_payloads)


@pytest.mark.asyncio
async def test_clock_timezone_update_validates(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="tester", x=5, y=6)
    server.clients[ws] = client
    item = server.item_service.default_item(client, "clock")
    server.item_service.add_item(item)

    send_payloads: list[object] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    async def fake_broadcast(packet: object, exclude: ServerConnection | None = None) -> None:
        return

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_broadcast", fake_broadcast)

    await server._handle_message(
        client,
        json.dumps({"type": "item_update", "itemId": item.id, "params": {"timeZone": "Europe/Berlin"}}),
    )
    assert send_payloads[-1].ok is True
    assert item.params.get("timeZone") == "Europe/Berlin"

    await server._handle_message(
        client,
        json.dumps({"type": "item_update", "itemId": item.id, "params": {"timeZone": "Invalid/Zone"}}),
    )
    assert send_payloads[-1].ok is False
    assert "timezone must be one of" in send_payloads[-1].message.lower()

    await server._handle_message(
        client,
        json.dumps({"type": "item_update", "itemId": item.id, "params": {"alarmEnabled": True}}),
    )
    assert send_payloads[-1].ok is True
    assert item.params.get("alarmEnabled") is True
    assert item.params.get("alarmTime") == "12:00 AM"

    await server._handle_message(
        client,
        json.dumps({"type": "item_update", "itemId": item.id, "params": {"alarmTime": "3:15 PM", "alarmEnabled": True}}),
    )
    assert send_payloads[-1].ok is True
    assert item.params.get("alarmEnabled") is True
    assert item.params.get("alarmTime") == "3:15 PM"

    await server._handle_message(
        client,
        json.dumps({"type": "item_update", "itemId": item.id, "params": {"use24Hour": True}}),
    )
    assert send_payloads[-1].ok is True
    assert item.params.get("use24Hour") is True
    assert item.params.get("alarmTime") == "15:15"


@pytest.mark.asyncio
async def test_failed_wheel_use_does_not_consume_cooldown(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="tester", x=5, y=6)
    server.clients[ws] = client
    item = server.item_service.default_item(client, "wheel")
    item.params["spaces"] = ",,,"
    server.item_service.add_item(item)

    send_payloads: list[object] = []
    now_ms = 40_000

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    async def fake_broadcast(packet: object, exclude: ServerConnection | None = None) -> None:
        return

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_broadcast", fake_broadcast)
    monkeypatch.setattr(server.item_service, "now_ms", lambda: now_ms)

    await server._handle_message(client, json.dumps({"type": "item_use", "itemId": item.id}))
    assert send_payloads[-1].ok is False
    assert "spaces" in send_payloads[-1].message.lower()

    item.params["spaces"] = "a,b,c"
    await server._handle_message(client, json.dumps({"type": "item_use", "itemId": item.id}))
    assert send_payloads[-1].ok is True


@pytest.mark.asyncio
async def test_widget_update_and_use(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="tester", x=5, y=6)
    server.clients[ws] = client
    item = server.item_service.default_item(client, "widget")
    server.item_service.add_item(item)

    send_payloads: list[object] = []
    broadcast_payloads: list[object] = []
    now_ms = 50_000

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    async def fake_broadcast(packet: object, exclude: ServerConnection | None = None) -> None:
        broadcast_payloads.append(packet)

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_broadcast", fake_broadcast)
    monkeypatch.setattr(server.item_service, "now_ms", lambda: now_ms)

    await server._handle_message(
        client,
        json.dumps(
            {
                "type": "item_update",
                "itemId": item.id,
                "params": {
                    "directional": True,
                    "facing": 123.4,
                    "emitRange": 7,
                    "emitVolume": 42,
                    "emitSoundSpeed": 25,
                    "emitSoundTempo": 60,
                    "emitEffect": "reverb",
                    "emitEffectValue": 63.2,
                    "useSound": "ping.ogg",
                    "emitSound": "https://example.com/ambient.ogg",
                },
            }
        ),
    )
    assert send_payloads[-1].ok is True
    assert item.params.get("directional") is True
    assert item.params.get("facing") == 123
    assert item.params.get("emitRange") == 7
    assert item.params.get("emitVolume") == 42
    assert item.params.get("emitSoundSpeed") == 25
    assert item.params.get("emitSoundTempo") == 60
    assert item.params.get("emitEffect") == "reverb"
    assert item.params.get("emitEffectValue") == 63.2
    assert item.params.get("useSound") == "sounds/ping.ogg"
    assert item.params.get("emitSound") == "https://example.com/ambient.ogg"

    await server._handle_message(client, json.dumps({"type": "item_use", "itemId": item.id}))
    assert send_payloads[-1].ok is True
    assert item.params.get("enabled") is False
    assert any(getattr(packet, "type", "") == "item_use_sound" for packet in broadcast_payloads)

    await server._handle_message(
        client,
        json.dumps({"type": "item_update", "itemId": item.id, "params": {"emitRange": 21}}),
    )
    assert send_payloads[-1].ok is False
    assert "emitrange must be between 1 and 20" in send_payloads[-1].message.lower()

    await server._handle_message(
        client,
        json.dumps({"type": "item_update", "itemId": item.id, "params": {"emitSoundSpeed": 101}}),
    )
    assert send_payloads[-1].ok is False
    assert "emitsoundspeed must be between 0 and 100" in send_payloads[-1].message.lower()

    await server._handle_message(
        client,
        json.dumps({"type": "item_update", "itemId": item.id, "params": {"emitSoundTempo": 101}}),
    )
    assert send_payloads[-1].ok is False
    assert "emitsoundtempo must be between 0 and 100" in send_payloads[-1].message.lower()


@pytest.mark.asyncio
async def test_carried_item_use_sound_uses_carrier_position(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="tester", x=5, y=6)
    server.clients[ws] = client
    item = server.item_service.default_item(client, "widget")
    item.params["useSound"] = "sounds/test.ogg"
    item.carrierId = client.id
    # Keep stale coordinates to verify carrier position is used for use-sound broadcasts.
    item.x = 1
    item.y = 1
    server.item_service.add_item(item)
    client.x = 9
    client.y = 10

    send_payloads: list[object] = []
    broadcast_payloads: list[object] = []
    now_ms = 60_000

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    async def fake_broadcast(packet: object, exclude: ServerConnection | None = None) -> None:
        broadcast_payloads.append(packet)

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_broadcast", fake_broadcast)
    monkeypatch.setattr(server.item_service, "now_ms", lambda: now_ms)

    await server._handle_message(client, json.dumps({"type": "item_use", "itemId": item.id}))
    assert send_payloads[-1].ok is True
    sound_packets = [packet for packet in broadcast_payloads if getattr(packet, "type", "") == "item_use_sound"]
    assert sound_packets
    assert sound_packets[-1].x == 9
    assert sound_packets[-1].y == 10


@pytest.mark.asyncio
async def test_piano_update_and_use(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="tester", x=5, y=6)
    server.clients[ws] = client
    item = server.item_service.default_item(client, "piano")
    server.item_service.add_item(item)

    send_payloads: list[object] = []
    broadcast_payloads: list[object] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    async def fake_broadcast(packet: object, exclude: ServerConnection | None = None) -> None:
        broadcast_payloads.append(packet)

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_broadcast", fake_broadcast)

    await server._handle_message(
        client,
        json.dumps(
            {
                "type": "item_update",
                "itemId": item.id,
                "params": {
                    "instrument": "drum_kit",
                    "emitRange": 12,
                },
            }
        ),
    )
    assert send_payloads[-1].ok is True
    assert item.params.get("instrument") == "drum_kit"
    assert item.params.get("voiceMode") == "poly"
    assert item.params.get("octave") == 0
    assert item.params.get("attack") == 1
    assert item.params.get("decay") == 22
    assert item.params.get("release") == 12
    assert item.params.get("brightness") == 68
    assert item.params.get("emitRange") == 12

    await server._handle_message(
        client,
        json.dumps({"type": "item_update", "itemId": item.id, "params": {"instrument": "nintendo"}}),
    )
    assert send_payloads[-1].ok is True
    assert item.params.get("instrument") == "nintendo"
    assert item.params.get("voiceMode") == "poly"
    assert item.params.get("octave") == 0
    assert item.params.get("attack") == 1
    assert item.params.get("decay") == 24
    assert item.params.get("release") == 15
    assert item.params.get("brightness") == 85

    await server._handle_message(client, json.dumps({"type": "item_use", "itemId": item.id}))
    assert send_payloads[-1].ok is True
    assert "begin playing" in send_payloads[-1].message.lower()
    assert not any(getattr(packet, "type", "") == "item_use_sound" for packet in broadcast_payloads)

    await server._handle_message(
        client,
        json.dumps({"type": "item_update", "itemId": item.id, "params": {"instrument": "banjo"}}),
    )
    assert send_payloads[-1].ok is False
    assert "instrument must be one of" in send_payloads[-1].message.lower()

    await server._handle_message(
        client,
        json.dumps({"type": "item_update", "itemId": item.id, "params": {"voiceMode": "mono", "octave": -2}}),
    )
    assert send_payloads[-1].ok is True
    assert item.params.get("voiceMode") == "mono"
    assert item.params.get("octave") == -2

    await server._handle_message(
        client,
        json.dumps({"type": "item_update", "itemId": item.id, "params": {"octave": 3}}),
    )
    assert send_payloads[-1].ok is False
    assert "octave must be between -2 and 2" in send_payloads[-1].message.lower()


@pytest.mark.asyncio
async def test_piano_note_packet_broadcasts(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws_sender = _fake_ws()
    sender = ClientConnection(websocket=ws_sender, id="u1", nickname="tester", x=5, y=6)
    ws_other = _fake_ws()
    other = ClientConnection(websocket=ws_other, id="u2", nickname="listener", x=7, y=6)
    server.clients[ws_sender] = sender
    server.clients[ws_other] = other
    item = server.item_service.default_item(sender, "piano")
    item.params["instrument"] = "organ"
    item.params["attack"] = 20
    item.params["decay"] = 60
    item.params["emitRange"] = 12
    server.item_service.add_item(item)

    send_payloads: list[object] = []
    broadcast_payloads: list[object] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    async def fake_broadcast(packet: object, exclude: ServerConnection | None = None) -> None:
        broadcast_payloads.append(packet)

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_broadcast", fake_broadcast)

    await server._handle_message(
        sender,
        json.dumps({"type": "item_piano_note", "itemId": item.id, "keyId": "KeyA", "midi": 60, "on": True}),
    )

    assert not send_payloads
    assert broadcast_payloads
    packet = broadcast_payloads[-1]
    assert getattr(packet, "type", "") == "item_piano_note"
    assert getattr(packet, "itemId", "") == item.id
    assert getattr(packet, "instrument", "") == "organ"
    assert getattr(packet, "voiceMode", "") == "poly"
    assert getattr(packet, "octave", 999) == 0
    assert getattr(packet, "attack", -1) == 20
    assert getattr(packet, "decay", -1) == 60
    assert getattr(packet, "release", -1) == 35
    assert getattr(packet, "brightness", -1) == 55
    assert getattr(packet, "emitRange", -1) == 12


@pytest.mark.asyncio
async def test_piano_note_key_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws_sender = _fake_ws()
    sender = ClientConnection(websocket=ws_sender, id="u1", nickname="tester", x=5, y=6)
    server.clients[ws_sender] = sender
    item = server.item_service.default_item(sender, "piano")
    server.item_service.add_item(item)

    broadcast_payloads: list[object] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        return

    async def fake_broadcast(packet: object, exclude: ServerConnection | None = None) -> None:
        broadcast_payloads.append(packet)

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_broadcast", fake_broadcast)

    for index in range(12):
        await server._handle_message(
            sender,
            json.dumps({"type": "item_piano_note", "itemId": item.id, "keyId": f"Key{index}", "midi": 60, "on": True}),
        )
    assert len(broadcast_payloads) == 12

    # 13th distinct held key is dropped by cap.
    await server._handle_message(
        sender,
        json.dumps({"type": "item_piano_note", "itemId": item.id, "keyId": "KeyOverflow", "midi": 60, "on": True}),
    )
    assert len(broadcast_payloads) == 12


@pytest.mark.asyncio
async def test_piano_recording_toggle_and_save(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="tester", x=5, y=6)
    server.clients[ws] = client
    item = server.item_service.default_item(client, "piano")
    server.item_service.add_item(item)

    send_payloads: list[object] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    async def fake_broadcast(packet: object, exclude: ServerConnection | None = None) -> None:
        return

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_broadcast", fake_broadcast)

    await server._handle_message(
        client,
        json.dumps({"type": "item_piano_recording", "itemId": item.id, "action": "toggle_record"}),
    )
    assert send_payloads[-2].type == "item_piano_status"
    assert send_payloads[-2].event == "record_started"
    assert send_payloads[-1].ok is True
    assert item.id in server.piano_recording_state_by_item

    await server._handle_message(
        client,
        json.dumps({"type": "item_piano_note", "itemId": item.id, "keyId": "KeyA", "midi": 60, "on": True}),
    )
    await server._handle_message(
        client,
        json.dumps({"type": "item_piano_note", "itemId": item.id, "keyId": "KeyA", "midi": 60, "on": False}),
    )
    await server._handle_message(
        client,
        json.dumps({"type": "item_piano_recording", "itemId": item.id, "action": "toggle_record"}),
    )
    assert send_payloads[-2].type == "item_piano_status"
    assert send_payloads[-2].event == "record_paused"
    assert send_payloads[-1].ok is True
    assert send_payloads[-1].message == "Recording paused."
    assert item.id in server.piano_recording_state_by_item

    await server._handle_message(
        client,
        json.dumps({"type": "item_piano_recording", "itemId": item.id, "action": "stop_record"}),
    )
    assert send_payloads[-2].type == "item_piano_status"
    assert send_payloads[-2].event == "record_stopped"
    assert send_payloads[-1].ok is True
    assert send_payloads[-1].message == "Recording stopped."
    assert item.id not in server.piano_recording_state_by_item
    song_id = item.params.get("songId")
    assert isinstance(song_id, str)
    payload = server.item_service.piano_songs.get(song_id)
    assert isinstance(payload, dict)
    keys = payload.get("keys")
    states = payload.get("states")
    events = payload.get("events")
    assert isinstance(keys, list) and "KeyA" in keys
    assert isinstance(states, list) and len(states) >= 1
    assert isinstance(events, list) and len(events) >= 2


@pytest.mark.asyncio
async def test_piano_playback_starts_task(monkeypatch: pytest.MonkeyPatch) -> None:
    server = SignalingServer("127.0.0.1", 8765, None, None)
    ws = _fake_ws()
    client = ClientConnection(websocket=ws, id="u1", nickname="tester", x=5, y=6)
    server.clients[ws] = client
    item = server.item_service.default_item(client, "piano")
    item.params["songId"] = "item:test-song"
    server.item_service.piano_songs["item:test-song"] = {
        "meta": {"instrument": "piano", "voiceMode": "poly", "attack": 15, "decay": 45, "release": 35, "brightness": 55, "emitRange": 15},
        "keys": ["KeyA"],
        "states": [["piano", "poly", 15, 45, 35, 55, 15]],
        "events": [[0, 0, 60, 1, 0]],
    }
    server.item_service.add_item(item)

    send_payloads: list[object] = []
    playback_started: list[str] = []

    async def fake_send(websocket: ServerConnection, packet: object) -> None:
        send_payloads.append(packet)

    async def fake_broadcast(packet: object, exclude: ServerConnection | None = None) -> None:
        return

    async def fake_start_playback(current_item) -> None:
        playback_started.append(current_item.id)

    monkeypatch.setattr(server, "_send", fake_send)
    monkeypatch.setattr(server, "_broadcast", fake_broadcast)
    monkeypatch.setattr(server, "_start_piano_playback", fake_start_playback)

    await server._handle_message(
        client,
        json.dumps({"type": "item_piano_recording", "itemId": item.id, "action": "playback"}),
    )
    assert send_payloads[-2].type == "item_piano_status"
    assert send_payloads[-2].event == "playback_started"
    assert send_payloads[-1].ok is True
    task = server.piano_playback_tasks_by_item.get(item.id)
    assert task is not None
    await task
    assert playback_started == [item.id]
