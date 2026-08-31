# Audio Architecture

## Audio Domains

- Voice: remote LiveKit audio tracks. Chat Grid supplies player positions and applies the positional mix.
- Media: radio station streams. HTTPS streams play directly when possible. HTTP
  streams and Dropbox media use the authenticated same-origin proxy to avoid
  mixed-content and download-page restrictions.
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
- Every positional source and listener includes `z`. Different heights are silent before distance and pan are calculated.
- The ground floor is `z=0` and the second floor is `z=40`; sound never crosses between them.
- LiveKit remains one room, but the client unsubscribes from audio publications for users on other floors. This preserves the global roster without downloading unheard voice tracks.
- Elevator riders are published at progressively changing intermediate heights while the car moves, which keeps them unsubscribed from both floor audio groups.
- The dedicated client elevator runtime loops `/sounds/elevator_inside.ogg` from a randomized offset. A passenger hears it in every car state; a landing listener hears it spatially only when nearby on the same floor with the door fully open.
- An elevator's optional `emitSound` remains on the multi-floor shaft object rather than following the car, so it emits independently from both landings. A rider hears it through normal distance rules while the door is open; the client suppresses it only while that rider is inside with the door closed.
- Door opening and closing play their spatial clips for landing listeners and riders. Entry/exit remains blocked for each clip's duration. `/sounds/elevator_up.ogg` or `/sounds/elevator_down.ogg` starts alongside the opening clip so the direction beep adds no delay.
- On the same floor, the client traces a center-to-center ray through canonical wall edges and multiplies every crossed wall's `soundTransmission` into the existing distance gain.
- Solid walls use transmission `0`; curtains default to `0.5`. Multiple crossed walls multiply (for example, two curtains produce `0.25`).
- Wall gain applies to LiveKit voice, radios, item emitters, elevator landing audio, footsteps, teleports, clocks, piano notes, and positional item-use sounds. Active continuous and one-shot mixes update as the listener or wall layout changes.
- Wall occlusion never drives LiveKit subscription changes. Floor/acoustic-zone connectivity remains the stable bandwidth gate; walls are a fast local gain adjustment.
- A ray passing exactly through a grid corner follows diagonal movement semantics: one occupied component edge leaves an open route, while two occupied edges apply both transmissions.

## Stale Stream Mitigation

Radio stream startup appends a cache-busting query token on runtime creation to avoid stale buffered playback after reconnect/layer re-enable.
The media element sets anonymous CORS mode before assigning its stream URL so direct HTTPS playback initializes consistently across browsers.
If a browser leaves a stream-start request pending, the runtime resets that attempt after 15 seconds and resumes its bounded retry schedule.
Re-entering the audible range clears a retained source's retry cooldown and starts a fresh attempt.
