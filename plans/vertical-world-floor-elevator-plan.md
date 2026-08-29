# Vertical World, Floors, and Elevator Plan

Date: 2026-08-29

## Agreed Behavior

* Add integer `z` to every world-space position that currently contains `x` and `y`.
* The ground floor is at `z = 0`; the second floor is at `z = 40`.
* Sound never crosses between floors.
* The item list, item selection, interaction, rendering, and nearby-item commands only use the player's current floor.
* The user list contains users on every floor and identifies each user's floor, for example `0, 12, 40, Ground floor`.
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

Ordinary items are anchored to one floor. A carried item uses its carrier's current position and height. An elevator is the exception: one item exposes the same anchor square on both configured floors.

## Visibility, Lists, and Teleporting

* Keep all connected users in client state so the user list remains global.
* Include floor name in user-list entries, location descriptions, and inspection output.
* Render only users and items on the current floor.
* The item list and every item candidate search filter by current floor before distance sorting.
* Enter on a user from another floor does not teleport; report that the user is on a different floor.
* The server also rejects any cross-floor teleport request. Client filtering is usability, not authority and of course a user could move while in that menu so server is the final call.
* Item pickup, drop, use, transfer, and same-square checks compare `x`, `y`, and floor. General wall and collision rules are deferred.

## Audio Rules

* Every positional sound source and listener carries `z`. Add a separate floor id with jumping or flying.
* Before distance or pan calculations, require matching acoustic floors. A different floor always produces silence, regardless of hearing range.
* LiveKit remains one room so the global user list and connection lifecycle stay simple. The client unsubscribes from other-floor audio publications, which saves voice bandwidth without disconnecting from the shared room.
* Radio, emitted item audio, footsteps, teleport sounds, item-use sounds, clocks, and piano audio follow the same floor gate.
* While the elevator is traveling, its interior is an isolated acoustic zone. Riders hear other riders in the car but do not hear either floor. On arrival, they join the destination floor's audio only after the door opens. The elevator will take 5 seconds to go to the next floor after the door closes.

## Multi-Square Objects

The implemented item model supports a server-owned footprint on each placeable definition:

```text
anchor: { x, y, z }
occupiedOffsets: \[{ x: 0, y: 0 }, { x: 1, y: 0 }, ...]
```

The item remains one entity with one id. The server uses offsets for occupancy, placement bounds, and interaction. The client uses them for rendering and nearest-item location. Rotation, overlap policy, and collision are deferred. Existing item types, including the elevator, currently use the one-cell footprint `\[{0, 0}]`.

The elevator is an assembly, not duplicated floor items:

* One single-square shaft anchor shared by both floors.
* One car state with `currentZ`, `targetZ`, queued destination, door state, occupants, and timers.
* The elevator item itself is the use/call target at its anchor square on either floor. There are no separate landing-control items.
* The shaft's anchor square is reserved on both floors even though the car is present at only one elevation.

This footprint model is also useful for tables, stages, large instruments, and vehicles. Walls should still use a separate edge-based geometry model later; footprints are not a replacement for walls.

Detailed plans for walls, doors, jumping, flying, collision, sound occlusion, and future multi-square items are in `plans/world-expansion-plan.md`.

## Elevator Interaction

Implemented two-floor behavior:

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

### Phase 1: Vertical Coordinate Foundation - Complete

* Add `z` to Python and TypeScript world models. Add stable floor ids later with jumping or flying.
* Update every world-space packet and helper that carries `x/y`.
* Add both floor definitions to server configuration/welcome data.
* Persist player and item floor/height; default existing records to the ground floor during loading.
* Make normal movement preserve `z` and reject client attempts to change floors.
* Update protocol and persistence tests together.

### Phase 2: Floor-Aware Client and Rules - Complete

* Render the current floor only.
* Filter item lists, selection, interaction, and nearest-item logic by floor.
* Keep the user list global, announce floor names, and block cross-floor teleporting on client and server.
* Apply the hard same-floor gate to every audio domain, including LiveKit voice.
* Clean up audio runtimes immediately on a floor change and rebuild them for the destination floor.

### Phase 3: Generic Footprints - Complete

* Add occupied offsets to item definitions and outbound UI metadata.
* Centralize occupied-cell calculation on the server.
* Use it for placement bounds, interaction, rendering, and locating. Item stacking keeps the grid's existing behavior; wall and collision rules remain a separate future feature.
* Keep one-cell behavior as the default for existing item types.

### Phase 4: Elevator Assembly - Complete Except Motor And Door Sounds

* Add the elevator type, single-square shaft shared by both landings, independent car state machine, and persisted resting state.
* Add call, enter, travel, arrive, door-open, exit, and timeout actions.
* Move riders and carried items authoritatively with the car.
* Broadcast explicit elevator state packets so sounds and UI do not infer state from messages.
* Play a spatial next-direction cue whenever the door opens and send the rider a destination announcement on arrival.
* Add elevator motor, door movement, and door-closing sounds later, after those assets are supplied.

## Verification Coverage

* Protocol schemas reject missing/invalid `z` after the clean cut.
* Horizontal movement cannot alter floor or height.
* Same `x/y` on different floors does not count as collision, interaction, or pickup range.
* Client item and user searches filter by floor as designed.
* Cross-floor height changes are rejected by the server.
* Positional audio paths gate on `z`; LiveKit also unsubscribes other-floor publications before download.
* A footprint reserves every occupied cell but appears as one item.
* Multiple elevator objects operate independently.
* Calls queue correctly while moving.
* The car cannot be entered from a floor where it is absent.
* Door timing resets appropriately and closes after five seconds.
* Riders and carried items arrive together at the destination.

## Current Delivery Status

Shipped on `main`:

* Floor/elevator implementation: commit `f4ec622`.
* Elevator changed to one square: commit `3c1dc53`.
* Current versions: client `R377`, server `S373`.
* Ground floor is `z=0`; second floor is `z=40`.
* Multiple independent elevator items are allowed. Each appears at one anchor coordinate on both floors, while its car remains at one completed landing or an intermediate travel height.
* Door-open delay is five seconds. Travel is five seconds after the door closes.
* Server restart clears unfinished elevator timers and restores a closed, idle car at its last completed landing.
* A mid-trip disconnect restores the rider and carried item to the last completed landing rather than persisting the intermediate height.
* Rider coordinates progress through intermediate `z` heights during the five-second trip instead of remaining at one midpoint.
* Elevators expose the standard emitted-sound controls, including direction and facing. This remains a normal object emitter and is not cabin audio; an inside rider hears it normally while the door is open, but not while the door is closed.
* Secondary use reports the car's landing and door state, or its destination and direction while traveling.
* Arrival opens the destination door automatically and announces the floor. Every door opening plays the spatial cue for the next trip's direction.
* A rider remains inside if the arrival door closes before they exit. One use at a stopped floor opens the door and exits the rider.

Deferred:

* Elevator motor, door movement, and door-closing sounds. The user will provide assets later.
* Stable floor ids, jumping, flying, and other intermediate-height movement.
* Walls, doors, collision, sound dampening, and item overlap policy.
* Actual multi-square item types. The generic footprint model is ready, but the elevator and current catalog remain one square.
* More than two elevator destinations and an in-car destination menu.
