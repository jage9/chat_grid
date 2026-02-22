export function snapNumberToStep(value: number, step: number, anchor = 0): number {
  if (!(step > 0) || !Number.isFinite(value) || !Number.isFinite(anchor)) {
    return value;
  }
  const normalized = Math.round((value - anchor) / step) * step + anchor;
  const decimals = step >= 1 ? 0 : Math.min(6, Math.ceil(Math.abs(Math.log10(step))) + 1);
  return Number(normalized.toFixed(decimals));
}

export function formatSteppedNumber(value: number, step: number): string {
  const decimals = step >= 1 ? 0 : Math.min(6, Math.ceil(Math.abs(Math.log10(step))) + 1);
  if (decimals <= 0) {
    return String(Math.round(value));
  }
  return value
    .toFixed(decimals)
    .replace(/(\.\d*?[1-9])0+$/u, '$1')
    .replace(/\.0+$/u, '');
}
