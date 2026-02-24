import { EFFECT_SEQUENCE } from '../../audio/effects';
import { type ItemTypeClientDefinition } from './shared';

/** Default client-side UI definition for widget items. */
export const widgetDefinition: ItemTypeClientDefinition = {
  type: 'widget',
  label: 'widget',
  editableProperties: [
    'title',
    'enabled',
    'directional',
    'facing',
    'emitRange',
    'emitVolume',
    'emitSoundSpeed',
    'emitSoundTempo',
    'emitEffect',
    'emitEffectValue',
    'useSound',
    'emitSound',
  ],
  globalProperties: {
    useSound: 'none',
    emitSound: 'none',
    useCooldownMs: 1000,
    emitRange: 15,
    directional: false,
    emitSoundSpeed: 50,
    emitSoundTempo: 50,
  },
  propertyOptions: {
    emitEffect: EFFECT_SEQUENCE.map((effect) => effect.id),
  },
};

