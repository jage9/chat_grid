import type { AudioLayerState } from '../types/audio';

const EFFECT_LEVELS_STORAGE_KEY = 'chatGridEffectLevels';
const AUDIO_INPUT_STORAGE_KEY = 'chatGridAudioInputDeviceId';
const AUDIO_OUTPUT_STORAGE_KEY = 'chatGridAudioOutputDeviceId';
const AUDIO_INPUT_NAME_STORAGE_KEY = 'chatGridAudioInputDeviceName';
const AUDIO_OUTPUT_NAME_STORAGE_KEY = 'chatGridAudioOutputDeviceName';
const AUDIO_OUTPUT_MODE_STORAGE_KEY = 'chatGridAudioOutputMode';
const AUDIO_LAYER_STATE_STORAGE_KEY = 'chatGridAudioLayers';
const MIC_INPUT_GAIN_STORAGE_KEY = 'chatGridMicInputGain';
const MASTER_VOLUME_STORAGE_KEY = 'chatGridMasterVolume';
const PEER_LISTEN_GAINS_STORAGE_KEY = 'chatGridPeerListenGains';
const NICKNAME_STORAGE_KEY = 'spatialChatNickname';

type DevicePreference = {
  id: string;
  name: string;
};

type AudioDevicePreferences = {
  input: DevicePreference;
  output: DevicePreference;
};

/**
 * Wraps localStorage reads/writes for client user settings.
 */
export class SettingsStore {
  loadEffectLevels(): Partial<Record<'reverb' | 'echo' | 'flanger' | 'high_pass' | 'low_pass' | 'off', number>> | null {
    const raw = localStorage.getItem(EFFECT_LEVELS_STORAGE_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Partial<Record<'reverb' | 'echo' | 'flanger' | 'high_pass' | 'low_pass' | 'off', number>>;
    } catch {
      return null;
    }
  }

  saveEffectLevels(levels: Record<string, number>): void {
    localStorage.setItem(EFFECT_LEVELS_STORAGE_KEY, JSON.stringify(levels));
  }

  loadAudioLayers(): AudioLayerState {
    const raw = localStorage.getItem(AUDIO_LAYER_STATE_STORAGE_KEY);
    if (!raw) {
      return { voice: true, item: true, media: true, world: true };
    }
    try {
      const parsed = JSON.parse(raw) as Partial<AudioLayerState>;
      return {
        voice: parsed.voice !== false,
        item: parsed.item !== false,
        media: parsed.media !== false,
        world: parsed.world !== false,
      };
    } catch {
      return { voice: true, item: true, media: true, world: true };
    }
  }

  saveAudioLayers(layers: AudioLayerState): void {
    localStorage.setItem(AUDIO_LAYER_STATE_STORAGE_KEY, JSON.stringify(layers));
  }

  loadMicInputGain(): number | null {
    const raw = localStorage.getItem(MIC_INPUT_GAIN_STORAGE_KEY);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }

  saveMicInputGain(value: number): void {
    localStorage.setItem(MIC_INPUT_GAIN_STORAGE_KEY, String(value));
  }

  loadMasterVolume(): number | null {
    const raw = localStorage.getItem(MASTER_VOLUME_STORAGE_KEY);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }

  saveMasterVolume(value: number): void {
    localStorage.setItem(MASTER_VOLUME_STORAGE_KEY, String(value));
  }

  loadPeerListenGains(): Record<string, number> {
    const raw = localStorage.getItem(PEER_LISTEN_GAINS_STORAGE_KEY);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const normalized: Record<string, number> = {};
      for (const [key, value] of Object.entries(parsed)) {
        const numeric = Number(value);
        if (!key || !Number.isFinite(numeric)) continue;
        normalized[key] = numeric;
      }
      return normalized;
    } catch {
      return {};
    }
  }

  savePeerListenGains(values: Record<string, number>): void {
    localStorage.setItem(PEER_LISTEN_GAINS_STORAGE_KEY, JSON.stringify(values));
  }

  loadNickname(): string {
    return localStorage.getItem(NICKNAME_STORAGE_KEY) || '';
  }

  saveNickname(value: string): void {
    localStorage.setItem(NICKNAME_STORAGE_KEY, value);
  }

  loadOutputMode(): 'mono' | 'stereo' {
    return localStorage.getItem(AUDIO_OUTPUT_MODE_STORAGE_KEY) === 'mono' ? 'mono' : 'stereo';
  }

  saveOutputMode(value: 'mono' | 'stereo'): void {
    localStorage.setItem(AUDIO_OUTPUT_MODE_STORAGE_KEY, value);
  }

  loadAudioDevicePreferences(): AudioDevicePreferences {
    return {
      input: {
        id: localStorage.getItem(AUDIO_INPUT_STORAGE_KEY) || '',
        name: localStorage.getItem(AUDIO_INPUT_NAME_STORAGE_KEY) || '',
      },
      output: {
        id: localStorage.getItem(AUDIO_OUTPUT_STORAGE_KEY) || '',
        name: localStorage.getItem(AUDIO_OUTPUT_NAME_STORAGE_KEY) || '',
      },
    };
  }

  savePreferredInput(id: string, name: string): void {
    localStorage.setItem(AUDIO_INPUT_STORAGE_KEY, id);
    localStorage.setItem(AUDIO_INPUT_NAME_STORAGE_KEY, name);
  }

  savePreferredOutput(id: string, name: string): void {
    localStorage.setItem(AUDIO_OUTPUT_STORAGE_KEY, id);
    localStorage.setItem(AUDIO_OUTPUT_NAME_STORAGE_KEY, name);
  }
}

export { NICKNAME_STORAGE_KEY };
