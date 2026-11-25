# Protocol Notes

## Item duplication

Send item_duplicate with itemId to duplicate an item available on the caller's square or held by the caller. The server broadcasts item_upsert for the independent caller-owned copy and replies with item_action_result, action duplicate, and the new itemId on success. The client announces the duplication result once and returns to normal play. Failures create neither an item nor a saved song. Duplication uses the same creation rate budget as item_add and the ordinary ownership quota.

Named regions use `region_add`, `region_update` (name), `region_resize` (one edge, delta -1/+1), `region_slide` (axis, delta -1/+1) and `region_delete`. The server gates mutations with `world.structure.edit`, publishes `region_upsert`/`region_remove`, then sends `region_action_result`. Each region contains `id`, `name`, `floorZ`, `startX`, `startY`, `endX` and `endY`. Bounds are inclusive, and overlapping rectangles are valid. Welcome includes the complete `regions` collection.

This is a behavior guide for packet semantics beyond raw schemas.

## Direction

- Client packet schema lives in `server/app/models.py` (`ClientPacket`).
- Browser-side validation/parsing lives in `client/src/network/protocol.ts`.
- Keep these synchronized on every protocol change.

## Client -> Server

- `auth_register`: create account with username/password and optional email.
- `auth_login`: authenticate with username/password.
- `auth_resume`: resume prior session via stored session token.
- `auth_logout`: revoke current session and disconnect.
- `welcome_ready`: client confirms it accepted `welcome` preflight and is ready to join active roster. If the account was deleted or disabled, the server sends a failed `auth_result` and closes the connection.
- `livekit_token_request`: request fresh voice credentials with `{ "type": "livekit_token_request" }`. Requires an authenticated, world-ready client and enabled LiveKit configuration. The server replies only to the requester with `livekit_token`; unauthenticated requests receive the normal authentication error, and pre-ready or disabled-LiveKit requests are ignored.
- `admin_roles_list`: request server role list (with user counts + permission sets).
- `admin_role_create`: create role.
- `admin_role_update_permissions`: replace one role permission set.
- `admin_role_delete`: delete role with replacement role reassignment.
- `admin_users_list`: request the read-only registered-user list with no `action` (`user.list` permission), or request targets for an administration action (`action`: `set_role | ban | unban | delete_account`, gated by that action's permission).
- `admin_user_set_role`: set target user role.
- `admin_user_ban` / `admin_user_unban`: disable/enable user account. A ban closes every authenticated connection for that user.
- Disabling or deleting an account also discards its world actions still waiting for the world mutation gate.
- `admin_user_delete`: permanently delete target account and close every authenticated connection for that user.
- `update_position`: client movement intent with `x`, `y`, and `z`; server enforces bounds, wall crossings, rate policy, and an unchanged floor. Movement does not change the server-owned facing.
- `turn`: request a validated 45-degree relative turn in either audio mode with `{ "type": "turn", "direction": "left" | "right" }`; the server persists the resulting facing and republishes the canonical position.
- `update_facing`: retained absolute-facing packet for one of the eight headings with `facingDeg` in 45-degree steps. The server validates the heading and republishes the canonical position.
- `teleport_complete`: client signals an `x`, `y`, `z` teleport landing; server rejects direct floor changes and rebroadcasts the spatial cue.
- `update_nickname`: nickname change request (server enforces uniqueness).
- `chat_message`: player chat.
- `ping`: latency measurement.
- `item_add`, `item_pickup`, `item_drop`, `item_delete`, `item_use`, `item_update`: item actions.
- `item_transfer_targets`: request active ownership-transfer accounts, including offline accounts and excluding the current owner. The item must be on the ground at the sender’s square or held by the sender.
- `item_transfer`: transfer item ownership to another account (`targetUserId` required), without moving it or changing its carrier.
- `item_hand_targets`: request eligible recipients for an item held by the sender: online, another user on the same floor within five grid squares (Chebyshev distance), with pickup permission for the item and a free carrying slot. The sender also needs pickup/drop permission.
- `item_hand`: hand the held item to `targetUserId`. Recheck the sender and recipient conditions before changing carrier and position; ownership stays unchanged.
- `item_secondary_use`: trigger type-specific secondary action when implemented.
- `item_piano_note`: realtime piano note on/off for active piano use mode.
- `item_piano_recording`: piano record/playback control (`toggle_record`, `playback`, `stop_playback`).
- `structure_add_wall`: create a one-edge wall from a server preset on the requested side of the builder's current square.
- `structure_resize_wall`: decrease or increase one complete wall run's inclusive first/last occupied edge anchor by one; the result reports only the authoritative anchor `x, y, z`.
- `structure_slide_wall`: move a complete horizontal run along y or a complete vertical run along x by one edge, preserving its length.
- `structure_rotate_wall`: set a run to horizontal or vertical while preserving its canonical start coordinate and length.
- `structure_update_wall`: update one wall run's explicit `soundTransmission`, `occlusionLowpassHz`, and/or `contactSound`; supplying `preset` reapplies all server-owned defaults for that type before optional explicit overrides.
- `structure_delete`: delete one complete wall run.

## Server -> Client

- Presence `update_position` includes `userId`, the stable account identifier behind the connection `id`. Welcome users carry the same identifier. Personal voice mute is local to the listener's browser and is keyed by grid endpoint, listener account, and speaker account. Incoming voice waits for signaling identity before audio attachment, including when LiveKit delivers a track before the presence packet. Anonymous speakers use connection-only mute preferences. Mute does not change per-speaker listen volume.
- `auth_required`: authentication challenge after websocket connect.
  - includes `gridName`, `welcomeMessage`, `serverVersion`, and `expectedClientRevision`.
- `auth_result`: auth success/failure and session/account metadata.
- `auth_permissions`: server-pushed live role/permission refresh for current session.
- `admin_roles_list`: role list response payload.
- `admin_users_list`: user list response payload, including `online` and the
  server-owned `lastSeenAt` Unix timestamp in milliseconds.
- `admin_action_result`: structured result for user-list authorization and admin actions.
  - admin mutations include `user_delete` for account deletion.
- `welcome`: initial snapshot with users/items plus server UI/world metadata.
  - Server delays roster activation until `welcome_ready`, then publishes the new user's position and nickname before the login announcement.
- `livekit_token`: short-lived authenticated LiveKit room token and public WebSocket URL.
  - Contains `type: "livekit_token"`, `token`, and `url`. Issued after authenticated `welcome` or in response to `livekit_token_request` when complete LiveKit configuration is enabled. Each issuance generates a token with a fresh 15-minute lifetime for the current connection identity and permissions.
  - The API secret is never sent to the browser.
- `update_position`, `update_nickname`, `user_left`: presence updates. `welcome.player`, `welcome.users[]`, and `update_position` carry the server-owned `acousticZoneId` (`floor:<z>` or `elevator:<itemId>`), and player/presence records carry canonical `facingDeg`. Activation publishes position followed by nickname so existing clients can hydrate a complete peer entry immediately.
- `teleport_complete`: peer teleport landing event with spatial coordinates, preserved `facingDeg`, and source `acousticZoneId`.
- `teleport_transition`: actor-only server transition with `phase` (`start`, `arrive`, `complete`, or `cancel`), destination `x`, `y`, `z`, and `durationMs` (2000). The server publishes the authoritative position before `arrive`, halfway through the transition. The browser fades location audio and blocks movement until completion or cancellation; it does not send a destination or completion response for this flow.
- `chat_message`: system and user chat stream.
- `pong`: ping response.
- `nickname_result`: accepted/rejected nickname result.
- `item_upsert`: full item replacement after mutation.
- `item_remove`: item deletion.
- `item_action_result`: action success/failure and user-facing message. When an `item_update` includes a `requestId`, the server echoes it in the result, including rejections. The editor matches the reply to the pending adjustment and uses the authoritative `item_upsert` for the accepted value.
- `item_transfer_targets`: transfer target account list for one item.
- `item_hand_targets`: eligible handoff target list for one item; each target has `userId`, `username`, and `online: true`.
- `item_use_sound`: spatial one-shot sound on successful item use (if `useSound` configured), including source `acousticZoneId`.
- `item_clock_announce`: ordered list of clock speech samples to play sequentially as spatial audio, including source `acousticZoneId`.
- `item_piano_note`: broadcast piano note on/off with resolved instrument/envelope/spatial params.
- `item_piano_status`: structured piano mode/record/playback state events for client runtime control.
- `item_elevator_status`: targeted rider state (`entered`, `moving`, `arrived`, or `exited`) with `itemId`, `z`, and an optional user-facing `message`.
- `elevator_select_floor` carries `itemId` and integer `z`. The server accepts a request from a current rider for a configured stop and replies through the existing item-use result path. Accepted destinations join the car's ordered queue. Invalid or stale requests leave the current trip intact.
- `structure_upsert`: full wall-run replacement after a live create, resize, slide, rotation, or property update.
- `structure_remove`: removal of one wall run.
- `structure_action_result`: success/error and user-facing status for add, resize, slide, rotate, update, or delete. Successful edit results contain only the authoritative new coordinate/property value so shared controls do not receive a second narrative announcement.
- `world_sound`: server-validated positional structure contact sound (`sound`, `x`, `y`, `z`, `acousticZoneId`, optional `range`) sent to users other than the mover.

## Item Packet Behavior

- `item_upsert` is full-state replacement for one item, not partial patch.
- `item_upsert.item.display` is server-owned display text for readonly/system properties (for example: `createdBy`, `updatedBy`, `createdAt`, `updatedAt`, `capabilities`, `useSound`, `emitSound`).
- `item_action_result` messages are intended for direct screen-reader/user status feedback.
  - `action` includes: `add`, `pickup`, `drop`, `delete`, `transfer`, `hand`, `use`, `secondary_use`, `update`
- Successful `item_pickup` and `item_drop` also emit system chat lines to other users in the room.
- Ownership transfer is account-based and permits ground items on the sender’s square or items held by the sender; recipients may be offline, distant, or at carrying capacity. Handing an item changes only possession, requires the sender to hold it, and validates recipient eligibility again on execution. Failed handoffs leave ownership, carrier, position, and audit fields unchanged.
- Piano runtime control no longer depends on parsing `item_action_result.message` text.
- `item_piano_status` carries machine-readable piano events (`use_mode_entered`, record/playback transitions).
- `item_use_sound` contains absolute item world coordinates (`x`, `y`, `z`), source `acousticZoneId`, and sound path.
  - For carried items, source coordinates and acoustic zone resolve to the carrier's current placement.
- `item_clock_announce` contains:
  - `itemId`
  - `sounds`: ordered sample URLs (EL640 phrase parts)
  - absolute source coordinates `x`, `y`, `z`
  - source `acousticZoneId`
  - generated by server for manual clock `use`, top-of-hour auto announce, and alarm auto announce (when enabled)
- `teleport_complete` contains absolute player world coordinates (`x`, `y`, `z`), preserved `facingDeg`, and `acousticZoneId` at teleport landing.
- Radio metadata (`params.stationName`, `params.nowPlaying`) is server-managed and delivered through normal `item_upsert` updates.
- `item_piano_note` contains:
  - `itemId`, `senderId`, `keyId`, `midi`, `on`
  - resolved `instrument`, `voiceMode`, `octave`, `attack`, `decay`, `release`, `brightness`, `emitRange`
  - absolute source coordinates `x`, `y`, `z`
- `item_upsert.item.occupiedOffsets` contains the server-owned horizontal footprint relative to the item anchor.
- Elevator travel sends progressive intermediate `update_position.z` values so rider coordinates advance throughout the trip while remaining outside both floor audio and visibility groups until arrival.
- Elevator entry and exit also broadcast `update_position` even when coordinates do not change, so every client updates the rider's acoustic-zone membership immediately.
- At each elevator opening, the server publishes the opening state and sends the direction chime and opening clip as consecutive `item_use_sound` packets. Arriving riders receive their landing position before either cue. The chime uses the cabin acoustic zone for riders and the landing zone for everyone else. Opening and closing clips use the landing zone so riders hear them through the door.

## Welcome Metadata

- `welcome.auth`: authenticated account identity:
  - `authenticated`
  - `userId`
  - `username`
  - `role`
  - `permissions`
  - `policy` (`usernameMinLength`, `usernameMaxLength`, `passwordMinLength`, `passwordMaxLength`)
- `auth_required.authPolicy`: server auth limits advertised before login/register submit.
- `auth_required.gridName` / `auth_required.welcomeMessage`: server-owned pre-login branding values.
- `auth_required.serverVersion`: server diagnostics version text shown in connect/reconnect messaging.
- `auth_required.expectedClientRevision`: authoritative browser asset revision required by this server instance.
- `auth_result.authPolicy`: server auth limits echoed on auth success/failure responses.
- `auth_result.sessionToken` is used by the client to call the instance-scoped HTTP endpoint `GET <base_path>auth/session/set` (`Authorization: Bearer <sessionToken>`, `X-Chgrid-Auth-Client: 1`) so the server can issue an instance-scoped `HttpOnly` session cookie.
- `welcome.platforms` and `world_restored.platforms` carry the complete set of walkable rectangles. Records have a stable `id`, `name`, signed inclusive `startX`, `startY`, `endX`, `endY`, and one elevation `z`. The server sends `platform_upsert` and `platform_remove` for live changes.
- Platforms include `footstepSet`, defaulting to `default` for existing worlds and checkpoints. `welcome.worldConfig.footstepSets` publishes installed set IDs, titles and sample URLs discovered from `client/public/sounds/steps/<set>/`. Platform add/update accepts an installed ID. An unavailable saved choice remains editable and uses the browser's default footsteps until its assets are installed again.
- Builders with `world.platform.edit` send `platform_add`, `platform_update`, or `platform_delete`. Updates and deletions identify the platform by `platformId`. The server replies with `platform_action_result` and sends accepted changes to all connected clients. An optional `requestId` is echoed on both successful and rejected results so the editor can ignore replies from an abandoned session. Repeated coordinate adjustments are applied sequentially from authoritative results and discarded when the edit fails or the selected property changes.
- `welcome.worldConfig.gridSize` supplies the initial square dimensions for older worlds and a display scale for the canvas.
- `welcome.worldConfig.movementTickMs`: server movement-rate window used for client movement pacing.
- `welcome.worldConfig.movementMaxStepsPerTick`: max allowed grid steps per movement window.
- `welcome.worldConfig.floors`: server-owned floor ids, display names, and exact `z` elevations.
- `welcome.worldConfig.structurePresets`: server-configured wall defaults exposed to World Builder.
- `welcome.structures`: canonical wall-run snapshot stored separately from items.
- `welcome.player`: server-assigned spawn/current self position at connect time.
- `welcome.serverInfo`: server process identity/version metadata:
  - `instanceId`: unique id generated at server startup
  - `releaseVersion`: shared public release version
  - `serverVersion`: server diagnostics version text (`release + server revision`)
  - `expectedClientRevision`: browser asset revision required by this server instance
  - `gridName`: server-owned user-facing grid name
  - `welcomeMessage`: server-owned pre-login welcome string
- `welcome.uiDefinitions`: server-provided item UI definitions:
  - `itemTypeOrder`: add-item menu order
  - `itemTypes[].tooltip`: item-level tooltip/help text
  - `itemTypes[].capabilities`: server-declared actions supported by the type
  - `itemTypes[].editableProperties`: editable property keys by item type
  - `itemTypes[].propertyMetadata`: property-level metadata (`valueType`, optional `label`, optional `range`, optional `tooltip`, optional `maxLength`, optional `options`, optional `visibleWhen`)
  - `itemTypes[].globalProperties`: non-editable global values (`useSound`, `emitSound`, `useCooldownMs`, `emitRange`, `directional`, `emitSoundSpeed`, `emitSoundTempo`, `emitInitialDelay`, `emitLoopDelay`)
  - `commandMetadata.mainModeActions`: server-authored labels/tooltips for server-backed main-mode commands used by the client command palette
  - `itemManagement.actions`: server-authored labels/tooltips and permission-key metadata for item-management actions (`transfer`, `hand`, `delete`)
  - `adminMenu.actions`: server-authored admin root menu labels/tooltips/ordering for the authenticated user
- Maintainer note: the current server-owned command/menu metadata definitions live in `server/app/ui_metadata.py`.
- Client item UI requires this metadata from the server; there is no fallback item definition map.
- Client property help/type rendering is metadata-driven; it does not infer fallback types/tooltips from hardcoded key heuristics.
- `visibleWhen` supports equality checks and string negation via `!` prefix (example: `{"mediaEffect": "!off"}`).

## Validation Boundaries

- Server is authoritative for all action validation and normalization.
- Server is authoritative for movement acceptance (bounds + wall crossing + rate/delta checks) and rejects client attempts to change `z`. `facingDeg` uses eight clockwise headings: `0` north (`+y`), `45` northeast, `90` east (`+x`), `135` southeast, `180` south, `225` southwest, `270` west, and `315` northwest. Validated turn packets change facing; ordinary movement, blocked movement, teleports, and elevator travel preserve the previous heading.
- Cardinal movement is blocked by a wall on its crossed edge. Diagonal movement is blocked when both possible two-step routes around the shared corner contain a blocking wall.
- Acoustic rays distinguish wall endpoints from interior joints: grazing an actual run endpoint contributes half-strength gain/filtering, while a continuing wall or two-wall corner contributes fully.
- Structure mutations require `world.structure.edit`, which defaults to the built-in `editor` and `admin` roles.
- Server persists account state (last nickname + last position + facing) and restores spawn and facing from that state on auth login/resume.
- Server also supports websocket handshake cookie resume:
  - accepts browser sockets only when websocket `Origin` matches `CHGRID_HOST_ORIGIN`
  - websocket and auth helper routes are scoped under the configured `server.base_path`
  - reads the instance-scoped session cookie from the websocket `Cookie` header
  - attempts resume before sending `auth_required`
  - exposes `GET <base_path>auth/session/clear` to expire the `HttpOnly` cookie (`X-Chgrid-Auth-Client: 1` and matching `Origin` required)
- Server applies auth hardening before accepting login/register/resume:
  - login/register PBKDF2 work runs off the event loop in bounded worker concurrency
  - Authentication failures are limited to 8 per identity at an IP and 20 in total at that IP in a 30-second window. Separate accounts may be online at the same address. Successful sign-ins do not consume these budgets.
  - Authentication logs and throttling use the same client address. Native loopback proxies can forward the nearest client address. For a public Compose installation, configure the upstream proxy as described in the [Docker guide](../deploy/docker/README.md#client-addresses-behind-a-host-proxy).
  - auth failures include small randomized response jitter to reduce high-resolution probing
- Server rate-limits each connection in fixed windows configured under `[rate_limits]`:
  - `chat_message`: default 5 per 5 seconds, including chat commands. Extra messages are not broadcast; the sender gets one system `chat_message`: "You are sending messages too quickly. Please wait a moment."
  - `item_piano_note`: default 40 note-ons per second. Extra notes are dropped without a reply. A note-off that releases a key the sender is holding always passes, so listeners are not left with stuck notes; a note-off for a key the server never started is dropped.
  - Platform property edits use `item_updates` (default 60 per second). Platform creation and deletion use `item_changes` (default 10 per 10 seconds). Rejections return a failed `platform_action_result` with the request ID.
  - `item_add` and `item_delete` share one budget, default 10 per 10 seconds. `item_update` has its own budget, default 60 per second, because property editing sends one update per arrow-key press. Extra requests get a failed `item_action_result` for that action: "You are changing items too quickly. Please wait a moment."
- `item_add` is rejected with a failed `item_action_result` once the user owns `items.max_items_per_user` items (default `500`, counted by `createdBy`). `item_transfer` is rejected when the target account does not exist or already owns that many.
- Client validates incoming packet shapes and applies runtime behavior.
- Server is authoritative for role/permission checks on every privileged packet.
- `voice.send` permission changes are pushed at runtime via `auth_permissions`.
- LiveKit token publish permission is derived from `voice.send`; Chat Grid remains authoritative for all account and world permissions.
- Sound/media field normalization uses shared server policy helpers:
  - `none/off` normalize to empty values
  - bare filenames normalize to `sounds/<name>` for sound-reference fields
  - media URL-like fields are trimmed/validated consistently
  - radio stream metadata fetches only follow validated public `http`/`https` URLs and revalidate redirect hops
- Client-side item edit validation is convenience only; server remains source of truth.

## Heartbeat/Stale Recovery

- Client sends automatic heartbeat `ping` packets every 10 seconds while connected.
- Heartbeat pings use negative `clientSentAt` ids and are internal (not user-visible ping status).
- If websocket close is observed unexpectedly, client starts reconnect flow.
- Two consecutive heartbeat intervals without a `pong` start reconnect flow; a received pong resets the counter.
- Reconnect flow makes up to 8 attempts before stopping. The delay before attempt n is min(30 s, 5 s × 2^(n-1)) with ±20% jitter (about 5, 10, 20, then 30 seconds; roughly 3 minutes in total), and each retry message states the next delay. Returning to a visible tab brings a waiting retry forward; disconnect, logout, and manual Connect cancel recovery.
- After reconnect, if `welcome.serverInfo.instanceId` changed, client announces `Server restarted.`
- Client emits `Connected to server. Version <version>.` on initial `welcome` and
  `Reconnected to server. Version <version>.` after reconnect.
- If `auth_required.expectedClientRevision` or `welcome.serverInfo.expectedClientRevision` differs from the running client revision, client auto-reloads.
- Server-only version changes do not trigger browser reload unless `expectedClientRevision` also changes.

## Ambiance regions

- `welcome.ambiances` contains server-owned inclusive rectangles: `id`, `name`, `soundId`, `floorZ`, `startX`, `startY`, `endX`, `endY`, `volume`, `fadeDistance`.
- `welcome.worldConfig.ambianceTypes` contains the server-discovered `{id, title, url}` sound catalog.
- `ambiance_add` creates a default one-square region at the caller's position; its name is Ambiance, the first configured sound is selected, volume is 25, and Fade distance is 5.
- `ambiance_update` carries `ambianceId` and optional `name`, `soundId`, `volume`, and `fadeDistance`. Type selection does not reset the other properties.
- `ambiance_resize` carries `ambianceId`, `edge` (`west`, `east`, `south`, `north`), and `delta` (-1 or 1). `ambiance_slide` carries `ambianceId`, `axis` (`x`, `y`), and `delta` (-1 or 1). These are atomic server-relative edits.
- `ambiance_delete` carries `ambianceId`.
- Every mutation requires `world.structure.edit`. Bounds, minimum area, sound selection, and numeric/name validation are server-owned. Overlap is allowed.
- Accepted mutations broadcast `ambiance_upsert` with the complete `ambiance`, or `ambiance_remove` with `ambianceId`, before sending the caller `ambiance_action_result` (`ok`, `action`, `message`, optional `ambianceId`).

## Wall doors

A wall carries its doors as offsets from the run start. Welcome and structure upserts include public door state, configuration and revisions. The server persists private lock verification data with the structures dataset. Public packets omit credential material.

Clients request explicit add, edit, remove, open, close, lock and unlock operations with `door_action`. The server validates the wall, edge, player position, permissions and current state. A `door_action_result` can prompt the caller for an exclusive keypad session. Each digit is sent privately as `keypad_digit`; cancellation uses `keypad_cancel`. The server owns both the keypad inactivity limit and any automatic relock deadline. Enabling keypad mode arms the lock as part of the same server update. Unlocking changes lock state independently of movement and closing. A door movement sound carries the wall orientation so listeners on either side hear it at the doorway; intervening walls still affect transmission. Use ordinary structure upserts to update crossing, rendering and acoustic state for everyone.


### Manual world checkpoints

A client sends `checkpoint_action` with `capture`, `list`, `preview`, or `restore`. The server checks the caller's permissions and returns a private `checkpoint_result`. Listings and previews expose summary counts and warnings. Restore requires both view and restore permissions, the checkpoint ID, and the world revision from preview. The server rejects a stale comparison and returns a refreshed preview.

After durable publication, `world_restored` replaces each connected client's items, structures (including doors), ambiances, and regions using the public welcome representation. Position updates reconcile affected players. Door PIN verification data and recorded song data stay server-side.
