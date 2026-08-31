import type { WallStructure } from './gameState';

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

function blockingWallAt(
  structures: Iterable<WallStructure>,
  floorZ: number,
  orientation: WallStructure['orientation'],
  lineX: number,
  lineY: number,
): WallStructure | null {
  for (const wall of structures) {
    if (
      wall.floorZ === floorZ
      && wall.movementBlocked
      && wallContainsEdge(wall, orientation, lineX, lineY)
    ) {
      return wall;
    }
  }
  return null;
}

/** Resolve movement collision using the shared cardinal/diagonal corner rule. */
export function blockingWallForMove(
  structures: Iterable<WallStructure>,
  x: number,
  y: number,
  floorZ: number,
  nextX: number,
  nextY: number,
): WallStructure | null {
  const dx = nextX - x;
  const dy = nextY - y;
  const crossed: WallStructure[] = [];
  if (dx !== 0) {
    const wall = blockingWallAt(structures, floorZ, 'vertical', x + (dx > 0 ? 1 : 0), y);
    if (wall) crossed.push(wall);
  }
  if (dy !== 0) {
    const wall = blockingWallAt(structures, floorZ, 'horizontal', x, y + (dy > 0 ? 1 : 0));
    if (wall) crossed.push(wall);
  }
  if (dx !== 0 && dy !== 0) return crossed.length === 2 ? crossed[0] : null;
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
