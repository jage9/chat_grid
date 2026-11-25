import { getNearestItemPosition, hasItemBounds, type WorldItem } from '../state/gameState';

export type WorldItemSourcePosition = {
  x: number;
  y: number;
  z: number;
};

/** Resolve the nearest emitting point for a point item, bounded item, or multi-stop shaft. */
export function resolveWorldItemSourcePosition(
  item: WorldItem,
  listenerZ: number,
  listenerX?: number,
  listenerY?: number,
): WorldItemSourcePosition {
  const floorZs = item.params.floorZs;
  const servedFloorZs = Array.isArray(floorZs)
    ? floorZs.map(Number).filter(Number.isFinite)
    : [];
  const sourceZ = servedFloorZs.length > 0
    ? servedFloorZs.reduce((nearest, floorZ) => Math.abs(floorZ - listenerZ) < Math.abs(nearest - listenerZ) ? floorZ : nearest)
    : Math.max(item.z, Math.min(item.endZ ?? item.z, listenerZ));
  const position = hasItemBounds(item) && listenerX !== undefined && listenerY !== undefined
    ? getNearestItemPosition(item, listenerX, listenerY)
    : { x: item.x, y: item.y };
  return { ...position, z: sourceZ };
}

/** Use the playback source position to decide whether a listener is within preload range. */
export function itemInListenerRange(item: WorldItem, listener: WorldItemSourcePosition, range: number): boolean {
  const source = resolveWorldItemSourcePosition(item, listener.z, listener.x, listener.y);
  return Math.hypot(source.x - listener.x, source.y - listener.y, source.z - listener.z) <= range;
}
