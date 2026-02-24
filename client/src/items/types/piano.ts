import { PIANO_INSTRUMENT_OPTIONS } from '../../audio/pianoSynth';
import { type ItemTypeClientDefinition } from './shared';

/** Default client-side UI definition for piano items. */
export const pianoDefinition: ItemTypeClientDefinition = {
  type: 'piano',
  label: 'piano',
  editableProperties: ['title', 'instrument', 'voiceMode', 'octave', 'attack', 'decay', 'release', 'brightness', 'emitRange'],
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
    instrument: [...PIANO_INSTRUMENT_OPTIONS],
    voiceMode: ['poly', 'mono'],
  },
};

