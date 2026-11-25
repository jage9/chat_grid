import type { GameState } from './gameState';
import { platformAt } from './platformGeometry';
import { containingRegions } from './regions';

/** Formats a coordinate with up to 2 decimals while trimming trailing zeros. */
export function formatCoordinate(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return value.toFixed(2).replace(/\.?0+$/, '');
}

/** Speak the most specific named places first after the coordinates. */
export function formatLocationReadout(
  state: Pick<GameState, 'platforms' | 'regions'>,
  position: { x: number; y: number; z: number },
): string {
  const { x, y, z } = position;
  const parts = [x, y, z].map(formatCoordinate);
  for (const region of containingRegions(state.regions.values(), position)) parts.push(region.name);
  const platform = platformAt(state.platforms, x, y, z);
  if (platform) parts.push(platform.name);
  return parts.join(', ');
}
