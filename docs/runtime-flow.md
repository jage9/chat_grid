# Runtime Flow

## Connect Flow

1. User clicks connect.
2. Client validates nickname and sets up local media.
3. Client connects signaling websocket.
4. Server sends `welcome` with users/items snapshot.
5. Client:
   - applies `welcome.worldConfig.gridSize` for authoritative grid bounds/rendering
   - records `welcome.serverInfo` (`instanceId`, `version`) for restart detection
   - if `welcome.serverInfo.version` differs from running client version, auto-reloads the page
   - applies `welcome.uiDefinitions` for item menus/properties/options
   - sends initial `update_position`
   - sends initial `update_nickname`
   - creates peer runtimes for known users
   - syncs item runtimes (`radio`, `emit`)
   - applies audio layer state
   - starts signaling heartbeat monitor
   - starts game loop

## Main Loop

Each frame:

- Handle local movement input.
- Update spatial voice audio.
- Update spatial radio audio.
- Update spatial item emit audio.
- Draw canvas scene.

## Message Handling

Core incoming message effects:

- `signal`: WebRTC negotiation and ICE exchange.
- `update_position`: update peer position; may play movement/teleport world sound.
- `update_nickname`: update peer display name.
- `chat_message`: append/readable status; optional system sound class.
- `item_upsert`: replace item snapshot and resync item runtimes.
- `item_remove`: remove item and cleanup runtimes.
- `item_action_result`: success/error status for actions.
- `item_use_sound`: play one-shot spatial sample (world layer gated).
- `pong`:
  - positive `clientSentAt`: user ping response (`P` command)
  - negative `clientSentAt`: internal heartbeat response

## Stale Connection Recovery

- While running, client sends heartbeat `ping` every 10 seconds.
- If one heartbeat `pong` is missed (10-second interval), client auto-reconnects.
- If reconnect lands on a different `welcome.serverInfo.instanceId`, client announces server restart.
- Connect/reconnect status message is emitted from `welcome` and includes server version.

## Disconnect/Cleanup

On disconnect:

- Close signaling.
- Stop heartbeat monitor.
- Stop local media tracks.
- Cleanup peers and all audio runtimes.
- Reset UI/mode state and lists.

## Runtime Components

- `PeerManager`: peer connection lifecycle and remote track attach.
- `RadioStationRuntime`: shared stream sources + per-item output/effects/spatialization.
- `ItemEmitRuntime`: per-item looping emit source + spatialization.
- `AudioEngine`: shared audio context, samples, effects, voice graph.
