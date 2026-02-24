import { type ItemTypeClientDefinition } from './shared';

/** Default client-side UI definition for dice items. */
export const diceDefinition: ItemTypeClientDefinition = {
  type: 'dice',
  label: 'dice',
  editableProperties: ['title', 'sides', 'number'],
  globalProperties: {
    useSound: 'sounds/roll.ogg',
    emitSound: 'none',
    useCooldownMs: 1000,
    emitRange: 15,
    directional: false,
    emitSoundSpeed: 50,
    emitSoundTempo: 50,
  },
};

