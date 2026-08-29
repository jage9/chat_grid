# Vertical World, Floors, and Elevator Plan

Date: 2026-08-29

## Agreed Behavior

* Add integer `z` to every world-space position that currently contains `x` and `y`.
* The ground floor is at `z = 0`; the second floor is at `z = 40`.
* Sound never crosses between floors.
* The item list, item selection, interaction, rendering, and nearby-item commands only use the player's current floor.
* The user list contains users on every floor and identifies each user's floor. I.E. 0,12,40, Ground floor
* Teleporting to a user is allowed only when that user is on the current floor.
* Initially, ordinary player and item positions use `z = 0` or `z = 40`. Intermediate heights are reserved for server-controlled elevator travel and later jumping/flying.
* Elevator is a new item type. Each elevator object owns one car, and that car can exist at only one height at a time. Multiple independent elevator objects are allowed.

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

Floor membership must not be calculated by simply rounding `z`. In this first floor-only phase, an exact landing height identifies the floor, and an elevator's intermediate travel height belongs to neither floor. Add a stable floor id when jumping or flying introduces intermediate heights that still belong to a landing.

Items are anchored to one floor. A carried item uses its carrier's current position and floor.

## Visibility, Lists, and Teleporting

* Keep all connected users in client state so the user list remains global.
* Include floor name in user-list entries, location descriptions, and inspection output.
* Render only users and items on the current floor.
* The item list and every item candidate search filter by current floor before distance sorting.
* Enter on a user from another floor does not teleport; report that the user is on a different floor.
* The server also rejects any cross-floor teleport request. Client filtering is usability, not authority and of course a user could move while in that menu so server is the final call.
* Item pickup, drop, use, transfer, collision, and same-square checks compare `x`, `y`, and floor.

## Audio Rules

* Every positional sound source and listener carries `z`. Add a separate floor id with jumping or flying.
* Before distance or pan calculations, require matching acoustic floors. A different floor always produces silence, regardless of hearing range.
* LiveKit remains one room so the global user list and connection lifecycle stay simple. The client unsubscribes from other-floor audio publications, which saves voice bandwidth without disconnecting from the shared room.
* Radio, emitted item audio, footsteps, teleport sounds, item-use sounds, clocks, and piano audio follow the same floor gate.
* While the elevator is traveling, its interior is an isolated acoustic zone. Riders hear other riders in the car but do not hear either floor. On arrival, they join the destination floor's audio only after the door opens. The elevator will take 5 seconds to go to the next floor after the door closes.

## Multi-Square Objects

Do not create one persisted item per occupied square. Add an optional server-owned footprint to placeable definitions:

```text
anchor: { x, y, z }
occupiedOffsets: \[{ x: 0, y: 0 }, { x: 1, y: 0 }, ...]
```

The item remains one entity with one id. The server expands the offsets for occupancy, collision, placement validation, interaction range, and rendering. Rotation can transform offsets later. Ordinary items keep the implicit one-cell footprint `\[{0, 0}]`.

The elevator is an assembly, not duplicated floor items:

* One single-square shaft anchor shared by both floors.
* One car state with `currentZ`, `targetZ`, direction, door state, occupants, and timers.
* One linked landing control on each floor. Landing controls may be lightweight child fixtures of the elevator rather than independent persisted items.
* The shaft's anchor square is reserved on both floors even though the car is present at only one elevation.

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

All state changes and five-second timers are server-owned. Multiple calls are serialized. A call made while the elevator is moving is queued. An elevator rejects pickup and carrying, and cannot be deleted while it is moving or occupied. Other independent elevators may be created.

The automatic other-floor destination is the simplest accessible behavior for two floors. If more floors are added, replace it with a destination menu inside the car without changing the elevator state model.

## Implementation Phases

### Phase 1: Vertical Coordinate Foundation

* Add `z` to Python and TypeScript world models. Add stable floor ids later with jumping or flying.
* Update every world-space packet and helper that carries `x/y`.
* Add both floor definitions to server configuration/welcome data.
* Persist player and item floor/height; default existing records to the ground floor during loading.
* Make normal movement preserve `z` and reject client attempts to change floors.
* Update protocol and persistence tests together.

### Phase 2: Floor-Aware Client and Rules

* Render the current floor only.
* Filter item lists, selection, interaction, and nearest-item logic by floor.
* Keep the user list global, announce floor names, and block cross-floor teleporting on client and server.
* Apply the hard same-floor gate to every audio domain, including LiveKit voice.
* Clean up audio runtimes immediately on a floor change and rebuild them for the destination floor.

### Phase 3: Generic Footprints

* Add occupied offsets to item definitions and outbound UI metadata.
* Centralize occupied-cell calculation on the server.
* Use it for placement bounds, interaction, rendering, and locating. Item stacking keeps the grid's existing behavior; wall and collision rules remain a separate future feature.
* Keep one-cell behavior as the default for existing item types.

### Phase 4: Elevator Assembly

* Add the elevator type, single-square shaft, two landing controls, independent car state machine, and persisted resting state.
* Add call, enter, travel, arrive, door-open, exit, and timeout actions.
* Move riders and carried items authoritatively with the car.
* Broadcast explicit elevator state packets so sounds and UI do not infer state from messages.
* Add elevator motor, arrival, and door sounds later, after the sound assets are supplied.

## Important Tests

* Protocol schemas reject missing/invalid `z` after the clean cut.
* Horizontal movement cannot alter floor or height.
* Same `x/y` on different floors does not count as collision, interaction, or pickup range.
* Items and audio from the other floor never enter current-floor results.
* User list includes both floors; cross-floor teleport is rejected by the server.
* Every positional audio path is silent across floors.
* A footprint reserves every occupied cell but appears as one item.
* Multiple elevator objects operate independently.
* Calls queue correctly while moving.
* The car cannot be entered from a floor where it is absent.
* Door timing resets appropriately and closes after five seconds.
* Riders and carried items arrive together at the destination.

## Current Delivery Status

Phases 1 through 4 are implemented together because the elevator is the only initial way to change floors. Elevator sound assets remain intentionally deferred. Stable floor ids also remain deferred until jumping or flying needs an intermediate `z` that still belongs to a floor.
