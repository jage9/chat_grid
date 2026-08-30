# Reusable 3D Audio Plan

Date: 2026-08-29

## Goal

Extend the current floor-gated positional audio into reusable three-dimensional audio without weakening floor isolation. Elevators, stairs, jumping, flying, moving platforms, vehicles, walls, and doors should share audio primitives rather than each implementing a separate spatial model.

This plan complements `plans/world-expansion-plan.md`, which owns wall geometry, doors, movement, and collision.

## Core Model

Each continuous or one-shot world source should expose:

```text
audioSource: {
  position: { x, y, z },
  acousticZoneId,
  range,
  attachmentId?,
  sourceMode: world | interior
}
```

* `z` is physical height and participates in distance.
* `acousticZoneId` identifies a floor, room, elevator cabin, stairwell, or airspace. It must not be inferred by rounding `z`.
* `attachmentId` lets a generic source follow a player, item, elevator car, or other moving entity.
* `sourceMode=interior` allows occupants to hear a source at its intended cabin/room level while external listeners receive the transmitted spatial mix.

## Mixing Order

For every positional audio domain, apply the same ordered pipeline:

1. Determine whether source and listener zones are connected.
2. Compute horizontal and vertical distance with a configurable vertical scale.
3. Apply distance gain and pan using one shared spatial-source helper.
4. Trace intervening wall and door edges from the walls plan and multiply their `soundTransmission` values.
5. Apply any zone-opening transmission, such as an open elevator door or stairwell connection.
6. Optionally add low-pass filtering later; the first implementation should remain gain-only.

Ordinary floors remain disconnected by default. Cross-zone sound exists only through an explicit opening or transition area, so adding 3D distance does not make every floor audible to every other floor.

## Ownership

* The server owns source position, attachment, acoustic-zone membership, wall/door geometry, openings, and authoritative movement.
* The client interpolates moving sources and performs fast gain, pan, transmission, and optional filtering.
* Per-feature runtimes, such as the elevator state machine, provide state to the shared audio-source layer but do not implement their own distance or wall algorithms.
* LiveKit floor/zone subscriptions remain a coarse bandwidth gate. Rapid wall, door, and distance changes should affect local mixing rather than repeatedly subscribing and unsubscribing tracks.

## Delivery Phases

1. Extract one reusable dynamic spatial-source runtime supporting `x/y/z`, attachment, interpolation, and interior listeners.
2. Use elevator travel as the first integration: publish car height even when empty, keep cabin audio full for passengers, and fade an exterior travel source away from and toward landings.
3. Add stable acoustic-zone ids before stairs, jumping, or flying. Model stairwells as explicit connections between floor zones, not as globally open floors.
4. Implement gain-only wall and door transmission using the canonical edge geometry in `plans/world-expansion-plan.md`.
5. Route voice, item emitters, radio, footsteps, clocks, piano, and one-shot world sounds through the same zone/distance/occlusion calculation.
6. Add material-based filters, reflections, and richer room effects only after the shared gain model is verified.

## Verification

* Vertical distance fades a moving source smoothly without allowing unrelated cross-floor sound.
* An empty elevator car remains an authoritative moving source.
* Passengers hear cabin audio consistently while landing listeners hear only transmitted exterior audio.
* Opening and closing a door changes transmission without restarting continuous playback.
* Walls affect every positional audio domain consistently.
* Stairs connect only their intended adjacent zones.
* Late joiners receive enough authoritative state to place moving sources correctly.

## Open Decisions

* Vertical-distance scale relative to horizontal grid squares.
* Whether elevator movement uses the cabin ambience externally or receives a separate motor/travel asset.
* Initial stairwell transmission and how it changes along the stairs.
* Whether room materials initially affect gain only or also select a low-pass preset.
