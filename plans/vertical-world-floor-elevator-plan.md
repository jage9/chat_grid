# Vertical World, Floors, and Elevator Plan

Date: 2026-08-29

## Agreed Behavior

- Add integer `z` to every world-space position that currently contains `x` and `y`.
- The ground floor is at `z = 0`; the second floor is at `z = 40`.
- Sound never crosses between floors.
- The item list, item selection, interaction, rendering, and nearby-item commands only use the player's current floor.
- The user list contains users on every floor and identifies each user's floor.
- Teleporting to a user is allowed only when that user is on the current floor.
- Initially, ordinary player and item positions use `z = 0` or `z = 40`. Intermediate heights are reserved for server-controlled elevator travel and later jumping/flying.
- There is one elevator. Its car can exist at only one height at a time.

## Core Model

### Position

Use one shared world-position shape everywhere:

```text
{ x: integer, y: integer, z: integer }
```

This applies to players, peers, items, movement, teleport completion, item drops, spatial sound packets, piano events, radio listeners, clocks, and any helper that accepts a world position. Screen pixels, UI coordinates, and other non-world `x/y` values do not gain `z`.

The server remains authoritative. Normal movement packets include the player's current `z`, but cannot change it. Only a server-approved transition such as an elevator, and later jumping or flying, can change `z`.

### Floors

The server supplies floor definitions in `worldConfig`:

```text
ground: name "Ground floor", elevation 0
second: name "Second floor", elevation 40
```

Floor membership must not be calculated by simply rounding `z`. A player jumping above the ground still belongs to the ground floor. Track a stable floor id alongside the numeric height when a player can be between elevations. For the first floor-only phase, floor id and elevation always agree.

Items are anchored to one floor. A carried item uses its carrier's current position and floor.

## Visibility, Lists, and Teleporting

- Keep all connected users in client state so the user list remains global.
- Include floor name in user-list entries, location descriptions, and inspection output.
- Render only users and items on the current floor.
- The item list and every item candidate search filter by current floor before distance sorting.
- Enter on a user from another floor does not teleport; report that the user is on a different floor.
- The server also rejects any cross-floor teleport request. Client filtering is usability, not authority.
- Item pickup, drop, use, transfer, collision, and same-square checks compare `x`, `y`, and floor.

## Audio Rules

- Every positional sound source and listener carries `z` and floor id.
- Before distance or pan calculations, require matching acoustic floors. A different floor always produces silence, regardless of hearing range.
- LiveKit can remain one room so the global user list and connection lifecycle stay simple. The client disconnects or mutes the audio graph for participants on other floors.
- Radio, emitted item audio, footsteps, teleport sounds, item-use sounds, clocks, and piano audio follow the same floor gate.
- While the elevator is traveling, its interior is an isolated acoustic zone. Riders hear other riders in the car but do not hear either floor. On arrival, they join the destination floor's audio only after the door opens.

## Multi-Square Objects

Do not create one persisted item per occupied square. Add an optional server-owned footprint to placeable definitions:

```text
anchor: { x, y, z }
occupiedOffsets: [{ x: 0, y: 0 }, { x: 1, y: 0 }, ...]
```

The item remains one entity with one id. The server expands the offsets for occupancy, collision, placement validation, interaction range, and rendering. Rotation can transform offsets later. Ordinary items keep the implicit one-cell footprint `[{0, 0}]`.

The elevator is an assembly, not duplicated floor items:

- One shaft anchor and footprint shared by both floors.
- One car state with `currentZ`, `targetZ`, direction, door state, occupants, and timers.
- One linked landing control on each floor. Landing controls may be lightweight child fixtures of the elevator rather than independent persisted items.
- The shaft footprint is reserved on both floors even though the car is present at only one elevation.

This footprint model is also useful for tables, stages, large instruments, and vehicles. Walls should still use a separate edge-based geometry model later; footprints are not a replacement for walls.

## Elevator Interaction

Recommended two-floor behavior:

1. Use the landing control to call the elevator.
2. The car travels to that floor and opens its door.
3. Use the control again while the door is open to enter the car.
4. The door remains open for five seconds from the most recent entry/arrival, then closes.
5. With only two floors, entering selects the other floor automatically. The car travels after the door closes.
6. At the destination the door opens; use exits to the landing.
7. A closed door can be reopened when the car is already at that landing.

All state changes and five-second timers are server-owned. Multiple calls are serialized. A call made while the elevator is moving is queued. Initially the elevator should reject pickup, carrying, deletion, or creation of a second elevator.

The automatic other-floor destination is the simplest accessible behavior for two floors. If more floors are added, replace it with a destination menu inside the car without changing the elevator state model.

## Implementation Phases

### Phase 1: Vertical Coordinate Foundation

- Add `z` and floor id to Python and TypeScript world models.
- Update every world-space packet and helper that carries `x/y`.
- Add both floor definitions to server configuration/welcome data.
- Persist player and item floor/height; default existing records to the ground floor during loading.
- Make normal movement preserve `z` and reject client attempts to change floors.
- Update protocol and persistence tests together.

### Phase 2: Floor-Aware Client and Rules

- Render the current floor only.
- Filter item lists, selection, interaction, and nearest-item logic by floor.
- Keep the user list global, announce floor names, and block cross-floor teleporting on client and server.
- Apply the hard same-floor gate to every audio domain, including LiveKit voice.
- Clean up audio runtimes immediately on a floor change and rebuild them for the destination floor.

### Phase 3: Generic Footprints

- Add occupied offsets to item definitions and outbound UI metadata.
- Centralize occupied-cell calculation on the server.
- Use it for placement validation, overlap/collision, interaction, rendering, and locating.
- Keep one-cell behavior as the default for existing item types.

### Phase 4: Elevator Assembly

- Add the unique elevator type, shaft footprint, two landing controls, car state machine, and persisted resting state.
- Add call, enter, travel, arrive, door-open, exit, and timeout actions.
- Move riders and carried items authoritatively with the car.
- Broadcast explicit elevator state packets so sounds and UI do not infer state from messages.
- Add elevator motor, arrival, and door sounds with correct acoustic-zone behavior.

## Important Tests

- Protocol schemas reject missing/invalid `z` after the clean cut.
- Horizontal movement cannot alter floor or height.
- Same `x/y` on different floors does not count as collision, interaction, or pickup range.
- Items and audio from the other floor never enter current-floor results.
- User list includes both floors; cross-floor teleport is rejected by the server.
- Every positional audio path is silent across floors.
- A footprint reserves every occupied cell but appears as one item.
- Only one elevator can exist.
- Calls queue correctly while moving.
- The car cannot be entered from a floor where it is absent.
- Door timing resets appropriately and closes after five seconds.
- Riders and carried items arrive together at the destination.

## Recommended Delivery Boundary

Complete and deploy Phases 1 and 2 before implementing footprints or the elevator. This gives a usable two-floor world and verifies that movement, lists, persistence, and all audio obey floor boundaries. The elevator can then be built on a stable vertical model rather than defining the model indirectly.
