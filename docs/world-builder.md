# World Builder And Structures

World Builder edits server-authoritative world geometry separately from runtime items. The first structure type is a wall run. Doors and authored platforms remain later work.

## Wall Runs

A wall lives on grid edges and does not consume either neighboring cell. Its canonical persisted geometry is a first unit-edge anchor (`startX`, `startY`, `floorZ`), horizontal or vertical orientation, and a positive unit-edge count (`length`). It also has a title, movement rule, sound-transmission value, height, preset id, and contact sound.

The server expands each run into canonical unit edges for collision checks. The editor reports the first and last occupied edge anchors inclusively: the last anchor is `start + length - 1` along the run axis, so a one-edge wall has matching start and end coordinates. This editor contract is deliberately distinct from the geometric boundary immediately after the final edge. Overlapping edges and runs outside the rectangular world bounds are rejected. Resizing changes one end of the complete run; editing only a middle portion requires splitting/replacing the wall in a later workflow.

Cardinal movement is rejected when its crossed edge has a movement-blocking wall. For a diagonal, the server considers both possible two-step routes around the shared corner and rejects the move when each route contains a blocking wall. This makes collision direction-independent while still allowing movement past a single wall endpoint. The client predicts the same rule, while server acceptance remains authoritative.

## Presets

Wall presets are configured under `world.structure_presets` in `server/config.toml`. The shipped defaults are:

- `brick`: title `Brick`, height `40`, sound transmission `0`, movement blocked, contact sound `/sounds/wall.ogg`.
- `curtain`: title `Curtain`, height `40`, sound transmission `0.5`, movement allowed, contact sound `/sounds/curtain.ogg`.
- `glass`: title `Glass`, height `40`, sound transmission `0.35`, movement blocked, contact sound `/sounds/glass.ogg`.
- `fence`: title `Fence`, height `40`, sound transmission `0.7`, movement blocked, contact sound `/sounds/fence.ogg`.

Preset values are copied into each wall when it is created. Later preset edits therefore do not silently rewrite existing structures. Height is stored for future geometry but does not change ordinary floor movement while jumping and flying are deferred.

For same-floor positional audio, the client traces the center-to-center listener/source ray and multiplies every crossed wall's sound transmission into distance gain. This covers voice, radios, item emitters, elevator landing audio, footsteps, teleports, clocks, piano, and positional item-use sounds. Standard and HRTF modes use the same wall gain and low-pass filtering; turning does not change which walls the source-to-listener ray crosses. Exact diagonal corner checks consider walls on both sides of the corner, without counting a continuous wall twice. Floor/acoustic-zone connectivity remains the LiveKit subscription gate; wall changes affect local gain without restarting or resubscribing continuous audio.

## Persistence And Authorization

Structures persist in `structures.json` beside the configured item state file. They are included in the initial welcome snapshot and broadcast as full upserts/removals when edited live.

The `world.structure.edit` permission gates every server mutation and World Builder visibility. It is granted by default to the built-in `editor` and `admin` roles. `W` opens World Builder, and the same menu flow is available through touch controls and the command palette.

Adding a wall selects its preset and the north, south, east, or west edge of the builder's current square, then opens that new wall in the same editor used for existing walls. Side is only a creation concept; orientation, inclusive start/end anchors, and perpendicular slide controls fully describe later placement. Type is a top-level wall action, while the properties submenu contains the detailed acoustic fields.

All users can press `C` to hear walls bordering their current square, including each wall's title and direction.

Hitting a blocking wall or crossing a passable wall plays its `contactSound` immediately for the mover. The server validates the attempted move and broadcasts the same sound positionally to other nearby users through the world-audio layer.

## Ambiances

`Add ambiance` and `Edit ambiances` follow the wall entries in World Builder and require the same `world.structure.edit` permission. Adding creates a one-square region at the builder's current position and opens its editor immediately. Both add and edit use the same menu, with Type first; there is no wall-side or orientation step.

Ambiances occupy inclusive rectangular areas on one floor. Each has a user-editable name, sound type, start/end X and Y coordinates, volume, and Fade distance. The default name is Ambiance, the default volume is 25 percent, and the default Fade distance is five squares. Regions may overlap and their loops play together. They do not block movement or occupy item slots.

The editor reuses list navigation, option selection, numeric controls, text entry, Space tooltips, and delete confirmation. Left/Right adjusts the selected edge or slides the whole region along the chosen axis. The server rejects resizing below one square or moving outside the grid. Volume and Fade distance can also be entered directly. Zero Fade distance makes the sound audible only inside the region.

Inside a region its sound is centered. Outside, the nearest point on the rectangle determines the sound direction; volume follows a strong squared fade to silence at the configured Fade distance. With the default five-square distance, one square outside plays at 64 percent of the configured volume, two squares at 36 percent, three squares at 16 percent, four squares at 4 percent, and five squares is silent. Gain and direction use the same 0.2-second smoothing as other positional sounds, including a fade to silence before an out-of-range loop is released. Ambiances use the World audio layer, master volume, shared standard/HRTF renderer, and wall/acoustic-zone transmission. The rectangles are lightly shaded on the visual grid.

The server discovers sound types from `client/public/sounds/ambiances/` at startup and sends their IDs, titles, and web URLs in the welcome catalog. The supplied types are City, Dark, Forest, Nighttime, Ocean, and Waterfall. Add supported audio files to that folder, deploy the client assets, and restart the server to expose new types; no client code list needs editing. Regions persist in `ambiances.json` beside the configured item state file. A missing sound file leaves the region editable but silent until a valid type is selected or the file is restored.
