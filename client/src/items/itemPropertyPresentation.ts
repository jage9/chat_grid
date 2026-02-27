import { normalizeDegrees } from '../audio/spatial';
import { normalizeRadioChannel, normalizeRadioEffect, normalizeRadioEffectValue } from '../audio/radioStationRuntime';
import { type WorldItem } from '../state/gameState';
import {
  getDefaultClockTimeZone,
  getEditableItemPropertyKeys,
  getItemPropertyMetadata,
  getItemPropertyOptionValues,
  getItemTypeGlobalProperties,
  itemPropertyLabel,
} from './itemRegistry';

type PresentationDeps = {
  formatTimestampMs: (value: unknown) => string;
};

/** Builds shared item-property presentation/validation helpers used by item menus and message echoes. */
export function createItemPropertyPresentation(deps: PresentationDeps): {
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
    if (key === 'type') return item.type;
    if (key === 'x') return String(item.x);
    if (key === 'y') return String(item.y);
    if (key === 'carrierId') return item.carrierId ?? 'none';
    if (key === 'version') return String(item.version);
    if (key === 'createdBy') return item.createdBy;
    if (key === 'createdAt') return deps.formatTimestampMs(item.createdAt);
    if (key === 'updatedAt') return deps.formatTimestampMs(item.updatedAt);
    if (key === 'capabilities') return item.capabilities.join(', ') || 'none';
    if (key === 'useSound') return toSoundDisplayName(item.params.useSound ?? item.useSound);
    if (key === 'emitSound') return toSoundDisplayName(item.params.emitSound ?? item.emitSound);
    if (key === 'timeZone') return String(item.params.timeZone ?? getDefaultClockTimeZone());
    if (key === 'mediaChannel') return normalizeRadioChannel(item.params.mediaChannel);
    if (key === 'mediaEffect') return normalizeRadioEffect(item.params.mediaEffect);
    if (key === 'mediaEffectValue') return String(normalizeRadioEffectValue(item.params.mediaEffectValue));
    if (key === 'emitEffect') return normalizeRadioEffect(item.params.emitEffect);
    if (key === 'emitEffectValue') return String(normalizeRadioEffectValue(item.params.emitEffectValue));
    if (key === 'facing') {
      const parsed = Number(item.params.facing ?? 0);
      if (!Number.isFinite(parsed)) return '0';
      return String(Math.round(normalizeDegrees(parsed) * 10) / 10);
    }
    if (key === 'emitRange') {
      const parsed = Number(item.params.emitRange ?? getItemTypeGlobalProperties(item.type)?.emitRange ?? 15);
      if (!Number.isFinite(parsed)) return '15';
      return String(Math.round(parsed));
    }
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
    if (paramValue !== undefined) return String(paramValue);
    if (globalValue !== undefined) return String(globalValue);
    return '';
  };

  const isItemPropertyEditable = (item: WorldItem, key: string): boolean => getEditableItemPropertyKeys(item).includes(key);

  const describeItemPropertyHelp = (item: WorldItem, key: string): string => {
    const metadata = getItemPropertyMetadata(item.type, key);
    const parts: string[] = [];
    parts.push(metadata?.tooltip ?? 'No tooltip available.');

    if (metadata?.valueType) {
      const valueType = metadata.valueType;
      parts.push(`Type: ${valueType}.`);
    }

    if (metadata?.range) {
      const stepText = metadata.range.step !== undefined ? ` step ${metadata.range.step}` : '';
      parts.push(`Range: ${metadata.range.min} to ${metadata.range.max}${stepText}.`);
    } else {
      const options = getItemPropertyOptionValues(item.type, key);
      if (options && options.length > 0) {
        parts.push(`Options: ${options.join(', ')}.`);
      }
    }

    if (metadata?.maxLength !== undefined) {
      parts.push(`Max length: ${metadata.maxLength} characters.`);
    }

    parts.push(isItemPropertyEditable(item, key) ? 'Editable.' : 'Read only.');
    return parts.join(' ');
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
