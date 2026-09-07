import type { WorldItem } from '../state/gameState';

export type WorldItemSourcePosition = {
  x: number;
  y: number;
  z: number;
};

/**
 * Resolves the positional source for an item relative to one listener floor.
 *
 * Floor-aware items represent one source on every configured floor.  Their
 * acoustic routing follows the listener's connected landing, so their
 * vertical source coordinate must do the same.  Ordinary and carried items
 * use their current world coordinates, which the server keeps synchronized.
 */
export function resolveWorldItemSourcePosition(
  item: WorldItem,
  listenerZ: number,
): WorldItemSourcePosition {
  const floorZs = item.params.floorZs;
  const sourceZ = Array.isArray(floorZs) && floorZs.some((floorZ) => Number(floorZ) === listenerZ)
    ? listenerZ
    : item.z;
  return { x: item.x, y: item.y, z: sourceZ };
}
