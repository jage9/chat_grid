# Audio Architecture

## Audio Domains

- Voice: remote LiveKit audio tracks. Chat Grid supplies player positions and applies the positional mix.
- Media: radio station streams. External HTTP(S) radio URLs use the authenticated
  same-origin media proxy so browser CORS and mixed-content restrictions do not
  limit playable stations.
- Item: looping item emit sounds (`emitSound`).
- World: one-shot spatial world events from others (movement/teleport and item-use spatial sounds).
- UI: interface tones and status cues (not layer-controlled).

## Layer Toggles

Runtime toggles in normal mode:

- `1`: voice
- `2`: item
- `3`: media
- `4`: world

Persisted in local storage key `chatGridAudioLayers`.

## Layer Off Behavior

Layer off prefers unsubscribe/cleanup instead of only muting:

- Voice: remote peer audio graph is detached; resumes by reattaching stored remote streams.
- Media: `RadioStationRuntime.cleanupAll()` and no sync/update processing until re-enabled.
- Item: `ItemEmitRuntime.cleanupAll()` and no sync/update processing until re-enabled.
- World: world one-shots are not played while disabled.

## Item Sound Model

- `useSound`: one-shot played on successful `item_use` (`item_use_sound` packet).
- `emitSound`: continuous looping spatial source attached to an item runtime.

Current defaults:

- `radio_station`: `useSound=none`, `emitSound=none`
- `dice`: `useSound=sounds/roll.ogg`, `emitSound=none`
- `wheel`: `useSound=sounds/spin.ogg`, `emitSound=none`
- `clock`: `useSound=none`, `emitSound=sounds/clock.ogg`

`emitSound` uses a base gain multiplier of `0.3` before spatial attenuation.

## Spatialization

- Distance attenuation uses hearing radius from game state.
- Stereo panning follows horizontal offset.
- Mono output mode collapses pan to center.

## Stale Stream Mitigation

Radio stream startup appends a cache-busting query token on runtime creation to avoid stale buffered playback after reconnect/layer re-enable.
