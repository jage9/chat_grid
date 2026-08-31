# World Builder And Structures

World Builder edits server-authoritative world geometry separately from runtime items. The first structure type is a wall run. Doors and authored platforms remain later work.

## Wall Runs

A wall lives on grid edges and does not consume either neighboring cell. One editable wall has a floor elevation, start grid line, horizontal or vertical orientation, positive length, title, movement rule, sound-transmission value, height, preset id, and collision sound.

The server expands each run into canonical unit edges for collision checks. Overlapping edges and runs outside the rectangular world bounds are rejected. Resizing changes one endpoint of the complete run; editing only a middle portion requires splitting/replacing the wall in a later workflow.

Cardinal movement is rejected when its crossed edge has a movement-blocking wall. For a diagonal, the server checks the horizontal and vertical component edges from the origin and rejects the move only when both are blocked. The client predicts the same rule, while server acceptance remains authoritative.

## Presets

Wall presets are configured under `world.structure_presets` in `server/config.toml`. The shipped defaults are:

- `solid`: title `Wall`, height `40`, sound transmission `0`, movement blocked, collision sound `/sounds/wall.ogg`.
- `curtain`: title `Curtain`, height `40`, sound transmission `0.5`, movement blocked, collision sound `/sounds/wall.ogg`.

Preset values are copied into each wall when it is created. Later preset edits therefore do not silently rewrite existing structures. Height is stored for future geometry but does not change ordinary floor movement while jumping and flying are deferred. Sound transmission is also stored now; gain-only sound occlusion is the next separate implementation phase.

## Persistence And Authorization

Structures persist in `structures.json` beside the configured item state file. They are included in the initial welcome snapshot and broadcast as full upserts/removals when edited live.

The `world.structure.edit` permission gates every server mutation and World Builder visibility. It is granted by default to the built-in `editor` and `admin` roles. `W` opens World Builder, and the same menu flow is available through touch controls and the command palette.

All users can press `C` to hear walls bordering their current square, including each wall's title and direction.
