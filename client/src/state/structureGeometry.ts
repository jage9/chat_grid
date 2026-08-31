import type { WallStructure } from './gameState';

export type WallEdgeIndex = ReadonlyMap<string, WallStructure>;
export type WallAcousticMix = { gain: number; lowpassHz: number };
export const OPEN_AIR_LOWPASS_HZ = 20_000;

function edgeKey(
  floorZ: number,
  orientation: WallStructure['orientation'],
  lineX: number,
  lineY: number,
): string {
  return `${floorZ}:${orientation}:${lineX}:${lineY}`;
}

/** Build a constant-time lookup index for every unit edge in wall runs. */
export function buildWallEdgeIndex(structures: Iterable<WallStructure>): WallEdgeIndex {
  const index = new Map<string, WallStructure>();
  for (const wall of structures) {
    for (let offset = 0; offset < wall.length; offset += 1) {
      const lineX = wall.startX + (wall.orientation === 'horizontal' ? offset : 0);
      const lineY = wall.startY + (wall.orientation === 'vertical' ? offset : 0);
      index.set(edgeKey(wall.floorZ, wall.orientation, lineX, lineY), wall);
    }
  }
  return index;
}

/** Return whether one wall run contains a canonical unit edge. */
export function wallContainsEdge(
  wall: WallStructure,
  orientation: WallStructure['orientation'],
  lineX: number,
  lineY: number,
): boolean {
  if (wall.orientation !== orientation) return false;
  if (orientation === 'horizontal') {
    return wall.startY === lineY && lineX >= wall.startX && lineX < wall.startX + wall.length;
  }
  return wall.startX === lineX && lineY >= wall.startY && lineY < wall.startY + wall.length;
}

function wallAt(
  index: WallEdgeIndex,
  floorZ: number,
  orientation: WallStructure['orientation'],
  lineX: number,
  lineY: number,
): WallStructure | null {
  return index.get(edgeKey(floorZ, orientation, lineX, lineY)) ?? null;
}

/** Multiply transmission for every wall edge crossed by a center-to-center ray. */
export function wallAcousticMixBetween(
  structures: Iterable<WallStructure>,
  listener: { x: number; y: number; z: number },
  source: { x: number; y: number; z: number },
  existingIndex?: WallEdgeIndex,
): WallAcousticMix {
  if (listener.z !== source.z) return { gain: 1, lowpassHz: OPEN_AIR_LOWPASS_HZ };
  const index = existingIndex ?? buildWallEdgeIndex(structures);
  const listenerX = Math.round(listener.x);
  const listenerY = Math.round(listener.y);
  const sourceX = Math.round(source.x);
  const sourceY = Math.round(source.y);
  const deltaX = sourceX - listenerX;
  const deltaY = sourceY - listenerY;
  if (deltaX === 0 && deltaY === 0) return { gain: 1, lowpassHz: OPEN_AIR_LOWPASS_HZ };

  const stepX = Math.sign(deltaX);
  const stepY = Math.sign(deltaY);
  const deltaTX = deltaX === 0 ? Number.POSITIVE_INFINITY : 1 / Math.abs(deltaX);
  const deltaTY = deltaY === 0 ? Number.POSITIVE_INFINITY : 1 / Math.abs(deltaY);
  let nextTX = deltaTX / 2;
  let nextTY = deltaTY / 2;
  let cellX = listenerX;
  let cellY = listenerY;
  let transmission = 1;
  let lowpassHz = OPEN_AIR_LOWPASS_HZ;

  const applyWall = (wall: WallStructure | null): void => {
    if (!wall) return;
    transmission *= Math.max(0, Math.min(1, wall.soundTransmission));
    const cutoff = Number.isFinite(wall.occlusionLowpassHz) ? wall.occlusionLowpassHz : OPEN_AIR_LOWPASS_HZ;
    lowpassHz = Math.min(lowpassHz, Math.max(20, Math.min(OPEN_AIR_LOWPASS_HZ, cutoff)));
  };

  while (cellX !== sourceX || cellY !== sourceY) {
    const crossesCorner = Math.abs(nextTX - nextTY) < 1e-10;
    if (!crossesCorner && nextTX < nextTY) {
      applyWall(wallAt(index, listener.z, 'vertical', cellX + (stepX > 0 ? 1 : 0), cellY));
      cellX += stepX;
      nextTX += deltaTX;
    } else if (!crossesCorner && nextTY < nextTX) {
      applyWall(wallAt(index, listener.z, 'horizontal', cellX, cellY + (stepY > 0 ? 1 : 0)));
      cellY += stepY;
      nextTY += deltaTY;
    } else {
      const vertical = wallAt(index, listener.z, 'vertical', cellX + (stepX > 0 ? 1 : 0), cellY);
      const horizontal = wallAt(index, listener.z, 'horizontal', cellX, cellY + (stepY > 0 ? 1 : 0));
      // Acoustic rays count every touched edge. This intentionally differs
      // from the permissive diagonal movement rule at wall corners.
      applyWall(vertical);
      applyWall(horizontal);
      cellX += stepX;
      cellY += stepY;
      nextTX += deltaTX;
      nextTY += deltaTY;
    }
    if (transmission <= 0) return { gain: 0, lowpassHz };
  }
  return { gain: transmission, lowpassHz };
}

/** Return only wall gain for callers that do not render filtering. */
export function wallTransmissionBetween(
  structures: Iterable<WallStructure>,
  listener: { x: number; y: number; z: number },
  source: { x: number; y: number; z: number },
  existingIndex?: WallEdgeIndex,
): number {
  return wallAcousticMixBetween(structures, listener, source, existingIndex).gain;
}

/** Resolve movement collision using the shared cardinal/diagonal corner rule. */
export function wallsCrossedForMove(
  structures: Iterable<WallStructure>,
  x: number,
  y: number,
  floorZ: number,
  nextX: number,
  nextY: number,
  existingIndex?: WallEdgeIndex,
): WallStructure[] {
  const index = existingIndex ?? buildWallEdgeIndex(structures);
  const dx = nextX - x;
  const dy = nextY - y;
  const crossed: WallStructure[] = [];
  if (dx !== 0) {
    const wall = wallAt(index, floorZ, 'vertical', x + (dx > 0 ? 1 : 0), y);
    if (wall) crossed.push(wall);
  }
  if (dy !== 0) {
    const wall = wallAt(index, floorZ, 'horizontal', x, y + (dy > 0 ? 1 : 0));
    if (wall) crossed.push(wall);
  }
  return crossed;
}

/** Resolve movement collision using the shared cardinal/diagonal corner rule. */
export function blockingWallForMove(
  structures: Iterable<WallStructure>,
  x: number,
  y: number,
  floorZ: number,
  nextX: number,
  nextY: number,
  existingIndex?: WallEdgeIndex,
): WallStructure | null {
  const crossed = wallsCrossedForMove(structures, x, y, floorZ, nextX, nextY, existingIndex)
    .filter((wall) => wall.movementBlocked);
  const diagonal = nextX !== x && nextY !== y;
  if (diagonal) return crossed.length === 2 ? crossed[0] : null;
  return crossed[0] ?? null;
}

/** Return walls on the current floor ordered by distance from a cell. */
export function nearbyWalls(
  structures: Iterable<WallStructure>,
  x: number,
  y: number,
  floorZ: number,
): WallStructure[] {
  return Array.from(structures)
    .filter((wall) => wall.floorZ === floorZ)
    .sort((left, right) => wallDistance(left, x, y) - wallDistance(right, x, y));
}

/** Describe structures on the four edges surrounding one cell. */
export function adjacentWallDescriptions(
  structures: Iterable<WallStructure>,
  x: number,
  y: number,
  floorZ: number,
): string[] {
  const walls = Array.from(structures).filter((wall) => wall.floorZ === floorZ);
  const edges: Array<[string, WallStructure['orientation'], number, number]> = [
    ['north', 'horizontal', x, y + 1],
    ['south', 'horizontal', x, y],
    ['east', 'vertical', x + 1, y],
    ['west', 'vertical', x, y],
  ];
  return edges.flatMap(([direction, orientation, lineX, lineY]) => {
    const wall = walls.find((candidate) => wallContainsEdge(candidate, orientation, lineX, lineY));
    return wall ? [`${wall.title} ${direction}`] : [];
  });
}

function wallDistance(wall: WallStructure, x: number, y: number): number {
  const endX = wall.startX + (wall.orientation === 'horizontal' ? wall.length : 0);
  const endY = wall.startY + (wall.orientation === 'vertical' ? wall.length : 0);
  const centerX = (wall.startX + endX) / 2;
  const centerY = (wall.startY + endY) / 2;
  return Math.hypot(centerX - (x + 0.5), centerY - (y + 0.5));
}
