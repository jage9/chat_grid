import { describe, expect, it } from 'vitest';
import { canWalkTo, legacyPlatforms, listTeleportTravel, nearestLanding, platformAt } from './platformGeometry';

describe('flat platform geometry', () => {
  const [ground, upper] = legacyPlatforms(41);
  const bridge = { ...ground, id: 'bridge', startX: -4, endX: -1, startY: 1, endY: 1 };
  const island = { ...bridge, id: 'island', startX: -7, endX: -6 };
  const platforms = new Map([ground, upper, bridge, island].map((p) => [p.id, p]));

  it('walks through an edge across a negative coordinate and stops at a gap', () => {
    expect(canWalkTo(platforms, 0, 1, 0, -1, 1)).toBe(true);
    expect(canWalkTo(platforms, -4, 1, 0, -5, 1)).toBe(false);
    expect(canWalkTo(platforms, -4, 1, 0, -6, 1)).toBe(false);
    expect(platformAt(platforms, -1, 1, 40)).toBeUndefined();
  });

  it('times same-elevation list travel across a gap without publishing midair positions', () => {
    const start = { x: -4, y: 1, z: 0 };
    expect(listTeleportTravel(platforms, start, -6, 1)).toEqual({ durationMs: 100, syncIntermediatePositions: false });
    expect(listTeleportTravel(platforms, start, -2, 1)).toEqual({ durationMs: 100, syncIntermediatePositions: true });
    expect(listTeleportTravel(platforms, start, -5, 1)).toBeUndefined();
  });

  it('checks both sides of a diagonal step', () => {
    expect(canWalkTo(platforms, 1, 1, 0, 0, 0)).toBe(true);
    expect(canWalkTo(platforms, 0, 0, 0, -1, 1)).toBe(false);
  });

  it('finds a supported landing inside a tall widget on the current platform', () => {
    const bounds = { startX: -10, startY: 0, endX: -2, endY: 4 };
    expect(nearestLanding(platforms, bounds, 0, -8, 0)).toEqual({ x: -7, y: 1 });
    expect(nearestLanding(platforms, bounds, 40, -8, 0)).toBeUndefined();
  });
});
