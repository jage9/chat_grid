import { formatSteppedNumber, snapNumberToStep } from './numeric';

export type PropertyOption = { id: string; label: string };

export type PropertyControlMetadata = {
  valueType?: string;
  tooltip?: string;
  maxLength?: number;
  options?: readonly (string | PropertyOption)[];
  range?: { min: number; max: number; step?: number; anchor?: number };
};

export type PropertyAdjustment = {
  value: string | number | boolean;
  displayValue: string;
  hitBoundary: boolean;
};

/** Normalize property option metadata for selectors and direct cycling. */
export function getPropertyOptions(metadata: PropertyControlMetadata | undefined): PropertyOption[] {
  return (metadata?.options ?? []).map((option) => (
    typeof option === 'string' ? { id: option, label: option } : option
  ));
}

/** Describe a property using shared type, range, option, and editability metadata. */
export function describePropertyHelp(
  label: string,
  metadata: PropertyControlMetadata | undefined,
  editable: boolean,
): string {
  const parts = [metadata?.tooltip ?? `${label}.`];
  if (metadata?.valueType) parts.push(`Type: ${metadata.valueType}.`);
  if (metadata?.range) {
    const stepText = metadata.range.step !== undefined ? ` step ${metadata.range.step}` : '';
    parts.push(`Range: ${metadata.range.min} to ${metadata.range.max}${stepText}.`);
  } else {
    const options = getPropertyOptions(metadata);
    if (options.length > 0) parts.push(`Options: ${options.map((option) => option.label).join(', ')}.`);
  }
  if (metadata?.maxLength !== undefined) {
    parts.push(`Max length: ${metadata.maxLength} characters.`);
  }
  parts.push(editable ? 'Editable.' : 'Read only.');
  return parts.join(' ');
}

/** Apply standard arrow/page-key behavior to a list, boolean, or numeric property. */
export function adjustPropertyValue(
  code: string,
  currentValue: unknown,
  metadata: PropertyControlMetadata | undefined,
  axis: 'horizontal' | 'vertical' = 'horizontal',
): PropertyAdjustment | null {
  const options = getPropertyOptions(metadata);
  if (options.length > 0 && axis === 'horizontal') {
    if (!['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'].includes(code)) return null;
    const normalized = String(currentValue ?? '').trim().toLowerCase();
    const currentIndex = Math.max(0, options.findIndex((option) => option.id.toLowerCase() === normalized));
    const pageJump = Math.min(10, Math.max(1, options.length - 1));
    const delta = code === 'ArrowRight' ? 1 : code === 'ArrowLeft' ? -1 : code === 'PageDown' ? pageJump : -pageJump;
    const option = options[(currentIndex + delta + options.length) % options.length];
    return { value: option.id, displayValue: option.label, hitBoundary: false };
  }

  if (metadata?.valueType === 'boolean' && axis === 'horizontal') {
    if (!['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'].includes(code)) return null;
    const current = typeof currentValue === 'boolean'
      ? currentValue
      : ['on', 'true', '1', 'yes'].includes(String(currentValue).trim().toLowerCase());
    const value = !current;
    return { value, displayValue: value ? 'on' : 'off', hitBoundary: false };
  }

  if (metadata?.valueType !== 'number') return null;
  const decreaseKey = axis === 'horizontal' ? 'ArrowLeft' : 'ArrowDown';
  const increaseKey = axis === 'horizontal' ? 'ArrowRight' : 'ArrowUp';
  if (![decreaseKey, increaseKey, 'PageUp', 'PageDown'].includes(code)) return null;
  const range = metadata.range;
  const step = range?.step && range.step > 0 ? range.step : 1;
  const parsed = Number(currentValue);
  const current = Number.isFinite(parsed) ? parsed : range?.min ?? 0;
  const multiplier = code === 'PageUp' || code === 'PageDown' ? 10 : 1;
  const direction = code === increaseKey || code === 'PageUp' ? 1 : -1;
  const anchor = range?.anchor ?? range?.min ?? 0;
  const attempted = snapNumberToStep(current + direction * step * multiplier, step, anchor);
  const value = Math.max(range?.min ?? -Infinity, Math.min(range?.max ?? Infinity, attempted));
  return {
    value,
    displayValue: formatSteppedNumber(value, step),
    hitBoundary: Math.abs(value - current) < 1e-9 || Math.abs(value - attempted) > 1e-9,
  };
}

/** Parse, range-check, and step-normalize numeric property input. */
export function validateNumericPropertyInput(
  label: string,
  rawValue: string,
  metadata: PropertyControlMetadata | undefined,
  requireInteger: boolean,
): { ok: true; value: number } | { ok: false; message: string } {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return { ok: false, message: `${label} must be a number.` };
  if (requireInteger && !Number.isInteger(parsed)) {
    return { ok: false, message: `${label} must be an integer.` };
  }
  const range = metadata?.range;
  if (range && (parsed < range.min || parsed > range.max)) {
    return { ok: false, message: `${label} must be between ${range.min} and ${range.max}.` };
  }
  if (!range?.step || range.step <= 0) return { ok: true, value: parsed };
  const anchor = range.anchor ?? range.min;
  return { ok: true, value: Number(formatSteppedNumber(snapNumberToStep(parsed, range.step, anchor), range.step)) };
}
