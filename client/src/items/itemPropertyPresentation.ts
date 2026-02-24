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

  const inferItemPropertyValueType = (item: WorldItem, key: string): string | undefined => {
    if (key === 'useSound' || key === 'emitSound') return 'sound';
    if (key === 'enabled' || key === 'use24Hour' || key === 'directional') return 'boolean';
    if (key === 'mediaChannel' || key === 'mediaEffect' || key === 'emitEffect' || key === 'timeZone' || key === 'instrument' || key === 'voiceMode') return 'list';
    if (
      key === 'x' ||
      key === 'y' ||
      key === 'version' ||
      key === 'mediaVolume' ||
      key === 'emitVolume' ||
      key === 'emitSoundSpeed' ||
      key === 'emitSoundTempo' ||
      key === 'mediaEffectValue' ||
      key === 'emitEffectValue' ||
      key === 'facing' ||
      key === 'emitRange' ||
      key === 'octave' ||
      key === 'attack' ||
      key === 'decay' ||
      key === 'release' ||
      key === 'brightness' ||
      key === 'sides' ||
      key === 'number' ||
      key === 'useCooldownMs'
    ) {
      return 'number';
    }
    if (key in item.params || key in getItemTypeGlobalProperties(item.type)) {
      const value = item.params[key] ?? getItemTypeGlobalProperties(item.type)?.[key];
      if (typeof value === 'boolean') return 'boolean';
      if (typeof value === 'number') return 'number';
      if (typeof value === 'string') return 'text';
    }
    return 'text';
  };

  const getFallbackInspectPropertyTooltip = (key: string): string | undefined => {
    if (key === 'type') return 'The item type identifier.';
    if (key === 'x') return 'X coordinate on the grid.';
    if (key === 'y') return 'Y coordinate on the grid.';
    if (key === 'carrierId') return 'Current carrier user id, or none when on the ground.';
    if (key === 'version') return 'Server version for this item, incremented after each update.';
    if (key === 'createdBy') return 'User id of who created this item.';
    if (key === 'createdAt') return 'Timestamp when this item was created.';
    if (key === 'updatedAt') return 'Timestamp when this item was last updated.';
    if (key === 'capabilities') return 'Server-declared actions supported by this item.';
    if (key === 'useSound') return 'One-shot sound played when use succeeds.';
    if (key === 'emitSound') return 'Looping emitted sound source for this item.';
    if (key === 'useCooldownMs') return 'Global cooldown in milliseconds between uses.';
    if (key === 'directional') return 'Whether emitted audio favors item facing direction.';
    return undefined;
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
    if (key === 'enabled') return item.params.enabled === false ? 'off' : 'on';
    if (key === 'directional') {
      if (typeof item.params.directional === 'boolean') {
        return item.params.directional ? 'on' : 'off';
      }
      return getItemTypeGlobalProperties(item.type).directional === true ? 'on' : 'off';
    }
    if (key === 'timeZone') return String(item.params.timeZone ?? getDefaultClockTimeZone());
    if (key === 'use24Hour') return item.params.use24Hour === true ? 'on' : 'off';
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
    const paramValue = item.params[key];
    if (paramValue !== undefined) return String(paramValue);
    const globalValue = getItemTypeGlobalProperties(item.type)?.[key];
    if (globalValue !== undefined) return String(globalValue);
    return '';
  };

  const isItemPropertyEditable = (item: WorldItem, key: string): boolean => getEditableItemPropertyKeys(item).includes(key);

  const describeItemPropertyHelp = (item: WorldItem, key: string): string => {
    const metadata = getItemPropertyMetadata(item.type, key);
    const parts: string[] = [];
    const tooltip = metadata?.tooltip ?? getFallbackInspectPropertyTooltip(key);
    if (tooltip) {
      parts.push(tooltip);
    } else {
      parts.push('No tooltip available.');
    }

    const valueType = metadata?.valueType ?? inferItemPropertyValueType(item, key);
    if (valueType) {
      parts.push(`Type: ${valueType}.`);
    }

    if (metadata?.range) {
      const stepText = metadata.range.step !== undefined ? ` step ${metadata.range.step}` : '';
      parts.push(`Range: ${metadata.range.min} to ${metadata.range.max}${stepText}.`);
    } else {
      const options = getItemPropertyOptionValues(key);
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

