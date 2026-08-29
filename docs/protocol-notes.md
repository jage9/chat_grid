# Protocol Notes

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
- `welcome_ready`: client confirms it accepted `welcome` preflight and is ready to join active roster.
- `admin_roles_list`: request server role list (with user counts + permission sets).
- `admin_role_create`: create role.
- `admin_role_update_permissions`: replace one role permission set.
- `admin_role_delete`: delete role with replacement role reassignment.
- `admin_users_list`: request user list for admin actions (`action`: `set_role | ban | unban | delete_account`).
- `admin_user_set_role`: set target user role.
- `admin_user_ban` / `admin_user_unban`: disable/enable user account.
- `admin_user_delete`: permanently delete target account.
- `update_position`: client movement intent with `x`, `y`, and `z`; server enforces bounds, rate policy, and an unchanged floor.
- `teleport_complete`: client signals an `x`, `y`, `z` teleport landing; server rejects direct floor changes and rebroadcasts the spatial cue.
- `update_nickname`: nickname change request (server enforces uniqueness).
- `chat_message`: player chat.
- `ping`: latency measurement.
- `item_add`, `item_pickup`, `item_drop`, `item_delete`, `item_use`, `item_update`: item actions.
- `item_transfer_targets`: request transfer target accounts for one item (includes online + offline active users, excluding current owner).
- `item_transfer`: transfer item ownership to another account (`targetUserId` required).
- `item_secondary_use`: trigger type-specific secondary action when implemented.
- `item_piano_note`: realtime piano note on/off for active piano use mode.
- `item_piano_recording`: piano record/playback control (`toggle_record`, `playback`, `stop_playback`).

## Server -> Client

- `auth_required`: authentication challenge after websocket connect.
  - includes `gridName`, `welcomeMessage`, `serverVersion`, and `expectedClientRevision`.
- `auth_result`: auth success/failure and session/account metadata.
- `auth_permissions`: server-pushed live role/permission refresh for current session.
- `admin_roles_list`: role list response payload.
- `admin_users_list`: user list response payload.
- `admin_action_result`: structured result for admin actions.
  - admin mutations include `user_delete` for account deletion.
- `welcome`: initial snapshot with users/items plus server UI/world metadata.
  - Server delays roster activation/login broadcast until `welcome_ready` is received.
- `livekit_token`: short-lived authenticated LiveKit room token and public WebSocket URL.
  - Issued only after authentication when complete LiveKit configuration is enabled.
  - The API secret is never sent to the browser.
- `update_position`, `update_nickname`, `user_left`: presence updates.
- `teleport_complete`: peer teleport landing event with spatial coordinates.
- `chat_message`: system and user chat stream.
- `pong`: ping response.
- `nickname_result`: accepted/rejected nickname result.
- `item_upsert`: full item replacement after mutation.
- `item_remove`: item deletion.
- `item_action_result`: action success/failure and user-facing message.
- `item_transfer_targets`: transfer target account list for one item.
- `item_use_sound`: spatial one-shot sound on successful item use (if `useSound` configured).
- `item_clock_announce`: ordered list of clock speech samples to play sequentially as spatial audio.
- `item_piano_note`: broadcast piano note on/off with resolved instrument/envelope/spatial params.
- `item_piano_status`: structured piano mode/record/playback state events for client runtime control.
- `item_elevator_status`: targeted rider state (`entered`, `moving`, `arrived`, or `exited`) with `itemId`, `z`, and an optional user-facing `message`.

## Item Packet Behavior

- `item_upsert` is full-state replacement for one item, not partial patch.
- `item_upsert.item.display` is server-owned display text for readonly/system properties (for example: `createdBy`, `updatedBy`, `createdAt`, `updatedAt`, `capabilities`, `useSound`, `emitSound`).
- `item_action_result` messages are intended for direct screen-reader/user status feedback.
  - `action` includes: `add`, `pickup`, `drop`, `delete`, `transfer`, `use`, `secondary_use`, `update`
- Successful `item_pickup` and `item_drop` also emit system chat lines to other users in the room.
- Item transfer ownership is account-based; target accounts do not need to be currently connected.
- Piano runtime control no longer depends on parsing `item_action_result.message` text.
- `item_piano_status` carries machine-readable piano events (`use_mode_entered`, record/playback transitions).
- `item_use_sound` contains absolute item world coordinates (`x`, `y`, `z`) and sound path.
  - For carried items, source coordinates resolve to the carrier's current position.
- `item_clock_announce` contains:
  - `itemId`
  - `sounds`: ordered sample URLs (EL640 phrase parts)
  - absolute source coordinates `x`, `y`, `z`
  - generated by server for manual clock `use`, top-of-hour auto announce, and alarm auto announce (when enabled)
- `teleport_complete` contains absolute player world coordinates (`x`, `y`, `z`) at teleport landing.
- Radio metadata (`params.stationName`, `params.nowPlaying`) is server-managed and delivered through normal `item_upsert` updates.
- `item_piano_note` contains:
  - `itemId`, `senderId`, `keyId`, `midi`, `on`
  - resolved `instrument`, `voiceMode`, `octave`, `attack`, `decay`, `release`, `brightness`, `emitRange`
  - absolute source coordinates `x`, `y`, `z`
- `item_upsert.item.occupiedOffsets` contains the server-owned horizontal footprint relative to the item anchor.
- Elevator travel uses an intermediate `update_position.z` so riders are outside both floor audio and visibility groups until arrival.
- Elevator arrival sends `item_use_sound` at the destination `z`, using the up or down cue that matches its direction.

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
- `welcome.worldConfig.gridSize`: server-authoritative grid size used by clients for bounds/drawing.
- `welcome.worldConfig.movementTickMs`: server movement-rate window used for client movement pacing.
- `welcome.worldConfig.movementMaxStepsPerTick`: max allowed grid steps per movement window.
- `welcome.worldConfig.floors`: server-owned floor ids, display names, and exact `z` elevations.
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
  - `itemManagement.actions`: server-authored labels/tooltips and permission-key metadata for item-management actions (`transfer`, `delete`)
  - `adminMenu.actions`: server-authored admin root menu labels/tooltips/ordering for the authenticated user
- Maintainer note: the current server-owned command/menu metadata definitions live in `server/app/ui_metadata.py`.
- Client item UI requires this metadata from the server; there is no fallback item definition map.
- Client property help/type rendering is metadata-driven; it does not infer fallback types/tooltips from hardcoded key heuristics.
- `visibleWhen` supports equality checks and string negation via `!` prefix (example: `{"mediaEffect": "!off"}`).

## Validation Boundaries

- Server is authoritative for all action validation and normalization.
- Server is authoritative for movement acceptance (bounds + rate/delta checks) and rejects client attempts to change `z`.
- Server persists account state (last nickname + last position) and restores spawn from that state on auth login/resume.
- Server also supports websocket handshake cookie resume:
  - accepts browser sockets only when websocket `Origin` matches `CHGRID_HOST_ORIGIN`
  - websocket and auth helper routes are scoped under the configured `server.base_path`
  - reads the instance-scoped session cookie from the websocket `Cookie` header
  - attempts resume before sending `auth_required`
  - exposes `GET <base_path>auth/session/clear` to expire the `HttpOnly` cookie (`X-Chgrid-Auth-Client: 1` and matching `Origin` required)
- Server applies auth hardening before accepting login/register/resume:
  - login/register PBKDF2 work runs off the event loop in bounded worker concurrency
  - repeated auth failures are rate-limited by IP and IP+identity windows
  - auth failures include small randomized response jitter to reduce high-resolution probing
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
- If a heartbeat `pong` is missed for one interval (10 seconds), client also starts reconnect flow.
- Reconnect flow waits 5 seconds and retries up to 3 times before stopping.
- After reconnect, if `welcome.serverInfo.instanceId` changed, client announces `Server restarted.`
- Client emits `Connected to server. Version <version>.` on initial `welcome` and
  `Reconnected to server. Version <version>.` after reconnect.
- If `auth_required.expectedClientRevision` or `welcome.serverInfo.expectedClientRevision` differs from the running client revision, client auto-reloads.
- Server-only version changes do not trigger browser reload unless `expectedClientRevision` also changes.
