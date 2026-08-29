# World Expansion Plan

Date: 2026-08-29

This plan covers world features beyond the completed floor and elevator work. The shipped floor/elevator behavior remains documented in `plans/vertical-world-floor-elevator-plan.md`.

## Current Foundation

Already implemented on `main`:

* Every world position has integer `x`, `y`, and `z`.
* Ground floor is `z=0`; second floor is `z=40`.
* Ordinary movement cannot change `z`; elevators are the only floor transition.
* Rendering, item lists, item interaction, teleporting, and positional audio are floor-aware.
* The user list remains global. Item lists remain local to the current floor.
* Item definitions support server-owned footprints, although every current item is one square.
* World rules and validation remain server-authoritative.

## Agreed Future Direction

* Add jumping and flying without replacing the existing `x`, `y`, `z` model.
* Add walls that can block movement and block or dampen sound.
* Add doors later as openings in walls, not as unrelated objects sitting in a square.
* Keep walls separate from the item-footprint model. Items occupy cells; walls and doors live on the edges between cells.
* Preserve the server-first architecture. The browser may predict movement and mix audio, but the server owns canonical geometry and validates crossings.

## Height And Floor Identity

Numeric height and floor membership become separate concepts when jumping or flying is added:

```text
position: { x, y, z, floorId }
```

* `z` is physical height.
* `floorId` is the stable visibility and acoustic area.
* A player jumping from the ground can have `z>0` while remaining on `floorId="ground"`.
* An elevator in transit belongs to an isolated elevator acoustic area, not either landing.
* A server-approved landing changes `floorId`; ordinary client movement cannot forge it.

Do not infer `floorId` by rounding `z`. That would make jumps near `z=40` accidentally become second-floor users.

## Jumping

Recommended first implementation:

* Jump is a server-approved temporary vertical state attached to the current floor.
* The server owns start time, initial vertical speed, gravity, maximum height, and landing.
* Horizontal movement may continue during a jump only if the normal edge/collision checks pass.
* Jumping does not bypass a full-height wall unless the wall explicitly allows it.
* The client interpolates the arc for smooth presentation but accepts server corrections.
* Positional audio remains in the current floor acoustic area. Optional vertical attenuation can be added later.

Jump pads or flying items should request the same shared server movement system rather than implement their own coordinate changes.

## Flying

Flying needs an explicit server-owned movement mode:

```text
movementMode: walking | jumping | flying | elevator
```

* Flying allows controlled `z` changes within configured bounds.
* Permissions come from the user, role, item, or world rule that granted flight.
* The server validates vertical speed, horizontal speed, ceiling, floor, and restricted areas.
* Landing returns the player to a stable floor identity.
* Visibility and audio rules for high-altitude users should be configured deliberately; do not silently assign them to the nearest floor.

Exact controls and whether ordinary users may fly remain product decisions.

## Wall Geometry

Walls should be edge geometry, not ordinary item types. A wall separates two neighboring cells without consuming either cell.

Store each segment once using a canonical edge:

```text
wallSegment: {
  id,
  floorId,
  orientation: horizontal | vertical,
  lineX,
  lineY,
  movementBlocked: true,
  soundTransmission: 0.0,
  material: solid
}
```

Grid-line coordinates store each boundary once, including the outside border. A vertical segment uses one `x` grid line and one `y` cell interval; a horizontal segment uses one `y` grid line and one `x` cell interval. UI references such as north/south/east/west normalize to this canonical segment.

Suggested behavior:

* `movementBlocked=true` prevents walking across that edge.
* `soundTransmission=0` fully blocks sound; `1` has no effect; values between dampen it.
* `material` provides readable labels and later sound/filter defaults. It should not replace explicit numeric behavior.
* Wall height can be added when jumping/flying needs to cross over low barriers.
* Several segments may share a structure/group id for editing a complete wall as one operation.

The server validates wall placement, ownership, permissions, world bounds, and duplicate edges.

## Doors

A door is a stateful opening attached to one wall edge:

```text
door: {
  id,
  wallSegmentId,
  state: open | closed,
  locked: false,
  closedSoundTransmission: 0.15,
  openSoundTransmission: 1.0
}
```

* Closed doors normally block movement and dampen or block sound.
* Open doors permit movement and use their open sound value.
* Use works from either cell adjacent to the door edge.
* Open/close/lock state is server-owned and broadcast explicitly.
* Automatic doors, keys, permissions, and timed closing can build on the same entity later.
* A door must not exist without a valid wall edge or doorway record.

## Movement And Collision

Movement validation changes from destination-cell-only checks to edge crossing checks:

1. Validate movement speed and bounds as today.
2. Determine every cell edge crossed by the move.
3. Reject the move if a closed wall or door blocks any crossed edge.
4. Apply height rules for jumping/flying.
5. Accept and broadcast the authoritative result.

Client prediction may use the same wall snapshot for responsiveness, but server rejection remains final.

Teleporting needs destination validation but does not need to trace every crossed wall unless a future teleport type explicitly requires line of sight.

## Sound Occlusion

Floor separation remains the first, cheapest gate. Wall processing happens only after source and listener are in the same acoustic area.

Recommended initial algorithm:

1. Trace a two-dimensional line from listener to source.
2. Find wall and closed-door edges crossed by that line.
3. Multiply their `soundTransmission` values.
4. Apply the result to the existing distance gain.
5. Treat a final gain near zero as inaudible.

Apply this consistently to LiveKit voice, radio, item emitters, footsteps, teleports, clocks, piano, and item-use sounds.

The server distributes canonical wall/door state. Each browser computes fast local audio mixes because voice and continuous sources already update there. Do not unsubscribe LiveKit tracks merely because a wall currently blocks them; doors and positions can change quickly. Floor remains the reliable LiveKit bandwidth gate. Distance currently affects gain, and distance-based LiveKit subscription would need a separate hysteresis design before it could become a bandwidth gate.

A low-pass filter for muffled sound can follow later. The first version should use gain only so behavior is predictable and testable.

## Rendering And Accessible Output

* Render walls as lines on cell edges for the current floor only.
* Render doors as part of their wall edge with visibly different open/closed states.
* Coordinate and inspection commands should identify nearby walls/doors and their direction relative to the current square.
* Movement rejection should report a wall or closed door without exposing internal ids.
* Wall/door editing needs keyboard and touch workflows; do not require pointer-only placement.

## Multi-Square Items

The generic `occupiedOffsets` foundation is already present and should be used for future tables, stages, large instruments, and vehicles.

* One item remains one entity even when it occupies several cells.
* Footprints handle cell occupancy and interaction.
* Walls remain edge geometry and must not be represented as long, thin item footprints.
* Item overlap policy should be decided separately from movement collision. The grid currently permits stacking.

## Protocol And Persistence

Likely additions:

* Stable `floorId` on players, items, and positional event packets when jumping/flying begins.
* Server-owned wall and door snapshots in `welcome`.
* Incremental wall/door upsert, remove, and state packets.
* Server-approved movement-mode and vertical-state packets.
* Persisted wall/door geometry separate from ordinary item instances.

Keep client and server schemas synchronized. A clean protocol cut is acceptable during current development.

## Recommended Order

1. Add stable `floorId` before jumping or flying.
2. Add canonical wall-edge storage and server movement blocking.
3. Add current-floor wall rendering and accessible inspection.
4. Add gain-only wall sound occlusion for every positional audio domain.
5. Add doors using the same edge model.
6. Add shared server vertical movement for jumping.
7. Add flying only after height bounds, wall heights, ceilings, and acoustic-area rules are decided.
8. Add actual multi-square item types when a concrete object requires them.

## Open Decisions

* How users create and edit wall runs efficiently with keyboard and touch controls.
* Default wall materials and sound-transmission values.
* Whether walls have height from the first release or only when jumping is implemented.
* Whether flying users remain audible to a floor, enter a separate airspace, or use explicit zones.
* Whether teleport destinations may be enclosed by walls or require an accessible landing path.
* Door locking, permissions, automatic closing, and sound assets.
