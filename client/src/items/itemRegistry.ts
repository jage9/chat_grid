import { EFFECT_SEQUENCE } from '../audio/effects';
import { RADIO_CHANNEL_OPTIONS } from '../audio/radioStationRuntime';
import { type ItemType, type WorldItem } from '../state/gameState';

const DEFAULT_CLOCK_TIME_ZONE_OPTIONS = [
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

const DEFAULT_ITEM_TYPE_SEQUENCE: ItemType[] = ['clock', 'dice', 'radio_station', 'wheel', 'widget'];

const DEFAULT_ITEM_TYPE_EDITABLE_PROPERTIES: Record<ItemType, string[]> = {
  radio_station: ['title', 'streamUrl', 'enabled', 'mediaVolume', 'mediaChannel', 'mediaEffect', 'mediaEffectValue', 'facing', 'emitRange'],
  dice: ['title', 'sides', 'number'],
  wheel: ['title', 'spaces'],
  clock: ['title', 'timeZone', 'use24Hour'],
  widget: ['title', 'enabled', 'directional', 'facing', 'emitRange', 'emitVolume', 'emitSoundSpeed', 'emitSoundTempo', 'emitEffect', 'emitEffectValue', 'useSound', 'emitSound'],
};

const DEFAULT_ITEM_TYPE_GLOBAL_PROPERTIES: Record<ItemType, Record<string, string | number | boolean>> = {
  radio_station: { useSound: 'none', emitSound: 'none', useCooldownMs: 1000, emitRange: 20, directional: true, emitSoundSpeed: 50, emitSoundTempo: 50 },
  dice: { useSound: 'sounds/roll.ogg', emitSound: 'none', useCooldownMs: 1000, emitRange: 15, directional: false, emitSoundSpeed: 50, emitSoundTempo: 50 },
  wheel: { useSound: 'sounds/spin.ogg', emitSound: 'none', useCooldownMs: 4000, emitRange: 15, directional: false, emitSoundSpeed: 50, emitSoundTempo: 50 },
  clock: { useSound: 'none', emitSound: 'sounds/clock.ogg', useCooldownMs: 1000, emitRange: 10, directional: false, emitSoundSpeed: 50, emitSoundTempo: 50 },
  widget: { useSound: 'none', emitSound: 'none', useCooldownMs: 1000, emitRange: 15, directional: false, emitSoundSpeed: 50, emitSoundTempo: 50 },
};

export type ItemPropertyValueType = 'boolean' | 'text' | 'number' | 'list' | 'sound';

export type ItemPropertyMetadata = {
  valueType?: ItemPropertyValueType;
  tooltip?: string;
  range?: {
    min: number;
    max: number;
    step?: number;
  };
};

type UiDefinitionsPayload = {
  itemTypeOrder?: ItemType[];
  itemTypes?: Array<{
    type: ItemType;
    label?: string;
    tooltip?: string;
    editableProperties?: string[];
    propertyOptions?: Record<string, string[]>;
    propertyMetadata?: Record<string, unknown>;
    globalProperties?: Record<string, unknown>;
  }>;
};

let itemTypeSequence: ItemType[] = [...DEFAULT_ITEM_TYPE_SEQUENCE];
let itemTypeLabels: Record<ItemType, string> = {
  radio_station: 'radio',
  dice: 'dice',
  wheel: 'wheel',
  clock: 'clock',
  widget: 'widget',
};
let itemTypeTooltips: Partial<Record<ItemType, string>> = {};
let itemTypeEditableProperties: Record<ItemType, string[]> = {
  radio_station: [...DEFAULT_ITEM_TYPE_EDITABLE_PROPERTIES.radio_station],
  dice: [...DEFAULT_ITEM_TYPE_EDITABLE_PROPERTIES.dice],
  wheel: [...DEFAULT_ITEM_TYPE_EDITABLE_PROPERTIES.wheel],
  clock: [...DEFAULT_ITEM_TYPE_EDITABLE_PROPERTIES.clock],
  widget: [...DEFAULT_ITEM_TYPE_EDITABLE_PROPERTIES.widget],
};
let itemTypeGlobalProperties: Record<ItemType, Record<string, string | number | boolean>> = {
  radio_station: { ...DEFAULT_ITEM_TYPE_GLOBAL_PROPERTIES.radio_station },
  dice: { ...DEFAULT_ITEM_TYPE_GLOBAL_PROPERTIES.dice },
  wheel: { ...DEFAULT_ITEM_TYPE_GLOBAL_PROPERTIES.wheel },
  clock: { ...DEFAULT_ITEM_TYPE_GLOBAL_PROPERTIES.clock },
  widget: { ...DEFAULT_ITEM_TYPE_GLOBAL_PROPERTIES.widget },
};
let optionItemPropertyValues: Partial<Record<string, string[]>> = {
  mediaEffect: EFFECT_SEQUENCE.map((effect) => effect.id),
  emitEffect: EFFECT_SEQUENCE.map((effect) => effect.id),
  mediaChannel: [...RADIO_CHANNEL_OPTIONS],
  timeZone: [...DEFAULT_CLOCK_TIME_ZONE_OPTIONS],
};
let itemTypePropertyMetadata: Partial<Record<ItemType, Record<string, ItemPropertyMetadata>>> = {};

export let EDITABLE_ITEM_PROPERTY_KEYS = new Set<string>(
  Object.values(itemTypeEditableProperties).flatMap((keys) => keys),
);

function rebuildEditablePropertyKeySet(): void {
  EDITABLE_ITEM_PROPERTY_KEYS = new Set<string>(Object.values(itemTypeEditableProperties).flatMap((keys) => keys));
}

function normalizePropertyMetadataRecord(raw: Record<string, unknown> | undefined): Record<string, ItemPropertyMetadata> {
  if (!raw) return {};
  const normalized: Record<string, ItemPropertyMetadata> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') continue;
    const valueObj = value as Record<string, unknown>;
    const metadata: ItemPropertyMetadata = {};
    if (valueObj.valueType === 'boolean' || valueObj.valueType === 'text' || valueObj.valueType === 'number' || valueObj.valueType === 'list' || valueObj.valueType === 'sound') {
      metadata.valueType = valueObj.valueType;
    }
    if (typeof valueObj.tooltip === 'string' && valueObj.tooltip.trim().length > 0) {
      metadata.tooltip = valueObj.tooltip.trim();
    }
    const range = valueObj.range;
    if (range && typeof range === 'object') {
      const rangeObj = range as Record<string, unknown>;
      const min = Number(rangeObj.min);
      const max = Number(rangeObj.max);
      const step = rangeObj.step === undefined ? undefined : Number(rangeObj.step);
      if (Number.isFinite(min) && Number.isFinite(max)) {
        metadata.range = {
          min,
          max,
          ...(Number.isFinite(step) ? { step } : {}),
        };
      }
    }
    normalized[key] = metadata;
  }
  return normalized;
}

export function getClockTimeZoneOptions(): string[] {
  return [...(optionItemPropertyValues.timeZone ?? DEFAULT_CLOCK_TIME_ZONE_OPTIONS)];
}

export function getDefaultClockTimeZone(): string {
  return getClockTimeZoneOptions()[0] ?? 'America/Detroit';
}

export function getItemTypeSequence(): ItemType[] {
  return [...itemTypeSequence];
}

export function getItemTypeGlobalProperties(itemType: ItemType): Record<string, string | number | boolean> {
  return itemTypeGlobalProperties[itemType] ?? {};
}

export function getItemTypeTooltip(itemType: ItemType): string | undefined {
  return itemTypeTooltips[itemType];
}

export function getItemPropertyMetadata(itemType: ItemType, key: string): ItemPropertyMetadata | undefined {
  return itemTypePropertyMetadata[itemType]?.[key];
}

export function getItemPropertyOptionValues(key: string): string[] | undefined {
  return optionItemPropertyValues[key];
}

export function itemTypeLabel(type: ItemType): string {
  return itemTypeLabels[type] ?? type;
}

export function itemPropertyLabel(key: string): string {
  if (key === 'use24Hour') return 'use 24 hour format';
  if (key === 'emitRange') return 'emit range';
  if (key === 'mediaVolume') return 'media volume';
  if (key === 'emitVolume') return 'emit volume';
  if (key === 'emitSoundSpeed') return 'emit sound speed';
  if (key === 'emitSoundTempo') return 'emit sound tempo';
  if (key === 'mediaChannel') return 'media channel';
  if (key === 'mediaEffect') return 'media effect';
  if (key === 'mediaEffectValue') return 'media effect value';
  if (key === 'emitEffect') return 'emit effect';
  if (key === 'emitEffectValue') return 'emit effect value';
  if (key === 'useSound') return 'use sound';
  if (key === 'emitSound') return 'emit sound';
  return key;
}

export function getEditableItemPropertyKeys(item: WorldItem): string[] {
  return [...(itemTypeEditableProperties[item.type] ?? ['title'])];
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

  const globalKeys = Object.keys(itemTypeGlobalProperties[item.type] ?? {}).sort((a, b) => a.localeCompare(b));
  for (const key of globalKeys) {
    if (seen.has(key)) continue;
    seen.add(key);
    allKeys.push(key);
  }

  return allKeys;
}

export function applyServerItemUiDefinitions(uiDefinitions: UiDefinitionsPayload | undefined): void {
  if (!uiDefinitions) return;

  if (Array.isArray(uiDefinitions.itemTypeOrder) && uiDefinitions.itemTypeOrder.length > 0) {
    itemTypeSequence = uiDefinitions.itemTypeOrder.filter((entry) => typeof entry === 'string') as ItemType[];
  }

  if (!Array.isArray(uiDefinitions.itemTypes) || uiDefinitions.itemTypes.length === 0) {
    rebuildEditablePropertyKeySet();
    return;
  }

  const nextLabels = { ...itemTypeLabels };
  const nextTooltips = { ...itemTypeTooltips };
  const nextEditable = { ...itemTypeEditableProperties };
  const nextGlobals = { ...itemTypeGlobalProperties };
  const nextOptions: Partial<Record<string, string[]>> = { ...optionItemPropertyValues };
  const nextPropertyMetadata = { ...itemTypePropertyMetadata };

  for (const definition of uiDefinitions.itemTypes) {
    if (!definition || typeof definition.type !== 'string') continue;
    const itemType = definition.type as ItemType;
    if (typeof definition.label === 'string' && definition.label.trim()) {
      nextLabels[itemType] = definition.label.trim();
    }
    if (typeof definition.tooltip === 'string' && definition.tooltip.trim()) {
      nextTooltips[itemType] = definition.tooltip.trim();
    }
    if (Array.isArray(definition.editableProperties) && definition.editableProperties.length > 0) {
      nextEditable[itemType] = definition.editableProperties.filter((entry) => typeof entry === 'string');
    }
    if (definition.propertyMetadata && typeof definition.propertyMetadata === 'object') {
      nextPropertyMetadata[itemType] = normalizePropertyMetadataRecord(definition.propertyMetadata);
    }
    if (definition.globalProperties && typeof definition.globalProperties === 'object') {
      const normalized: Record<string, string | number | boolean> = {};
      for (const [key, raw] of Object.entries(definition.globalProperties)) {
        if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
          normalized[key] = raw;
        }
      }
      nextGlobals[itemType] = normalized;
    }
    if (definition.propertyOptions && typeof definition.propertyOptions === 'object') {
      for (const [propertyKey, values] of Object.entries(definition.propertyOptions)) {
        if (!Array.isArray(values) || values.length === 0) continue;
        const normalizedValues = values.filter((entry) => typeof entry === 'string');
        if (normalizedValues.length > 0) {
          nextOptions[propertyKey] = normalizedValues;
        }
      }
    }
  }

  itemTypeLabels = nextLabels;
  itemTypeTooltips = nextTooltips;
  itemTypeEditableProperties = nextEditable;
  itemTypeGlobalProperties = nextGlobals;
  optionItemPropertyValues = nextOptions;
  itemTypePropertyMetadata = nextPropertyMetadata;
  rebuildEditablePropertyKeySet();
}
