"""Checkpoint capture and restore through the live packet entry point."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

import app.server as server_module
from app.models import CheckpointResultPacket, WorldRestoredPacket

from .conftest import World


async def request(
    world: World, client, action: str, **fields
) -> CheckpointResultPacket:
    """Send one client request and return its typed private response."""

    await world.server._handle_message(
        client,
        json.dumps(
            {
                "type": "checkpoint_action",
                "action": action,
                **fields,
            }
        ),
    )
    return world.transport.last_packet_of_type(client, CheckpointResultPacket)


@pytest.mark.asyncio
async def test_revoked_client_cannot_publish_a_queued_checkpoint(
    make_world, tmp_path: Path
):
    world = make_world(state_file=tmp_path / "items.json")
    client = world.join("Builder", permissions={"world.checkpoint.capture"})
    started = asyncio.Event()

    async def capture() -> None:
        started.set()
        await world.server._handle_message(
            client,
            json.dumps(
                {"type": "checkpoint_action", "action": "capture", "label": "Queued"}
            ),
        )

    async with world.server._world_gate.operation():
        pending = asyncio.create_task(capture())
        await started.wait()
        assert not pending.done()
        client.revoked = True

    await pending
    assert world.server.world_store.list_checkpoints(0)["checkpoints"] == []


@pytest.mark.asyncio
async def test_capture_preview_restore_and_restart(make_world, tmp_path: Path):
    world = make_world(
        state_file=tmp_path / "items.json",
        structure_presets={"brick": {"title": "Wall", "movementBlocked": True}},
    )
    owner = world.join("Owner", x=4, y=4)
    guest = world.join("Guest", permissions=set())
    wall = world.server.structure_service.add_wall(
        owner, preset_id="brick", direction="north"
    )
    captured = await request(
        world, owner, "capture", label="Before studio remodel", requestId="capture-1"
    )
    assert captured.requestId == "capture-1"
    assert captured.ok and captured.checkpoints
    identifier = captured.checkpoints[0].id
    assert captured.checkpoints[0].counts["structures"] == 1
    world.server.structure_service.remove(wall.id)
    preview = await request(world, owner, "preview", checkpointId=identifier)
    assert preview.ok and preview.preview
    assert preview.preview.changes["structures"].added == 1
    restored = await request(
        world,
        owner,
        "restore",
        checkpointId=identifier,
        worldRevision=preview.preview.worldRevision,
    )
    assert restored.ok
    assert wall.id in world.server.structure_service.structures
    for client in (owner, guest):
        hydration = world.transport.last_packet_of_type(client, WorldRestoredPacket)
        assert hydration.structures[0]["id"] == wall.id
    reloaded = make_world(
        state_file=tmp_path / "items.json",
        structure_presets={"brick": {"title": "Wall", "movementBlocked": True}},
    )
    assert wall.id in reloaded.server.structure_service.structures
    listed = await request(world, owner, "list")
    assert listed.ok and listed.checkpoints and len(listed.checkpoints) == 2


@pytest.mark.asyncio
async def test_permissions_and_stale_restore_are_enforced(make_world, tmp_path: Path):
    world = make_world(state_file=tmp_path / "items.json")
    capturer = world.join("Builder", permissions={"world.checkpoint.capture"})
    viewer = world.join("Viewer", permissions={"world.checkpoint.view"})
    admin = world.join("Admin")
    saved = await request(world, capturer, "capture", label="Empty")
    assert saved.ok and saved.checkpoints
    identifier = saved.checkpoints[0].id
    assert not (await request(world, capturer, "list")).ok
    assert not (await request(world, viewer, "capture")).ok
    preview = await request(world, viewer, "preview", checkpointId=identifier)
    assert preview.ok and preview.preview
    assert not (
        await request(
            world,
            viewer,
            "restore",
            checkpointId=identifier,
            worldRevision=preview.preview.worldRevision,
        )
    ).ok
    world.server.item_service.piano_songs["new-song"] = {"title": "New song"}
    world.server._request_state_save()
    pending_save = world.server._pending_state_save_handle
    failed = await request(
        world,
        admin,
        "restore",
        checkpointId=identifier,
        worldRevision=preview.preview.worldRevision,
    )
    assert not failed.ok
    assert failed.preview is not None
    assert failed.preview.worldRevision != preview.preview.worldRevision
    assert "new-song" in world.server.item_service.piano_songs
    assert world.server._pending_state_save_handle is pending_save
    assert not world.transport.packets_of_type(admin, WorldRestoredPacket)


@pytest.mark.asyncio
async def test_checkpoint_failure_returns_message_without_live_changes(
    make_world, tmp_path: Path, monkeypatch
):
    world = make_world(state_file=tmp_path / "items.json")
    owner = world.join("Owner")

    def fail(*args):
        raise OSError("Disk full")

    monkeypatch.setattr(world.server.world_store, "capture", fail)
    result = await request(world, owner, "capture")
    assert not result.ok
    assert result.message == "Checkpoint storage failed. Please check the server log."
    assert world.server.item_service.items == {}


@pytest.mark.asyncio
async def test_restore_finishes_before_gate_reopens_when_requester_is_cancelled(
    make_world, tmp_path: Path, monkeypatch
):
    world = make_world(state_file=tmp_path / "items.json")
    owner = world.join("Owner")
    saved = await request(world, owner, "capture")
    assert saved.checkpoints
    identifier = saved.checkpoints[0].id
    preview = await request(world, owner, "preview", checkpointId=identifier)
    assert preview.preview
    entered = asyncio.Event()
    release = asyncio.Event()
    reconcile = server_module.reconcile_world_restore

    async def pause_reconcile(server):
        entered.set()
        await release.wait()
        await reconcile(server)

    monkeypatch.setattr(server_module, "reconcile_world_restore", pause_reconcile)
    restore = asyncio.create_task(
        world.server._handle_message(
            owner,
            json.dumps(
                {
                    "type": "checkpoint_action",
                    "action": "restore",
                    "checkpointId": identifier,
                    "worldRevision": preview.preview.worldRevision,
                }
            ),
        )
    )
    await entered.wait()
    restore.cancel()
    turn = asyncio.create_task(
        world.server._handle_message(
            owner,
            json.dumps(
                {
                    "type": "turn",
                    "direction": "right",
                }
            ),
        )
    )
    await asyncio.sleep(0)
    assert not turn.done()
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await restore
    await turn
    assert world.transport.last_packet_of_type(owner, CheckpointResultPacket).ok
    assert world.transport.packets_of_type(owner, WorldRestoredPacket)


@pytest.mark.asyncio
@pytest.mark.parametrize("permissions", [set(), {"world.checkpoint.capture"}])
async def test_unauthorized_or_rate_limited_request_never_acquires_world_gate(
    make_world, monkeypatch, permissions
):
    world = make_world()
    owner = world.join("Owner", permissions=permissions)

    def unexpected_gate(**kwargs):
        raise AssertionError("Rejected checkpoint must not acquire the world gate")

    monkeypatch.setattr(world.server._world_gate, "operation", unexpected_gate)
    monkeypatch.setattr(world.server, "_consume_rate_limit", lambda *args: False)
    result = await request(world, owner, "capture")
    assert not result.ok
