# Protocol Notes

This is a behavior guide for packet semantics beyond raw schemas.

## Direction

- Client packet schema lives in `server/app/models.py` (`ClientPacket`).
- Browser-side validation/parsing lives in `client/src/network/protocol.ts`.
- Keep these synchronized on every protocol change.

## Client -> Server

- `update_position`: authoritative player position update.
- `update_nickname`: nickname change request (server enforces uniqueness).
- `chat_message`: player chat.
- `ping`: latency measurement.
- `item_add`, `item_pickup`, `item_drop`, `item_delete`, `item_use`, `item_update`: item actions.
- `item_piano_note`: realtime piano note on/off for active piano use mode.

## Server -> Client

- `welcome`: initial snapshot with users/items plus server UI/world metadata.
- `signal`: forwarded WebRTC offer/answer/ICE.
- `update_position`, `update_nickname`, `user_left`: presence updates.
- `chat_message`: system and user chat stream.
- `pong`: ping response.
- `nickname_result`: accepted/rejected nickname result.
- `item_upsert`: full item replacement after mutation.
- `item_remove`: item deletion.
- `item_action_result`: action success/failure and user-facing message.
- `item_use_sound`: spatial one-shot sound on successful item use (if `useSound` configured).
- `item_piano_note`: broadcast piano note on/off with resolved instrument/envelope/spatial params.

## Item Packet Behavior

- `item_upsert` is full-state replacement for one item, not partial patch.
- `item_action_result` messages are intended for direct screen-reader/user status feedback.
- `item_use_sound` contains absolute item world coordinates (`x`, `y`) and sound path.
- `item_piano_note` contains:
  - `itemId`, `senderId`, `keyId`, `midi`, `on`
  - resolved `instrument`, `attack`, `decay`, `emitRange`
  - absolute source coordinates `x`, `y`

## Welcome Metadata

- `welcome.worldConfig.gridSize`: server-authoritative grid size used by clients for bounds/drawing.
- `welcome.serverInfo`: server process identity/version metadata:
  - `instanceId`: unique id generated at server startup
  - `version`: server package version (or `unknown` fallback)
- `welcome.uiDefinitions`: server-provided item UI definitions:
  - `itemTypeOrder`: add-item menu order
  - `itemTypes[].tooltip`: item-level tooltip/help text
  - `itemTypes[].editableProperties`: editable property keys by item type
  - `itemTypes[].propertyOptions`: menu options for property keys (for example clock `timeZone`)
  - `itemTypes[].propertyMetadata`: property-level metadata (`valueType`, optional `range`, optional `tooltip`)
  - `itemTypes[].globalProperties`: non-editable global values (`useSound`, `emitSound`, `useCooldownMs`, `emitRange`, `directional`, `emitSoundSpeed`, `emitSoundTempo`)

- Clients keep local fallback defaults but should prefer server-provided metadata when present.

## Validation Boundaries

- Server is authoritative for all action validation and normalization.
- Client validates incoming packet shapes and applies runtime behavior.
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
- If `welcome.serverInfo.version` differs from running client version, client auto-reloads.
