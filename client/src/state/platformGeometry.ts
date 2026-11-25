export type Platform = {
  id: string;
  name: string;
  z: number;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  footstepSet?: string;
};

export type FootstepSet = { id: string; title: string; urls: string[] };

/** Older servers describe their full-square floors by elevation and grid size. */
export function legacyPlatforms(size: number, floors = [
  { id: 'ground', name: 'Ground floor', z: 0 },
  { id: 'second-floor', name: 'Second floor', z: 40 },
]): Platform[] {
  return floors.map((floor) => ({ ...floor, startX: 0, startY: 0, endX: size - 1, endY: size - 1 }));
}

export function platformAt(platforms: ReadonlyMap<string, Platform>, x: number, y: number, z: number): Platform | undefined {
  for (const platform of platforms.values()) {
    if (z === platform.z && x >= platform.startX && x <= platform.endX && y >= platform.startY && y <= platform.endY) return platform;
  }
  return undefined;
}

/** Time a list teleport and identify trips that can publish intermediate walking positions. */
export function listTeleportTravel(
  platforms: ReadonlyMap<string, Platform>,
  from: { x: number; y: number; z: number },
  toX: number,
  toY: number,
) {
  const destination = platformAt(platforms, toX, toY, from.z);
  if (!destination) return undefined;
  const distance = Math.hypot(toX - from.x, toY - from.y);
  const squaresPerSecond = 20;
  return {
    durationMs: Math.min(3000, Math.max(1, distance / squaresPerSecond * 1000)),
    syncIntermediatePositions: platformAt(platforms, from.x, from.y, from.z)?.id === destination.id,
  };
}

export function canWalkTo(platforms: ReadonlyMap<string, Platform>, x: number, y: number, z: number, toX: number, toY: number): boolean {
  if (Math.abs(toX - x) > 1 || Math.abs(toY - y) > 1 || !platformAt(platforms, toX, toY, z)) return false;
  return x === toX || y === toY || Boolean(platformAt(platforms, x, toY, z) && platformAt(platforms, toX, y, z));
}

/** Closest playable cell within an inclusive rectangle, even when it spans a gap. */
export function nearestLanding(platforms: ReadonlyMap<string, Platform>, bounds: Pick<Platform, 'startX' | 'startY' | 'endX' | 'endY'>, z: number, x: number, y: number) {
  let nearest: { x: number; y: number } | undefined;
  let shortest = Infinity;
  for (const platform of platforms.values()) {
    if (platform.z !== z) continue;
    const minX = Math.max(platform.startX, bounds.startX);
    const maxX = Math.min(platform.endX, bounds.endX);
    const minY = Math.max(platform.startY, bounds.startY);
    const maxY = Math.min(platform.endY, bounds.endY);
    if (minX > maxX || minY > maxY) continue;
    const landingX = Math.max(minX, Math.min(maxX, Math.round(x)));
    const landingY = Math.max(minY, Math.min(maxY, Math.round(y)));
    const distance = Math.hypot(landingX - x, landingY - y);
    if (distance < shortest) {
      shortest = distance;
      nearest = { x: landingX, y: landingY };
    }
  }
  return nearest;
}
