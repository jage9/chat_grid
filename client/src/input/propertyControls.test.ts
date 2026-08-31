import { describe, expect, it } from 'vitest';
import {
  adjustPropertyValue,
  describePropertyHelp,
  getPropertyOptions,
  validateNumericPropertyInput,
} from './propertyControls';

describe('shared property controls', () => {
  it('normalizes and cycles labeled options', () => {
    const metadata = {
      valueType: 'list',
      options: [{ id: 'brick', label: 'Brick' }, { id: 'curtain', label: 'Curtain' }],
    };
    expect(getPropertyOptions(metadata)).toHaveLength(2);
    expect(adjustPropertyValue('ArrowRight', 'brick', metadata)).toEqual({
      value: 'curtain',
      displayValue: 'Curtain',
      hitBoundary: false,
    });
  });

  it('steps, clamps, and validates numeric metadata consistently', () => {
    const metadata = {
      valueType: 'number',
      range: { min: 0, max: 1, step: 0.05, anchor: 0 },
    };
    expect(adjustPropertyValue('ArrowRight', 0.5, metadata)?.value).toBe(0.55);
    expect(adjustPropertyValue('PageUp', 0.95, metadata)).toEqual({
      value: 1,
      displayValue: '1',
      hitBoundary: true,
    });
    expect(validateNumericPropertyInput('Volume', '0.53', metadata, false)).toEqual({
      ok: true,
      value: 0.55,
    });
  });

  it('combines descriptive help with global type and option details', () => {
    const help = describePropertyHelp('Type', {
      valueType: 'list',
      tooltip: 'Choose a wall preset.',
      options: ['Brick', 'Curtain'],
    }, true);
    expect(help).toBe('Choose a wall preset. Type: list. Options: Brick, Curtain. Editable.');
  });
});
