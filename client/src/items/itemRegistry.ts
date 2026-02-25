import { type ItemType, type WorldItem } from '../state/gameState';

export type ItemPropertyValueType = 'boolean' | 'text' | 'number' | 'list' | 'sound';

export type ItemPropertyMetadata = {
  valueType?: ItemPropertyValueType;
  label?: string;
  tooltip?: string;
  maxLength?: number;
  options?: string[];
  visibleWhen?: Record<string, string | number | boolean>;
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
    capabilities?: string[];
    editableProperties?: string[];
    propertyMetadata?: Record<string, unknown>;
    globalProperties?: Record<string, unknown>;
  }>;
};
let itemTypeSequence: ItemType[] = [];
let itemTypeLabels: Partial<Record<ItemType, string>> = {};
let itemTypeTooltips: Partial<Record<ItemType, string>> = {};
let itemTypeEditableProperties: Partial<Record<ItemType, string[]>> = {};
let itemTypeCapabilities: Partial<Record<ItemType, string[]>> = {};
let itemTypeGlobalProperties: Partial<Record<ItemType, Record<string, string | number | boolean>>> = {};
let itemTypePropertyMetadata: Partial<Record<ItemType, Record<string, ItemPropertyMetadata>>> = {};
let propertyLabelByKey: Record<string, string> = {};

export let EDITABLE_ITEM_PROPERTY_KEYS = new Set<string>(
  Object.values(itemTypeEditableProperties).flatMap((keys) => keys ?? []),
);

/** Rebuilds the flattened editable-key lookup after item-type definitions are replaced. */
function rebuildEditablePropertyKeySet(): void {
  EDITABLE_ITEM_PROPERTY_KEYS = new Set<string>(Object.values(itemTypeEditableProperties).flatMap((keys) => keys ?? []));
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
    if (typeof valueObj.label === 'string' && valueObj.label.trim().length > 0) {
      metadata.label = valueObj.label.trim();
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
    if (Array.isArray(valueObj.options)) {
      const options = valueObj.options.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
      if (options.length > 0) {
        metadata.options = options;
      }
    }
    if (valueObj.visibleWhen && typeof valueObj.visibleWhen === 'object') {
      const visibleWhen: Record<string, string | number | boolean> = {};
      for (const [conditionKey, conditionValue] of Object.entries(valueObj.visibleWhen as Record<string, unknown>)) {
        if (typeof conditionValue === 'string' || typeof conditionValue === 'number' || typeof conditionValue === 'boolean') {
          visibleWhen[conditionKey] = conditionValue;
        }
      }
      if (Object.keys(visibleWhen).length > 0) {
        metadata.visibleWhen = visibleWhen;
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
  return [...(getItemPropertyMetadata('clock', 'timeZone')?.options ?? [])];
}

/** Returns default timezone used by clock items when no override is set. */
export function getDefaultClockTimeZone(): string {
  return getClockTimeZoneOptions()[0] ?? '';
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
export function getItemPropertyOptionValues(itemType: ItemType, key: string): string[] | undefined {
  return itemTypePropertyMetadata[itemType]?.[key]?.options;
}

/** Returns human-facing label for an item type. */
export function itemTypeLabel(type: ItemType): string {
  return itemTypeLabels[type] ?? type;
}

/** Returns server-defined capabilities for one item type, if provided. */
export function getItemTypeCapabilities(itemType: ItemType): string[] {
  return [...(itemTypeCapabilities[itemType] ?? [])];
}

/** Returns human-facing label for a property key. */
export function itemPropertyLabel(key: string): string {
  const metadataLabel = propertyLabelByKey[key];
  if (metadataLabel) return metadataLabel;
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words || key;
}

/** Returns editable properties for one item instance/type. */
export function getEditableItemPropertyKeys(item: WorldItem): string[] {
  const rawKeys = itemTypeEditableProperties[item.type];
  if (!rawKeys || rawKeys.length === 0) {
    return [];
  }
  return rawKeys.filter((key) => isItemPropertyVisible(item, key));
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

  // Keep derived radio metadata in a stable, user-friendly order.
  if (item.type === 'radio_station') {
    for (const key of ['stationName', 'nowPlaying']) {
      if (!isItemPropertyVisible(item, key)) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      allKeys.push(key);
    }
  }

  const paramKeys = Object.keys(item.params).sort((a, b) => a.localeCompare(b));
  for (const key of paramKeys) {
    if (!isItemPropertyVisible(item, key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    allKeys.push(key);
  }

  const globalKeys = Object.keys(itemTypeGlobalProperties[item.type] ?? {}).sort((a, b) => a.localeCompare(b));
  for (const key of globalKeys) {
    if (!isItemPropertyVisible(item, key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    allKeys.push(key);
  }

  return allKeys;
}

/** Applies server-supplied UI/catalog definitions for item types, properties, and options. */
export function applyServerItemUiDefinitions(uiDefinitions: UiDefinitionsPayload | undefined): boolean {
  if (!uiDefinitions || !Array.isArray(uiDefinitions.itemTypes) || uiDefinitions.itemTypes.length === 0) {
    itemTypeSequence = [];
    itemTypeLabels = {};
    itemTypeTooltips = {};
    itemTypeEditableProperties = {};
    itemTypeCapabilities = {};
    itemTypeGlobalProperties = {};
    itemTypePropertyMetadata = {};
    propertyLabelByKey = {};
    rebuildEditablePropertyKeySet();
    return false;
  }

  const explicitOrder =
    Array.isArray(uiDefinitions.itemTypeOrder) && uiDefinitions.itemTypeOrder.length > 0
      ? (uiDefinitions.itemTypeOrder.filter((entry) => typeof entry === 'string') as ItemType[])
      : null;

  const nextLabels: Partial<Record<ItemType, string>> = {};
  const nextTooltips: Partial<Record<ItemType, string>> = {};
  const nextEditable: Partial<Record<ItemType, string[]>> = {};
  const nextCapabilities: Partial<Record<ItemType, string[]>> = {};
  const nextGlobals: Partial<Record<ItemType, Record<string, string | number | boolean>>> = {};
  const nextPropertyMetadata: Partial<Record<ItemType, Record<string, ItemPropertyMetadata>>> = {};
  const nextPropertyLabels: Record<string, string> = {};

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
    if (Array.isArray(definition.capabilities) && definition.capabilities.length > 0) {
      nextCapabilities[itemType] = definition.capabilities.filter((entry) => typeof entry === 'string');
    }
    if (definition.propertyMetadata && typeof definition.propertyMetadata === 'object') {
      const normalizedMetadata = normalizePropertyMetadataRecord(definition.propertyMetadata);
      nextPropertyMetadata[itemType] = normalizedMetadata;
      for (const [propertyKey, propertyMetadata] of Object.entries(normalizedMetadata)) {
        if (typeof propertyMetadata.label === 'string' && propertyMetadata.label.trim().length > 0) {
          nextPropertyLabels[propertyKey] = propertyMetadata.label.trim();
        }
      }
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
  }

  const discoveredOrder: ItemType[] = [];
  for (const definition of uiDefinitions.itemTypes) {
    if (!definition || typeof definition.type !== 'string') continue;
    discoveredOrder.push(definition.type as ItemType);
  }

  itemTypeLabels = nextLabels;
  itemTypeTooltips = nextTooltips;
  itemTypeEditableProperties = nextEditable;
  itemTypeCapabilities = nextCapabilities;
  itemTypeGlobalProperties = nextGlobals;
  itemTypePropertyMetadata = nextPropertyMetadata;
  propertyLabelByKey = nextPropertyLabels;
  itemTypeSequence = explicitOrder ?? discoveredOrder;
  rebuildEditablePropertyKeySet();
  return itemTypeSequence.length > 0;
}

/** Returns whether a property is currently visible for an item based on metadata visibility rules. */
export function isItemPropertyVisible(item: WorldItem, key: string): boolean {
  const metadata = getItemPropertyMetadata(item.type, key);
  const visibilityRule = (metadata as Record<string, unknown> | undefined)?.visibleWhen;
  if (!visibilityRule || typeof visibilityRule !== 'object') {
    return true;
  }
  const conditions = visibilityRule as Record<string, string | number | boolean>;
  for (const [conditionKey, expected] of Object.entries(conditions)) {
    const actual =
      item.params[conditionKey] ??
      getItemTypeGlobalProperties(item.type)[conditionKey];
    if (typeof expected === 'string' && expected.startsWith('!')) {
      if (String(actual) === expected.slice(1)) {
        return false;
      }
      continue;
    }
    if (actual !== expected) {
      return false;
    }
  }
  return true;
}
