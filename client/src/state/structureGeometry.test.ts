import { describe, expect, it } from 'vitest';
import type { WallStructure } from './gameState';
import {
  adjacentWallDescriptions,
  blockingWallForMove,
  wallContainsEdge,
  wallTransmissionBetween,
  wallAcousticMixBetween,
  wallsCrossedForMove,
} from './structureGeometry';

function wall(overrides: Partial<WallStructure> = {}): WallStructure {
  return {
    id: 'wall-1',
    floorZ: 0,
    startX: 2,
    startY: 3,
    orientation: 'horizontal',
    length: 3,
    title: 'Wall',
    movementBlocked: true,
    soundTransmission: 0,
    occlusionLowpassHz: 800,
    height: 40,
    preset: 'brick',
    contactSound: '/sounds/wall.ogg',
    ...overrides,
  };
}

describe('wall structure geometry', () => {
  it('expands a wall run into its covered edges', () => {
    const run = wall();
    expect(wallContainsEdge(run, 'horizontal', 2, 3)).toBe(true);
    expect(wallContainsEdge(run, 'horizontal', 4, 3)).toBe(true);
    expect(wallContainsEdge(run, 'horizontal', 5, 3)).toBe(false);
  });

  it('blocks cardinal crossings', () => {
    const north = wall({ startX: 4, startY: 5, length: 1 });
    expect(blockingWallForMove([north], 4, 4, 0, 4, 5)).toBe(north);
    expect(blockingWallForMove([north], 4, 4, 40, 4, 5)).toBeNull();
  });

  it('allows a diagonal past one blocked component but not two', () => {
    const north = wall({ id: 'north', startX: 4, startY: 5, length: 1 });
    const east = wall({ id: 'east', startX: 5, startY: 4, orientation: 'vertical', length: 1 });
    expect(blockingWallForMove([north], 4, 4, 0, 5, 5)).toBeNull();
    expect(blockingWallForMove([north, east], 4, 4, 0, 5, 5)).not.toBeNull();
  });

  it('reports a passable wall crossing without blocking movement', () => {
    const curtain = wall({ movementBlocked: false, startX: 5, startY: 4, orientation: 'vertical', length: 1 });
    expect(wallsCrossedForMove([curtain], 4, 4, 0, 5, 4)).toEqual([curtain]);
    expect(blockingWallForMove([curtain], 4, 4, 0, 5, 4)).toBeNull();
  });

  it('describes walls bordering a cell for accessible inspection', () => {
    const north = wall({ id: 'north', startX: 4, startY: 5, length: 1 });
    const east = wall({ id: 'east', title: 'Curtain', startX: 5, startY: 4, orientation: 'vertical', length: 1 });
    expect(adjacentWallDescriptions([north, east], 4, 4, 0)).toEqual(['Wall north', 'Curtain east']);
  });

  it('multiplies every transmission crossed by an audio ray', () => {
    const first = wall({ id: 'first', startX: 1, startY: 1, orientation: 'vertical', soundTransmission: 0.5 });
    const second = wall({ id: 'second', startX: 3, startY: 1, orientation: 'vertical', soundTransmission: 0.25 });
    expect(wallTransmissionBetween([first, second], { x: 0, y: 1, z: 0 }, { x: 4, y: 1, z: 0 })).toBe(0.125);
  });

  it('tapers an actual wall endpoint but fully blocks a closed corner', () => {
    const north = wall({ id: 'north', startX: 4, startY: 5, length: 1, soundTransmission: 0 });
    const east = wall({ id: 'east', startX: 5, startY: 4, orientation: 'vertical', length: 1, soundTransmission: 0.5 });
    const listener = { x: 4, y: 4, z: 0 };
    const source = { x: 5, y: 5, z: 0 };
    expect(wallAcousticMixBetween([north], listener, source)).toEqual({ gain: 0.5, lowpassHz: 4000 });
    expect(wallTransmissionBetween([north, east], listener, source)).toBe(0);
  });

  it('fully occludes an exact corner where the wall continues', () => {
    const run = wall({ startX: 4, startY: 5, length: 2, soundTransmission: 0 });
    expect(wallTransmissionBetween([run], { x: 4, y: 4, z: 0 }, { x: 5, y: 5, z: 0 })).toBe(0);
  });

  it('multiplies gain and uses the lowest crossed low-pass cutoff', () => {
    const glass = wall({ id: 'glass', startX: 1, startY: 1, orientation: 'vertical', soundTransmission: 0.65, occlusionLowpassHz: 7000 });
    const curtain = wall({ id: 'curtain', startX: 3, startY: 1, orientation: 'vertical', soundTransmission: 0.5, occlusionLowpassHz: 2200 });
    expect(wallAcousticMixBetween([glass, curtain], { x: 0, y: 1, z: 0 }, { x: 4, y: 1, z: 0 }))
      .toEqual({ gain: 0.325, lowpassHz: 2200 });
  });
});
