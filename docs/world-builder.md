# World Builder And Structures

World Builder edits server-authoritative world geometry separately from runtime items. The first structure type is a wall run. Doors and authored platforms remain later work.

## Wall Runs

A wall lives on grid edges and does not consume either neighboring cell. One editable wall has a floor elevation, start grid line, horizontal or vertical orientation, positive length, title, movement rule, sound-transmission value, height, preset id, and contact sound.

The server expands each run into canonical unit edges for collision checks. Overlapping edges and runs outside the rectangular world bounds are rejected. Resizing changes one endpoint of the complete run; editing only a middle portion requires splitting/replacing the wall in a later workflow.

Cardinal movement is rejected when its crossed edge has a movement-blocking wall. For a diagonal, the server checks the horizontal and vertical component edges from the origin and rejects the move only when both are blocked. The client predicts the same rule, while server acceptance remains authoritative.

## Presets

Wall presets are configured under `world.structure_presets` in `server/config.toml`. The shipped defaults are:

- `solid`: title `Wall`, height `40`, sound transmission `0`, movement blocked, contact sound `/sounds/wall.ogg`.
- `curtain`: title `Curtain`, height `40`, sound transmission `0.5`, movement allowed, contact sound `/sounds/wall.ogg`.

Preset values are copied into each wall when it is created. Later preset edits therefore do not silently rewrite existing structures. Height is stored for future geometry but does not change ordinary floor movement while jumping and flying are deferred.

For same-floor positional audio, the client traces the center-to-center listener/source ray and multiplies every crossed wall's sound transmission into distance gain. This covers voice, radios, item emitters, elevator landing audio, footsteps, teleports, clocks, piano, and positional item-use sounds. Floor/acoustic-zone connectivity remains the LiveKit subscription gate; wall changes affect local gain without restarting or resubscribing continuous audio.

## Persistence And Authorization

Structures persist in `structures.json` beside the configured item state file. They are included in the initial welcome snapshot and broadcast as full upserts/removals when edited live.

The `world.structure.edit` permission gates every server mutation and World Builder visibility. It is granted by default to the built-in `editor` and `admin` roles. `W` opens World Builder, and the same menu flow is available through touch controls and the command palette.

All users can press `C` to hear walls bordering their current square, including each wall's title and direction.

Hitting a blocking wall or crossing a passable wall plays its `contactSound` immediately for the mover. The server validates the attempted move and broadcasts the same sound positionally to other nearby users through the world-audio layer.
