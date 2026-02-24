import { type ItemType, type WorldItem } from '../state/gameState';
import { CLOCK_TIME_ZONE_OPTIONS } from './types/clock';
import { DEFAULT_ITEM_TYPE_DEFINITIONS, DEFAULT_ITEM_TYPE_SEQUENCE } from './types';

export type ItemPropertyValueType = 'boolean' | 'text' | 'number' | 'list' | 'sound';

export type ItemPropertyMetadata = {
  valueType?: ItemPropertyValueType;
  tooltip?: string;
  maxLength?: number;
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
let itemTypeLabels: Record<ItemType, string> = {} as Record<ItemType, string>;
let itemTypeTooltips: Partial<Record<ItemType, string>> = {};
let itemTypeEditableProperties: Record<ItemType, string[]> = {} as Record<ItemType, string[]>;
let itemTypeGlobalProperties: Record<ItemType, Record<string, string | number | boolean>> = {} as Record<
  ItemType,
  Record<string, string | number | boolean>
>;
let optionItemPropertyValues: Partial<Record<string, string[]>> = {};
let itemTypePropertyMetadata: Partial<Record<ItemType, Record<string, ItemPropertyMetadata>>> = {};

for (const definition of DEFAULT_ITEM_TYPE_DEFINITIONS) {
  itemTypeLabels[definition.type] = definition.label;
  if (definition.tooltip) {
    itemTypeTooltips[definition.type] = definition.tooltip;
  }
  itemTypeEditableProperties[definition.type] = [...definition.editableProperties];
  itemTypeGlobalProperties[definition.type] = { ...definition.globalProperties };
  if (definition.propertyMetadata) {
    itemTypePropertyMetadata[definition.type] = { ...definition.propertyMetadata };
  }
  if (definition.propertyOptions) {
    for (const [key, values] of Object.entries(definition.propertyOptions)) {
      optionItemPropertyValues[key] = [...values];
    }
  }
}

export let EDITABLE_ITEM_PROPERTY_KEYS = new Set<string>(
  Object.values(itemTypeEditableProperties).flatMap((keys) => keys),
);

/** Rebuilds the flattened editable-key lookup after item-type definitions are replaced. */
function rebuildEditablePropertyKeySet(): void {
  EDITABLE_ITEM_PROPERTY_KEYS = new Set<string>(Object.values(itemTypeEditableProperties).flatMap((keys) => keys));
}

/** Normalizes server-provided property metadata into strict client metadata shape. */
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
    if (valueObj.maxLength !== undefined) {
      const maxLength = Number(valueObj.maxLength);
      if (Number.isFinite(maxLength) && maxLength > 0) {
        metadata.maxLength = Math.floor(maxLength);
      }
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

/** Returns current timezone option list used by clock item properties. */
export function getClockTimeZoneOptions(): string[] {
  return [...(optionItemPropertyValues.timeZone ?? CLOCK_TIME_ZONE_OPTIONS)];
}

/** Returns default timezone used by clock items when no override is set. */
export function getDefaultClockTimeZone(): string {
  return getClockTimeZoneOptions()[0] ?? 'America/Detroit';
}

/** Returns item-type display order for add-item menus. */
export function getItemTypeSequence(): ItemType[] {
  return [...itemTypeSequence];
}

/** Returns global per-type property defaults provided by server/item catalog. */
export function getItemTypeGlobalProperties(itemType: ItemType): Record<string, string | number | boolean> {
  return itemTypeGlobalProperties[itemType] ?? {};
}

/** Returns item-type tooltip text, if defined. */
export function getItemTypeTooltip(itemType: ItemType): string | undefined {
  return itemTypeTooltips[itemType];
}

/** Returns metadata for a given item property on a specific type. */
export function getItemPropertyMetadata(itemType: ItemType, key: string): ItemPropertyMetadata | undefined {
  return itemTypePropertyMetadata[itemType]?.[key];
}

/** Returns option-list values for list-based properties, if defined. */
export function getItemPropertyOptionValues(key: string): string[] | undefined {
  return optionItemPropertyValues[key];
}

/** Returns human-facing label for an item type. */
export function itemTypeLabel(type: ItemType): string {
  return itemTypeLabels[type] ?? type;
}

/** Returns human-facing label for a property key. */
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
  if (key === 'instrument') return 'instrument';
  if (key === 'voiceMode') return 'voice mode';
  if (key === 'octave') return 'octave';
  if (key === 'attack') return 'attack';
  if (key === 'decay') return 'decay';
  if (key === 'release') return 'release';
  if (key === 'brightness') return 'brightness';
  if (key === 'useSound') return 'use sound';
  if (key === 'emitSound') return 'emit sound';
  return key;
}

/** Returns editable properties for one item instance/type. */
export function getEditableItemPropertyKeys(item: WorldItem): string[] {
  return [...(itemTypeEditableProperties[item.type] ?? ['title'])];
}

/** Returns inspect-mode property key list (editable first, then system/global extras). */
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

/** Applies server-supplied UI/catalog definitions for item types, properties, and options. */
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
