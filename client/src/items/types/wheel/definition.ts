import { type ItemTypeClientDefinition } from '../shared';

/** Default client-side UI definition for wheel items. */
export const wheelDefinition: ItemTypeClientDefinition = {
  type: 'wheel',
  label: 'wheel',
  editableProperties: ['title', 'spaces'],
  globalProperties: {
    useSound: 'sounds/spin.ogg',
    emitSound: 'none',
    useCooldownMs: 4000,
    emitRange: 15,
    directional: false,
    emitSoundSpeed: 50,
    emitSoundTempo: 50,
  },
};
