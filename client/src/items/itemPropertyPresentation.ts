import { type WorldItem } from '../state/gameState';
import {
  getEditableItemPropertyKeys,
  getItemPropertyMetadata,
  getItemPropertyOptionValues,
  getItemTypeGlobalProperties,
  itemPropertyLabel,
} from './itemRegistry';
import { describePropertyHelp } from '../input/propertyHelp';

/** Builds shared item-property presentation/validation helpers used by item menus and message echoes. */
export function createItemPropertyPresentation(): {
  getItemPropertyValue: (item: WorldItem, key: string) => string;
  isItemPropertyEditable: (item: WorldItem, key: string) => boolean;
  describeItemPropertyHelp: (item: WorldItem, key: string) => string;
  validateNumericItemPropertyInput: (
    item: WorldItem,
    key: string,
    rawValue: string,
    requireInteger: boolean,
  ) => { ok: true; value: number } | { ok: false; message: string };
} {
  const toSoundDisplayName = (rawValue: unknown): string => {
    const raw = String(rawValue ?? '').trim();
    if (!raw) return 'none';
    if (raw.toLowerCase() === 'none') return 'none';
    const withoutQuery = raw.split('?')[0].split('#')[0];
    const segments = withoutQuery.split('/').filter((part) => part.length > 0);
    return segments[segments.length - 1] ?? raw;
  };

  const getItemPropertyValue = (item: WorldItem, key: string): string => {
    if (key === 'title') return item.title;
    if (item.display && typeof item.display[key] === 'string') return item.display[key];
    const metadata = getItemPropertyMetadata(item.type, key);
    const globalValue = getItemTypeGlobalProperties(item.type)?.[key];
    const paramValue = item.params[key];
    const rawValue = paramValue !== undefined ? paramValue : globalValue;
    if (metadata?.valueType === 'boolean') {
      if (rawValue === undefined && key === 'enabled') return 'on';
      return rawValue === true ? 'on' : 'off';
    }
    if (metadata?.valueType === 'sound') {
      return toSoundDisplayName(rawValue);
    }
    if (metadata?.valueType === 'number') {
      const parsed = Number(rawValue);
      if (!Number.isFinite(parsed)) return '';
      const step = metadata.range?.step;
      if (step && step > 0 && Number.isFinite(step)) {
        const precision = String(step).includes('.') ? String(step).split('.')[1]?.length ?? 0 : 0;
        return String(Number(parsed.toFixed(precision)));
      }
      return String(parsed);
    }
    if (metadata?.valueType === 'list' || metadata?.valueType === 'text') {
      return rawValue === undefined || rawValue === null ? '' : String(rawValue);
    }
    if (paramValue !== undefined) return String(paramValue);
    if (globalValue !== undefined) return String(globalValue);
    return '';
  };

  const isItemPropertyEditable = (item: WorldItem, key: string): boolean => getEditableItemPropertyKeys(item).includes(key);

  const describeItemPropertyHelp = (item: WorldItem, key: string): string => {
    const metadata = getItemPropertyMetadata(item.type, key);
    return describePropertyHelp(
      itemPropertyLabel(key),
      { ...metadata, options: getItemPropertyOptionValues(item.type, key) },
      isItemPropertyEditable(item, key),
    );
  };

  const validateNumericItemPropertyInput = (
    item: WorldItem,
    key: string,
    rawValue: string,
    requireInteger: boolean,
  ): { ok: true; value: number } | { ok: false; message: string } => {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) {
      return { ok: false, message: `${itemPropertyLabel(key)} must be a number.` };
    }
    if (requireInteger && !Number.isInteger(parsed)) {
      return { ok: false, message: `${itemPropertyLabel(key)} must be an integer.` };
    }
    const range = getItemPropertyMetadata(item.type, key)?.range;
    if (range && (parsed < range.min || parsed > range.max)) {
      return { ok: false, message: `${itemPropertyLabel(key)} must be between ${range.min} and ${range.max}.` };
    }
    if (!range) {
      return { ok: true, value: parsed };
    }
    if (range.step && range.step > 0) {
      const anchor = Number.isFinite(range.min) ? range.min : 0;
      const steps = Math.round((parsed - anchor) / range.step);
      const snapped = anchor + steps * range.step;
      const precision = String(range.step).includes('.') ? String(range.step).split('.')[1]?.length ?? 0 : 0;
      const rounded = Number(snapped.toFixed(precision));
      return { ok: true, value: rounded };
    }
    return { ok: true, value: parsed };
  };

  return {
    getItemPropertyValue,
    isItemPropertyEditable,
    describeItemPropertyHelp,
    validateNumericItemPropertyInput,
  };
}
