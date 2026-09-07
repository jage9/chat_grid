import type { WorldItem } from '../state/gameState';

const titleListFormatter = new Intl.ListFormat('en', {
  style: 'long',
  type: 'conjunction',
});

function formatTitles(items: Iterable<WorldItem>): string {
  return titleListFormatter.format(Array.from(items, (item) => item.title));
}

/** Returns the items carried by the requested player in iteration order. */
export function getCarriedItems(items: Iterable<WorldItem>, carrierId: string | null): WorldItem[] {
  if (carrierId === null) return [];
  return Array.from(items).filter((item) => item.carrierId === carrierId);
}

/** Formats a carrying description for appending to a user's spoken or listed name. */
export function formatCarryingSuffix(items: Iterable<WorldItem>, carrierId: string | null): string {
  const carriedItems = getCarriedItems(items, carrierId);
  if (carriedItems.length === 0) return '';
  return `, carrying ${formatTitles(carriedItems)}`;
}

/** Describes the items carried by the local player. */
export function describeHeldItems(items: Iterable<WorldItem>, carrierId: string | null): string {
  const carriedItems = getCarriedItems(items, carrierId);
  if (carriedItems.length === 0) return 'You are holding nothing.';
  return `You are holding ${formatTitles(carriedItems)}.`;
}
