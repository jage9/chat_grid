export type PropertyHelpMetadata = {
  valueType?: string;
  tooltip?: string;
  maxLength?: number;
  options?: readonly string[];
  range?: { min: number; max: number; step?: number };
};

/** Describe a property using shared type, range, option, and editability metadata. */
export function describePropertyHelp(
  label: string,
  metadata: PropertyHelpMetadata | undefined,
  editable: boolean,
): string {
  const parts = [metadata?.tooltip ?? `${label}.`];
  if (metadata?.valueType) parts.push(`Type: ${metadata.valueType}.`);
  if (metadata?.range) {
    const stepText = metadata.range.step !== undefined ? ` step ${metadata.range.step}` : '';
    parts.push(`Range: ${metadata.range.min} to ${metadata.range.max}${stepText}.`);
  } else if (metadata?.options && metadata.options.length > 0) {
    parts.push(`Options: ${metadata.options.join(', ')}.`);
  }
  if (metadata?.maxLength !== undefined) {
    parts.push(`Max length: ${metadata.maxLength} characters.`);
  }
  parts.push(editable ? 'Editable.' : 'Read only.');
  return parts.join(' ');
}
