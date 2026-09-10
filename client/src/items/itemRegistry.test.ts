import { afterEach, describe, expect, it } from 'vitest';
import type { WorldItem } from '../state/gameState';
import {
  applyServerItemUiDefinitions,
  getEditableItemPropertyKeys,
  isItemPropertyVisible,
} from './itemRegistry';

function item(params: Record<string, unknown> = {}, type = 'widget'): WorldItem {
  return {
    id: 'item-1',
    type,
    title: type,
    x: 1,
    y: 1,
    z: 0,
    createdBy: 'user-1',
    updatedBy: 'user-1',
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    capabilities: [],
    params,
    occupiedOffsets: [{ x: 0, y: 0 }],
  };
}

function installEmitterMetadata(globalProperties: Record<string, unknown> = {}): void {
  applyServerItemUiDefinitions({
    itemTypes: [{
      type: 'widget',
      editableProperties: ['emitSound', 'directional', 'facing', 'emitEffect', 'emitEffectValue'],
      propertyMetadata: {
        emitSound: { valueType: 'sound' },
        directional: { valueType: 'boolean' },
        facing: { valueType: 'number', visibleWhen: { emitSound: '!', directional: true } },
        emitEffect: { valueType: 'list' },
        emitEffectValue: { valueType: 'number', visibleWhen: { emitSound: '!', emitEffect: '!off' } },
      },
      globalProperties,
    }],
  });
}

describe('item property visibility', () => {
  afterEach(() => {
    applyServerItemUiDefinitions(undefined);
  });

  it('requires a non-empty sound and directional mode before showing facing', () => {
    installEmitterMetadata();
    expect(isItemPropertyVisible(item({ emitSound: '', directional: true }), 'facing')).toBe(false);
    expect(isItemPropertyVisible(item({ emitSound: 'none', directional: true }), 'facing')).toBe(false);
    expect(isItemPropertyVisible(item({ emitSound: 'sounds/beacon.ogg', directional: false }), 'facing')).toBe(false);
    expect(isItemPropertyVisible(item({ emitSound: 'sounds/beacon.ogg', directional: true }), 'facing')).toBe(true);
  });

  it('treats global empty sound sentinels as empty when params omit the value', () => {
    installEmitterMetadata({ emitSound: 'none' });
    expect(getEditableItemPropertyKeys(item({ directional: true }))).toEqual(['emitSound', 'directional', 'emitEffect']);
  });

  it('requires a non-off effect before showing effect amount', () => {
    installEmitterMetadata();
    expect(isItemPropertyVisible(item({ emitSound: 'sounds/beacon.ogg', emitEffect: 'off' }), 'emitEffectValue')).toBe(false);
    expect(isItemPropertyVisible(item({ emitSound: 'sounds/beacon.ogg' }), 'emitEffectValue')).toBe(true);
    expect(isItemPropertyVisible(item({ emitSound: 'sounds/beacon.ogg', emitEffect: 'reverb' }), 'emitEffectValue')).toBe(true);
  });
});
