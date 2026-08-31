import { describe, expect, it } from 'vitest';
import type { WallStructure } from './gameState';
import { adjacentWallDescriptions, blockingWallForMove, wallContainsEdge } from './structureGeometry';

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
    height: 40,
    preset: 'solid',
    collisionSound: '/sounds/wall.ogg',
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

  it('describes walls bordering a cell for accessible inspection', () => {
    const north = wall({ id: 'north', startX: 4, startY: 5, length: 1 });
    const east = wall({ id: 'east', title: 'Curtain', startX: 5, startY: 4, orientation: 'vertical', length: 1 });
    expect(adjacentWallDescriptions([north, east], 4, 4, 0)).toEqual(['Wall north', 'Curtain east']);
  });
});
