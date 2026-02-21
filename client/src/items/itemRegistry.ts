import { EFFECT_SEQUENCE } from '../audio/effects';
import { RADIO_CHANNEL_OPTIONS } from '../audio/radioStationRuntime';
import { type ItemType, type WorldItem } from '../state/gameState';

export const CLOCK_TIME_ZONE_OPTIONS = [
  'America/Anchorage',
  'America/Argentina/Buenos_Aires',
  'America/Chicago',
  'America/Detroit',
  'America/Halifax',
  'America/Indiana/Indianapolis',
  'America/Kentucky/Louisville',
  'America/Los_Angeles',
  'America/St_Johns',
  'Asia/Bangkok',
  'Asia/Dhaka',
  'Asia/Dubai',
  'Asia/Hong_Kong',
  'Asia/Kabul',
  'Asia/Karachi',
  'Asia/Kathmandu',
  'Asia/Kolkata',
  'Asia/Seoul',
  'Asia/Singapore',
  'Asia/Tehran',
  'Asia/Tokyo',
  'Asia/Yangon',
  'Atlantic/Azores',
  'Atlantic/South_Georgia',
  'Australia/Brisbane',
  'Australia/Darwin',
  'Australia/Eucla',
  'Australia/Lord_Howe',
  'Europe/Berlin',
  'Europe/Helsinki',
  'Europe/London',
  'Europe/Moscow',
  'Pacific/Apia',
  'Pacific/Auckland',
  'Pacific/Chatham',
  'Pacific/Honolulu',
  'Pacific/Kiritimati',
  'Pacific/Noumea',
  'Pacific/Pago_Pago',
  'UTC',
] as const;

export const ITEM_TYPE_SEQUENCE: ItemType[] = ['clock', 'dice', 'radio_station', 'wheel'];

const ITEM_TYPE_EDITABLE_PROPERTIES: Record<ItemType, string[]> = {
  radio_station: ['title', 'streamUrl', 'enabled', 'channel', 'volume', 'effect', 'effectValue'],
  dice: ['title', 'sides', 'number'],
  wheel: ['title', 'spaces'],
  clock: ['title', 'timeZone', 'use24Hour'],
};

export const ITEM_TYPE_GLOBAL_PROPERTIES: Record<ItemType, Record<string, string | number | boolean>> = {
  radio_station: { useSound: 'none', emitSound: 'none', useCooldownMs: 1000 },
  dice: { useSound: 'sounds/roll.ogg', emitSound: 'none', useCooldownMs: 1000 },
  wheel: { useSound: 'sounds/spin.ogg', emitSound: 'none', useCooldownMs: 4000 },
  clock: { useSound: 'none', emitSound: 'sounds/clock.ogg', useCooldownMs: 1000 },
};

export const EDITABLE_ITEM_PROPERTY_KEYS = new Set<string>(
  Array.from(
    new Set(
      Object.values(ITEM_TYPE_EDITABLE_PROPERTIES).flatMap((keys) => keys),
    ),
  ),
);

const OPTION_ITEM_PROPERTY_VALUES: Partial<Record<string, string[]>> = {
  effect: EFFECT_SEQUENCE.map((effect) => effect.id),
  channel: [...RADIO_CHANNEL_OPTIONS],
  timeZone: [...CLOCK_TIME_ZONE_OPTIONS],
};

export function getItemPropertyOptionValues(key: string): string[] | undefined {
  return OPTION_ITEM_PROPERTY_VALUES[key];
}

export function itemTypeLabel(type: ItemType): string {
  if (type === 'radio_station') return 'radio';
  return type;
}

export function itemPropertyLabel(key: string): string {
  if (key === 'use24Hour') return 'use 24 hour format';
  return key;
}

export function getEditableItemPropertyKeys(item: WorldItem): string[] {
  return [...(ITEM_TYPE_EDITABLE_PROPERTIES[item.type] ?? ['title'])];
}

export function getInspectItemPropertyKeys(item: WorldItem): string[] {
  const editableKeys = getEditableItemPropertyKeys(item);
  const seen = new Set(editableKeys);
  const allKeys: string[] = [...editableKeys];

  const baseKeys = [
    'type',
    'x',
    'y',
    'carrierId',
    'version',
    'createdBy',
    'createdAt',
    'updatedAt',
    'capabilities',
    'useSound',
    'emitSound',
  ];
  for (const key of baseKeys) {
    if (seen.has(key)) continue;
    seen.add(key);
    allKeys.push(key);
  }

  const paramKeys = Object.keys(item.params).sort((a, b) => a.localeCompare(b));
  for (const key of paramKeys) {
    if (seen.has(key)) continue;
    seen.add(key);
    allKeys.push(key);
  }

  const globalKeys = Object.keys(ITEM_TYPE_GLOBAL_PROPERTIES[item.type] ?? {}).sort((a, b) => a.localeCompare(b));
  for (const key of globalKeys) {
    if (seen.has(key)) continue;
    seen.add(key);
    allKeys.push(key);
  }

  return allKeys;
}
