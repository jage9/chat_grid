# Runtime Flow

## Connect Flow

1. User clicks connect.
2. Client validates auth form and sets up local media.
3. Client connects signaling websocket from the configured app origin.
4. Server accepts the socket only on the configured instance websocket path and when the browser `Origin` matches `CHGRID_HOST_ORIGIN`, then attempts cookie-based session resume from the instance-scoped websocket handshake cookie.
5. If resume does not authenticate, server sends `auth_required`.
   - includes `gridName` and `welcomeMessage` for pre-login branding.
   - includes `serverVersion` and `expectedClientRevision` for stale-client detection before login.
   - includes `authPolicy` limits for username/password.
6. Client sends `auth_login` or `auth_register` (or explicit `auth_resume` if provided by caller).
7. Server sends `auth_result`.
   - includes role + permissions for authenticated session.
8. Client persists authenticated session into instance-scoped server-managed `HttpOnly` cookie helpers under the active app base path via `GET <base_path>auth/session/set` (`Authorization: Bearer <sessionToken>`, `X-Chgrid-Auth-Client: 1`), and clears it via `GET <base_path>auth/session/clear` on logout/session errors.
   - the optional PHP media proxy validates that same cookie through `GET <base_path>auth/session/check` before relaying media
9. Server sends `welcome` with users/items snapshot, followed by a short-lived `livekit_token` when LiveKit is configured.
   - `livekit.room_name` is a deployment setting in `server/config.toml`.
   - `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` are required server environment values.
   - Server startup fails with a clear configuration error when any of these values is absent.
10. Client:
   - applies `welcome.worldConfig.gridSize` for authoritative grid bounds/rendering
   - applies `welcome.worldConfig.floors` for floor names and elevations
   - applies `welcome.worldConfig.movementTickMs` as movement pacing guidance
   - applies `welcome.worldConfig.movementMaxStepsPerTick` for movement-rate parity
  - uses `welcome.player` as authoritative starting position (restored from server-side account state when available)
   - records `welcome.serverInfo` (`instanceId`, `releaseVersion`, `serverVersion`, `expectedClientRevision`, `gridName`, `welcomeMessage`) for restart detection and client branding
   - if `welcome.serverInfo.expectedClientRevision` differs from the running client revision, auto-reloads the page
   - applies `welcome.uiDefinitions` for item menus/properties/options, server-backed command metadata, item-management metadata, and admin menu labels/order
   - sends initial `update_position` echo from server-assigned starting tile
   - sends initial `update_nickname`
   - creates peer runtimes for known users
   - joins the LiveKit room with the server-issued token and publishes the processed microphone track
   - syncs item runtimes (`radio`, `emit`)
   - applies audio layer state
   - starts signaling heartbeat monitor
   - starts game loop

## Main Loop

Each frame:

- Handle local movement input.
- Send movement intents; server remains authoritative on accepted movement updates.
- Update spatial voice audio.
- Update spatial radio audio.
- Update spatial item emit audio.
- Draw canvas scene.

Radio metadata polling is limited to stations near a listener, deduplicated by stream URL, and uses bounded concurrent fetches so slow stations do not hold up the others. Failed fetches preserve the last known title. Requesting now-playing triggers one immediate fetch when no metadata has been collected yet.

## Message Handling

Core incoming message effects:

- `livekit_token`: connects the authenticated browser to the LiveKit audio room.
- `auth_required`: prompt client to authenticate before gameplay messages.
- `auth_result`: auth success/failure with optional session token + account metadata + `authPolicy`.
- `auth_permissions`: live permission refresh (role + permission set) after role/permission admin changes.
- `admin_roles_list`: role metadata + user counts + permission keys for role management UI.
- `admin_users_list`: user metadata list for role/ban admin flows.
- `admin_action_result`: success/error for role/user admin mutations.
- `update_position`: update peer position; may play movement/teleport world sound.
- `teleport_complete`: play peer teleport landing sound at final tile.
- `update_nickname`: update peer display name.
- `chat_message`: append/readable status; optional system sound class.
- `item_upsert`: replace item snapshot and resync item runtimes.
- `item_remove`: remove item and cleanup runtimes.
- `item_action_result`: success/error status for actions.
- `item_use_sound`: play one-shot spatial sample (world layer gated).
- `item_piano_note`: start/stop synthesized piano notes from remote users (item layer gated).
- `item_piano_status`: structured piano mode/record/playback transitions (client runtime state).
- `item_elevator_status`: track local elevator entry, travel, arrival, and exit state.
- `pong`:
  - positive `clientSentAt`: user ping response (`P` command)
  - negative `clientSentAt`: internal heartbeat response

## Stale Connection Recovery

- If websocket closes unexpectedly, client starts reconnect flow immediately.
- While running, client also sends heartbeat `ping` every 10 seconds (fallback for silent half-open cases).
- If one heartbeat `pong` is missed (10-second interval), client starts reconnect flow.
- Reconnect flow waits 5 seconds and retries up to 3 times.
- If reconnect lands on a different `welcome.serverInfo.instanceId`, client announces server restart.
- Connect/reconnect status message is emitted from `welcome` and includes server version.
- Server-only deploys no longer force browser reloads unless `expectedClientRevision` changes.

## Authorization Runtime

- Server enforces item/chat/nickname/voice/admin permissions for each packet.
- Role and permission changes apply live to connected users without reconnect.
- `voice.send` revocation is pushed immediately via `auth_permissions`; client mutes outbound voice track.

## Floors And Elevators

- World positions use integer `x`, `y`, and `z`. Ground is `z=0`; the second floor is `z=40`.
- Normal movement and teleport packets must keep the server-owned `z`. Only the elevator changes floors.
- The client renders only the current floor. Item lists and interactions are current-floor only; the user list remains global and names each floor.
- Cross-floor user teleport is blocked in the client, and the server rejects any packet that attempts to change `z` directly.
- Positional voice, media, item, piano, clock, footstep, teleport, and use audio is gated by `z`.
- Each elevator is one independent 2 by 2 shaft object shared by both landings. Calls, doors, queueing, travel, rider movement, and carried-item movement are server-owned.
- A door remains open for five seconds. Travel takes another five seconds. During travel, riders are broadcast at an intermediate height and belong to neither floor.
- On startup, any incomplete persisted elevator timer is cleared and the car becomes closed and idle at its last completed landing.
- A process restart also drops items whose connection-scoped carrier no longer exists; a carried item caught at an intermediate travel height returns to the ground floor.

## Disconnect/Cleanup

On disconnect:

- Close signaling.
- Stop heartbeat monitor.
- Stop local media tracks.
- Cleanup peers and all audio runtimes.
- Reset UI/mode state and lists.

## Runtime Components

- `PeerManager`: LiveKit room lifecycle and remote track attach.
- `RadioStationRuntime`: shared stream sources + per-item output/effects/spatialization.
- `ItemEmitRuntime`: per-item looping emit source + spatialization.
- `AudioEngine`: shared audio context, samples, effects, voice graph.
