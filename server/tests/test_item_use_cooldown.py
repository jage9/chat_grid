from __future__ import annotations

import json

import pytest

from app.models import (
    ItemUpsertPacket,
    ItemClockAnnouncePacket,
    ItemActionResultPacket,
    ItemPianoNoteBroadcastPacket,
    ItemPianoStatusPacket,
    ItemUseSoundPacket,
)

from .conftest import World


@pytest.mark.asyncio
async def test_item_use_has_global_cooldown(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    server, transport = world.server, world.transport
    client = world.join("tester", x=5, y=6, permissions={"item.use"}, client_id="u1")
    item = server.item_service.default_item(client, "dice")
    server.item_service.add_item(item)

    now_ms = 10_000

    monkeypatch.setattr(server.item_service, "now_ms", lambda: now_ms)

    await server._handle_message(
        client, json.dumps({"type": "item_use", "itemId": item.id})
    )
    assert transport.last_packet_of_type(client, ItemActionResultPacket).ok is True

    now_ms += 400
    await server._handle_message(
        client, json.dumps({"type": "item_use", "itemId": item.id})
    )
    item_result = transport.last_packet_of_type(client, ItemActionResultPacket)
    assert item_result.ok is False
    assert "cooldown" in item_result.message.lower()

    now_ms += 700
    await server._handle_message(
        client, json.dumps({"type": "item_use", "itemId": item.id})
    )
    assert transport.last_packet_of_type(client, ItemActionResultPacket).ok is True


@pytest.mark.asyncio
async def test_radio_use_toggles_enabled(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    server, transport = world.server, world.transport
    observer = world.join("observer", x=40, y=40)
    client = world.join("tester", x=5, y=6, permissions={"item.use"}, client_id="u1")
    item = server.item_service.default_item(client, "radio_station")
    server.item_service.add_item(item)

    now_ms = 20_000

    monkeypatch.setattr(server.item_service, "now_ms", lambda: now_ms)

    assert item.params.get("enabled") is True
    await server._handle_message(
        client, json.dumps({"type": "item_use", "itemId": item.id})
    )
    assert item.params.get("enabled") is False
    assert transport.last_packet_of_type(client, ItemActionResultPacket).ok is True

    now_ms += 1200
    await server._handle_message(
        client, json.dumps({"type": "item_use", "itemId": item.id})
    )
    assert item.params.get("enabled") is True
    assert transport.last_packet_of_type(client, ItemActionResultPacket).ok is True

    assert transport.packets_of_type(observer, ItemUpsertPacket)


@pytest.mark.asyncio
async def test_radio_media_fields_update_validate(
    world: World,
) -> None:
    server, transport = world.server, world.transport
    client = world.join(
        "tester", x=5, y=6, permissions={"item.edit.own"}, client_id="u1"
    )
    item = server.item_service.default_item(client, "radio_station")
    server.item_service.add_item(item)

    await server._handle_message(
        client,
        json.dumps(
            {
                "type": "item_update",
                "itemId": item.id,
                "params": {"mediaChannel": "left"},
            }
        ),
    )
    assert transport.last_packet_of_type(client, ItemActionResultPacket).ok is True
    assert item.params.get("mediaChannel") == "left"

    await server._handle_message(
        client,
        json.dumps(
            {
                "type": "item_update",
                "itemId": item.id,
                "params": {"mediaChannel": "invalid"},
            }
        ),
    )
    item_result = transport.last_packet_of_type(client, ItemActionResultPacket)
    assert item_result.ok is False
    assert "mediachannel must be one of" in item_result.message.lower()

    await server._handle_message(
        client,
        json.dumps(
            {"type": "item_update", "itemId": item.id, "params": {"facing": 270}}
        ),
    )
    assert transport.last_packet_of_type(client, ItemActionResultPacket).ok is True
    assert item.params.get("facing") == 270

    await server._handle_message(
        client,
        json.dumps(
            {"type": "item_update", "itemId": item.id, "params": {"facing": 361}}
        ),
    )
    item_result = transport.last_packet_of_type(client, ItemActionResultPacket)
    assert item_result.ok is False
    assert "facing must be between 0 and 360" in item_result.message.lower()

    await server._handle_message(
        client,
        json.dumps(
            {"type": "item_update", "itemId": item.id, "params": {"mediaVolume": 12}}
        ),
    )
    assert transport.last_packet_of_type(client, ItemActionResultPacket).ok is True
    assert item.params.get("mediaVolume") == 12

    await server._handle_message(
        client,
        json.dumps(
            {
                "type": "item_update",
                "itemId": item.id,
                "params": {"mediaEffect": "echo"},
            }
        ),
    )
    assert transport.last_packet_of_type(client, ItemActionResultPacket).ok is True
    assert item.params.get("mediaEffect") == "echo"

    await server._handle_message(
        client,
        json.dumps(
            {"type": "item_update", "itemId": item.id, "params": {"emitRange": 12}}
        ),
    )
    assert transport.last_packet_of_type(client, ItemActionResultPacket).ok is True
    assert item.params.get("emitRange") == 12

    await server._handle_message(
        client,
        json.dumps(
            {"type": "item_update", "itemId": item.id, "params": {"emitRange": 4}}
        ),
    )
    item_result = transport.last_packet_of_type(client, ItemActionResultPacket)
    assert item_result.ok is False
    assert "emitrange must be between 5 and 20" in item_result.message.lower()


@pytest.mark.asyncio
async def test_item_update_strips_unknown_params(
    world: World,
) -> None:
    server, transport = world.server, world.transport
    client = world.join(
        "tester", x=5, y=6, permissions={"item.edit.own"}, client_id="u1"
    )
    item = server.item_service.default_item(client, "radio_station")
    server.item_service.add_item(item)

    await server._handle_message(
        client,
        json.dumps(
            {
                "type": "item_update",
                "itemId": item.id,
                "params": {"mediaVolume": 25, "hackedFlag": True},
            }
        ),
    )
    assert transport.last_packet_of_type(client, ItemActionResultPacket).ok is True
    assert item.params.get("mediaVolume") == 25
    assert "hackedFlag" not in item.params


@pytest.mark.asyncio
async def test_item_use_revalidates_updated_params(
    world: World,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server, transport = world.server, world.transport
    client = world.join("tester", x=5, y=6, permissions={"item.use"}, client_id="u1")
    item = server.item_service.default_item(client, "widget")
    item.params["hackedFlag"] = True
    server.item_service.add_item(item)

    monkeypatch.setattr(server.item_service, "now_ms", lambda: 40_000)

    await server._handle_message(
        client, json.dumps({"type": "item_use", "itemId": item.id})
    )

    assert transport.last_packet_of_type(client, ItemActionResultPacket).ok is True
    assert item.params.get("enabled") is False
    assert "hackedFlag" not in item.params


@pytest.mark.asyncio
async def test_clock_use_reports_time_without_use_sound_packet(
    world: World,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server, transport = world.server, world.transport
    observer = world.join("observer", x=40, y=40)
    client = world.join("tester", x=5, y=6, permissions={"item.use"}, client_id="u1")
    item = server.item_service.default_item(client, "clock")
    server.item_service.add_item(item)

    monkeypatch.setattr(server.item_service, "now_ms", lambda: 30_000)
    await server._handle_message(
        client, json.dumps({"type": "item_use", "itemId": item.id})
    )

    item_result = transport.last_packet_of_type(client, ItemActionResultPacket)
    assert item_result.ok is True
    assert item_result.message == ""
    assert not transport.packets_of_type(observer, ItemUseSoundPacket)
    clock_packet = transport.packets_of_type(observer, ItemClockAnnouncePacket)[0]
    assert getattr(clock_packet, "acousticZoneId") == "floor:0"


@pytest.mark.asyncio
async def test_clock_timezone_update_validates(
    world: World,
) -> None:
    server, transport = world.server, world.transport
    client = world.join(
        "tester", x=5, y=6, permissions={"item.edit.own"}, client_id="u1"
    )
    item = server.item_service.default_item(client, "clock")
    server.item_service.add_item(item)

    await server._handle_message(
        client,
        json.dumps(
            {
                "type": "item_update",
                "itemId": item.id,
                "params": {"timeZone": "Europe/Berlin"},
            }
        ),
    )
    assert transport.last_packet_of_type(client, ItemActionResultPacket).ok is True
    assert item.params.get("timeZone") == "Europe/Berlin"

    await server._handle_message(
        client,
        json.dumps(
            {
                "type": "item_update",
                "itemId": item.id,
                "params": {"timeZone": "Invalid/Zone"},
            }
        ),
    )
    item_result = transport.last_packet_of_type(client, ItemActionResultPacket)
    assert item_result.ok is False
    assert "timezone must be one of" in item_result.message.lower()

    await server._handle_message(
        client,
        json.dumps(
            {"type": "item_update", "itemId": item.id, "params": {"alarmEnabled": True}}
        ),
    )
    assert transport.last_packet_of_type(client, ItemActionResultPacket).ok is True
    assert item.params.get("alarmEnabled") is True
    assert item.params.get("alarmTime") == "12:00 AM"

    await server._handle_message(
        client,
        json.dumps(
            {
                "type": "item_update",
                "itemId": item.id,
                "params": {"alarmTime": "3:15 PM", "alarmEnabled": True},
            }
        ),
    )
    assert transport.last_packet_of_type(client, ItemActionResultPacket).ok is True
    assert item.params.get("alarmEnabled") is True
    assert item.params.get("alarmTime") == "3:15 PM"

    await server._handle_message(
        client,
        json.dumps(
            {"type": "item_update", "itemId": item.id, "params": {"use24Hour": True}}
        ),
    )
    assert transport.last_packet_of_type(client, ItemActionResultPacket).ok is True
    assert item.params.get("use24Hour") is True
    assert item.params.get("alarmTime") == "15:15"


@pytest.mark.asyncio
async def test_failed_wheel_use_does_not_consume_cooldown(
    world: World,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server, transport = world.server, world.transport
    client = world.join("tester", x=5, y=6, permissions={"item.use"}, client_id="u1")
    item = server.item_service.default_item(client, "wheel")
    item.params["spaces"] = ",,,"
    server.item_service.add_item(item)

    now_ms = 40_000

    monkeypatch.setattr(server.item_service, "now_ms", lambda: now_ms)

    await server._handle_message(
        client, json.dumps({"type": "item_use", "itemId": item.id})
    )
    item_result = transport.last_packet_of_type(client, ItemActionResultPacket)
    assert item_result.ok is False
    assert "spaces" in item_result.message.lower()

    item.params["spaces"] = "a,b,c"
    await server._handle_message(
        client, json.dumps({"type": "item_use", "itemId": item.id})
    )
    assert transport.last_packet_of_type(client, ItemActionResultPacket).ok is True


@pytest.mark.asyncio
async def test_widget_update_and_use(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    server, transport = world.server, world.transport
    observer = world.join("observer", x=40, y=40)
    client = world.join(
        "tester", x=5, y=6, permissions={"item.edit.own", "item.use"}, client_id="u1"
    )
    item = server.item_service.default_item(client, "widget")
    server.item_service.add_item(item)

    now_ms = 50_000

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
    assert transport.last_packet_of_type(client, ItemActionResultPacket).ok is True
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

    await server._handle_message(
        client, json.dumps({"type": "item_use", "itemId": item.id})
    )
    assert transport.last_packet_of_type(client, ItemActionResultPacket).ok is True
    assert item.params.get("enabled") is False
    assert transport.packets_of_type(observer, ItemUseSoundPacket)

    await server._handle_message(
        client,
        json.dumps(
            {"type": "item_update", "itemId": item.id, "params": {"emitRange": 21}}
        ),
    )
    item_result = transport.last_packet_of_type(client, ItemActionResultPacket)
    assert item_result.ok is False
    assert "emitrange must be between 1 and 20" in item_result.message.lower()

    await server._handle_message(
        client,
        json.dumps(
            {
                "type": "item_update",
                "itemId": item.id,
                "params": {"emitSoundSpeed": 101},
            }
        ),
    )
    item_result = transport.last_packet_of_type(client, ItemActionResultPacket)
    assert item_result.ok is False
    assert "emitsoundspeed must be between 0 and 100" in item_result.message.lower()

    await server._handle_message(
        client,
        json.dumps(
            {
                "type": "item_update",
                "itemId": item.id,
                "params": {"emitSoundTempo": 101},
            }
        ),
    )
    item_result = transport.last_packet_of_type(client, ItemActionResultPacket)
    assert item_result.ok is False
    assert "emitsoundtempo must be between 0 and 100" in item_result.message.lower()


@pytest.mark.asyncio
async def test_carried_item_use_sound_uses_carrier_position(
    world: World,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server, transport = world.server, world.transport
    observer = world.join("observer", x=40, y=40)
    client = world.join("tester", x=5, y=6, permissions={"item.use"}, client_id="u1")
    item = server.item_service.default_item(client, "widget")
    item.params["useSound"] = "sounds/test.ogg"
    item.carrierId = client.id
    # Keep stale coordinates to verify carrier position is used for use-sound broadcasts.
    item.x = 1
    item.y = 1
    server.item_service.add_item(item)
    client.x = 9
    client.y = 10
    client.elevator_id = "car-1"

    now_ms = 60_000

    monkeypatch.setattr(server.item_service, "now_ms", lambda: now_ms)

    await server._handle_message(
        client, json.dumps({"type": "item_use", "itemId": item.id})
    )
    assert transport.last_packet_of_type(client, ItemActionResultPacket).ok is True
    sound_packets = transport.packets_of_type(observer, ItemUseSoundPacket)
    assert sound_packets
    assert sound_packets[-1].x == 9
    assert sound_packets[-1].y == 10
    assert sound_packets[-1].acousticZoneId == "elevator:car-1"


@pytest.mark.asyncio
async def test_piano_update_and_use(
    world: World,
) -> None:
    server, transport = world.server, world.transport
    observer = world.join("observer", x=40, y=40)
    client = world.join(
        "tester", x=5, y=6, permissions={"item.edit.own", "item.use"}, client_id="u1"
    )
    item = server.item_service.default_item(client, "piano")
    server.item_service.add_item(item)

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
    assert transport.last_packet_of_type(client, ItemActionResultPacket).ok is True
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
        json.dumps(
            {
                "type": "item_update",
                "itemId": item.id,
                "params": {"instrument": "nintendo"},
            }
        ),
    )
    assert transport.last_packet_of_type(client, ItemActionResultPacket).ok is True
    assert item.params.get("instrument") == "nintendo"
    assert item.params.get("voiceMode") == "poly"
    assert item.params.get("octave") == 0
    assert item.params.get("attack") == 1
    assert item.params.get("decay") == 24
    assert item.params.get("release") == 15
    assert item.params.get("brightness") == 85

    await server._handle_message(
        client, json.dumps({"type": "item_use", "itemId": item.id})
    )
    item_result = transport.last_packet_of_type(client, ItemActionResultPacket)
    assert item_result.ok is True
    assert "begin playing" in item_result.message.lower()
    assert not transport.packets_of_type(observer, ItemUseSoundPacket)

    await server._handle_message(
        client,
        json.dumps(
            {
                "type": "item_update",
                "itemId": item.id,
                "params": {"instrument": "banjo"},
            }
        ),
    )
    item_result = transport.last_packet_of_type(client, ItemActionResultPacket)
    assert item_result.ok is False
    assert "instrument must be one of" in item_result.message.lower()

    await server._handle_message(
        client,
        json.dumps(
            {
                "type": "item_update",
                "itemId": item.id,
                "params": {"voiceMode": "mono", "octave": -2},
            }
        ),
    )
    assert transport.last_packet_of_type(client, ItemActionResultPacket).ok is True
    assert item.params.get("voiceMode") == "mono"
    assert item.params.get("octave") == -2

    await server._handle_message(
        client,
        json.dumps({"type": "item_update", "itemId": item.id, "params": {"octave": 3}}),
    )
    item_result = transport.last_packet_of_type(client, ItemActionResultPacket)
    assert item_result.ok is False
    assert "octave must be between -2 and 2" in item_result.message.lower()


@pytest.mark.asyncio
async def test_piano_note_packet_broadcasts(
    world: World,
) -> None:
    server, transport = world.server, world.transport
    observer = world.join("observer", x=40, y=40)
    sender = world.join("tester", x=5, y=6, permissions={"item.use"}, client_id="u1")
    other = world.join("listener", x=7, y=6, client_id="u2")
    item = server.item_service.default_item(sender, "piano")
    item.params["instrument"] = "organ"
    item.params["attack"] = 20
    item.params["decay"] = 60
    item.params["emitRange"] = 12
    server.item_service.add_item(item)

    await server._handle_message(
        sender,
        json.dumps(
            {
                "type": "item_piano_note",
                "itemId": item.id,
                "keyId": "KeyA",
                "midi": 60,
                "on": True,
            }
        ),
    )

    assert not transport.packets_to(sender)
    assert transport.packets_to(observer)
    packet = transport.last_packet_of_type(observer, ItemPianoNoteBroadcastPacket)
    assert transport.packets_of_type(other, ItemPianoNoteBroadcastPacket) == [packet]
    assert packet.itemId == item.id
    assert packet.instrument == "organ"
    assert packet.voiceMode == "poly"
    assert packet.octave == 0
    assert packet.attack == 20
    assert packet.decay == 60
    assert packet.release == 35
    assert packet.brightness == 55
    assert packet.emitRange == 12


@pytest.mark.asyncio
async def test_piano_note_key_cap(
    world: World,
) -> None:
    server, transport = world.server, world.transport
    observer = world.join("observer", x=40, y=40)
    sender = world.join("tester", x=5, y=6, permissions={"item.use"}, client_id="u1")
    item = server.item_service.default_item(sender, "piano")
    server.item_service.add_item(item)

    for index in range(12):
        await server._handle_message(
            sender,
            json.dumps(
                {
                    "type": "item_piano_note",
                    "itemId": item.id,
                    "keyId": f"Key{index}",
                    "midi": 60,
                    "on": True,
                }
            ),
        )
    assert len(transport.packets_of_type(observer, ItemPianoNoteBroadcastPacket)) == 12
    assert transport.packets_of_type(sender, ItemPianoNoteBroadcastPacket) == []

    # 13th distinct held key is dropped by cap.
    await server._handle_message(
        sender,
        json.dumps(
            {
                "type": "item_piano_note",
                "itemId": item.id,
                "keyId": "KeyOverflow",
                "midi": 60,
                "on": True,
            }
        ),
    )
    assert len(transport.packets_of_type(observer, ItemPianoNoteBroadcastPacket)) == 12
    assert transport.packets_of_type(sender, ItemPianoNoteBroadcastPacket) == []


@pytest.mark.asyncio
async def test_piano_recording_toggle_and_save(
    world: World,
) -> None:
    server, transport = world.server, world.transport
    client = world.join("tester", x=5, y=6, permissions={"item.use"}, client_id="u1")
    item = server.item_service.default_item(client, "piano")
    server.item_service.add_item(item)

    await server._handle_message(
        client,
        json.dumps(
            {
                "type": "item_piano_recording",
                "itemId": item.id,
                "action": "toggle_record",
            }
        ),
    )
    assert (
        transport.last_packet_of_type(client, ItemPianoStatusPacket).event
        == "record_started"
    )
    assert transport.last_packet_of_type(client, ItemActionResultPacket).ok is True
    assert item.id in server.item_runtime.piano.recording_state_by_item

    await server._handle_message(
        client,
        json.dumps(
            {
                "type": "item_piano_note",
                "itemId": item.id,
                "keyId": "KeyA",
                "midi": 60,
                "on": True,
            }
        ),
    )
    await server._handle_message(
        client,
        json.dumps(
            {
                "type": "item_piano_note",
                "itemId": item.id,
                "keyId": "KeyA",
                "midi": 60,
                "on": False,
            }
        ),
    )
    await server._handle_message(
        client,
        json.dumps(
            {
                "type": "item_piano_recording",
                "itemId": item.id,
                "action": "toggle_record",
            }
        ),
    )
    assert (
        transport.last_packet_of_type(client, ItemPianoStatusPacket).event
        == "record_paused"
    )
    item_result = transport.last_packet_of_type(client, ItemActionResultPacket)
    assert item_result.ok is True
    assert item_result.message == "Recording paused."
    assert item.id in server.item_runtime.piano.recording_state_by_item

    await server._handle_message(
        client,
        json.dumps(
            {"type": "item_piano_recording", "itemId": item.id, "action": "stop_record"}
        ),
    )
    assert (
        transport.last_packet_of_type(client, ItemPianoStatusPacket).event
        == "record_stopped"
    )
    item_result = transport.last_packet_of_type(client, ItemActionResultPacket)
    assert item_result.ok is True
    assert item_result.message == "Recording stopped."
    assert item.id not in server.item_runtime.piano.recording_state_by_item
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
async def test_piano_playback_starts_task(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    server, transport = world.server, world.transport
    client = world.join("tester", x=5, y=6, permissions={"item.use"}, client_id="u1")
    item = server.item_service.default_item(client, "piano")
    item.params["songId"] = "item:test-song"
    server.item_service.piano_songs["item:test-song"] = {
        "meta": {
            "instrument": "piano",
            "voiceMode": "poly",
            "attack": 15,
            "decay": 45,
            "release": 35,
            "brightness": 55,
            "emitRange": 15,
        },
        "keys": ["KeyA"],
        "states": [["piano", "poly", 15, 45, 35, 55, 15]],
        "events": [[0, 0, 60, 1, 0]],
    }
    server.item_service.add_item(item)

    playback_started: list[str] = []

    async def fake_start_playback(current_item) -> None:
        playback_started.append(current_item.id)

    monkeypatch.setattr(
        server.item_runtime.piano, "_start_piano_playback", fake_start_playback
    )

    await server._handle_message(
        client,
        json.dumps(
            {"type": "item_piano_recording", "itemId": item.id, "action": "playback"}
        ),
    )
    assert (
        transport.last_packet_of_type(client, ItemPianoStatusPacket).event
        == "playback_started"
    )
    assert transport.last_packet_of_type(client, ItemActionResultPacket).ok is True
    task = server.item_runtime.piano.playback_tasks_by_item.get(item.id)
    assert task is not None
    await task
    assert playback_started == [item.id]
