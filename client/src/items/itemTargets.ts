import { itemOccupiesPosition, type GameState, type WorldItem } from '../state/gameState';
import { getCarriedItems } from './carriedItems';

/**
 * Returns items available for an interaction at the player's position.
 *
 * The local player's carried items are always available, even when their
 * stored world coordinates are stale. Floor items are available when their
 * footprint occupies the player's current cell. Items carried by another
 * player are not interaction targets.
 */
export function getInteractionItems(
  items: Iterable<WorldItem>,
  player: Pick<GameState['player'], 'id' | 'x' | 'y' | 'z'>,
): WorldItem[] {
  const allItems = Array.from(items);
  const interactionItems: WorldItem[] = [];
  const seenItemIds = new Set<string>();

  for (const item of getCarriedItems(allItems, player.id)) {
    if (seenItemIds.has(item.id)) continue;
    seenItemIds.add(item.id);
    interactionItems.push(item);
  }

  for (const item of allItems) {
    if (item.carrierId !== null && item.carrierId !== undefined) continue;
    if (seenItemIds.has(item.id)) continue;
    if (!itemOccupiesPosition(item, player.x, player.y, player.z)) continue;
    seenItemIds.add(item.id);
    interactionItems.push(item);
  }

  return interactionItems;
}
