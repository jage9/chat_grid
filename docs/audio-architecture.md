# Audio Architecture

## Audio Domains

- Voice: remote LiveKit audio tracks. Chat Grid supplies player positions and applies the positional mix.
- Media: radio station streams. HTTPS streams play directly when possible. HTTP
  streams and Dropbox media use the authenticated same-origin proxy to avoid
  mixed-content and download-page restrictions.
- Item: looping item emit sounds (`emitSound`).
- World: one-shot spatial world events from others (footsteps, teleports, structure contact, item use, and clock speech).
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
- Every positional source and listener includes `x`, `y`, `z`, and a server-owned acoustic-zone id. Disconnected floors and closed elevator cabins are silent before distance and pan are calculated.
- The ground floor is `z=0` and the second floor is `z=40`; sound never crosses between them.
- LiveKit remains one room, but the client unsubscribes from audio publications for users on other floors. This preserves the global roster without downloading unheard voice tracks.
- Elevator riders are published at progressively changing intermediate heights while the car moves, which keeps them unsubscribed from both floor audio groups.
- The dedicated client elevator runtime loops `/sounds/elevator_inside.ogg` from a randomized offset. A passenger hears it in every car state; a nearby landing listener hears it through the opening/closing door transmission while the car is at that floor.
- An elevator's optional `emitSound` remains on the multi-floor shaft object rather than following the car, so it emits independently from both landings. A rider hears it through normal distance rules while the door is open; the client suppresses it only while that rider is inside with the door closed.
- Door opening and closing play their spatial clips for landing listeners and riders. Entry/exit remains blocked for each clip's duration. `/sounds/elevator_up.ogg` or `/sounds/elevator_down.ogg` starts alongside the opening clip so the direction beep adds no delay.
- Elevator direction and door-mechanism clips are anchored to the current landing's floor zone. Landing listeners hear them directly; cabin occupants hear them through the dynamic door transmission.
- On the same floor, the client traces a center-to-center ray through canonical wall edges and multiplies every crossed wall's `soundTransmission` into the existing distance gain.
- Solid walls use transmission `0`; curtains default to `0.5`. Multiple crossed walls multiply (for example, two curtains produce `0.25`).
- Wall gain applies to LiveKit voice, radios, item emitters, elevator landing audio, footsteps, teleports, clocks, piano notes, and positional item-use sounds. Active continuous and one-shot mixes update as the listener or wall layout changes.
- `WorldAudioRouter` is the single entry point for sampled world one-shots. It applies the world-layer toggle, acoustic-zone transmission, wall gain/filtering, range, distance, and pan for footsteps, teleports, structure contact, item-use sounds, and clock sequences.
- One-shot admission uses stable acoustic connectivity rather than requiring positive gain at the packet instant. Elevator ding and opening samples can therefore begin at zero transmission and fade in with the opening door, while closed or moving cabin/floor pairs remain rejected.
- One-shot packets carry the authoritative source acoustic-zone id. This keeps all floor sounds outside a closed or moving elevator cabin and fades them consistently with the door transition.
- Wall occlusion never drives LiveKit subscription changes. Floor/acoustic-zone connectivity remains the stable bandwidth gate; walls are a fast local gain adjustment.
- A ray passing exactly through a grid corner follows diagonal movement semantics: one occupied component edge leaves an open route, while two occupied edges apply both transmissions.
- Wall impacts and passable-structure crossings emit their configured `contactSound`. The mover receives immediate local feedback; other users receive a server-validated positional world sound that follows normal distance, floor, layer, and wall-occlusion rules.

## Stale Stream Mitigation

Radio stream startup appends a cache-busting query token on runtime creation to avoid stale buffered playback after reconnect/layer re-enable.
The media element sets anonymous CORS mode before assigning its stream URL so direct HTTPS playback initializes consistently across browsers.
If a browser leaves a stream-start request pending, the runtime resets that attempt after 15 seconds and resumes its bounded retry schedule.
Re-entering the audible range clears a retained source's retry cooldown and starts a fresh attempt.
