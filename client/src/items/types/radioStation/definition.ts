import { RADIO_CHANNEL_OPTIONS } from '../../../audio/radioStationRuntime';
import { EFFECT_SEQUENCE } from '../../../audio/effects';
import { type ItemTypeClientDefinition } from '../shared';

/** Default client-side UI definition for radio_station items. */
export const radioStationDefinition: ItemTypeClientDefinition = {
  type: 'radio_station',
  label: 'radio',
  editableProperties: ['title', 'streamUrl', 'enabled', 'mediaVolume', 'mediaChannel', 'mediaEffect', 'mediaEffectValue', 'facing', 'emitRange'],
  globalProperties: {
    useSound: 'none',
    emitSound: 'none',
    useCooldownMs: 1000,
    emitRange: 20,
    directional: true,
    emitSoundSpeed: 50,
    emitSoundTempo: 50,
  },
  propertyOptions: {
    mediaEffect: EFFECT_SEQUENCE.map((effect) => effect.id),
    mediaChannel: [...RADIO_CHANNEL_OPTIONS],
  },
};
