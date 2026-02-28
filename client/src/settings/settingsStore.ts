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
const AUTH_USERNAME_STORAGE_KEY = 'chatGridAuthUsername';
const LEGACY_AUTH_SESSION_TOKEN_STORAGE_KEY = 'chatGridAuthSessionToken';
const AUTH_SESSION_COOKIE_NAME = 'chgrid_session_token';
const AUTH_SESSION_MAX_AGE_SECONDS = 14 * 24 * 60 * 60;

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
  private readCookie(name: string): string {
    const cookie = document.cookie || '';
    const parts = cookie.split(';');
    for (const part of parts) {
      const [rawKey, ...rest] = part.trim().split('=');
      if (rawKey !== name) continue;
      const rawValue = rest.join('=');
      try {
        return decodeURIComponent(rawValue);
      } catch {
        return rawValue;
      }
    }
    return '';
  }

  private writeCookie(name: string, value: string, maxAgeSeconds: number): void {
    const encoded = encodeURIComponent(value);
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${name}=${encoded}; Path=/; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}; SameSite=Lax${secure}`;
  }

  private clearCookie(name: string): void {
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
  }

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

  loadAuthSessionToken(): string {
    // Session token is persisted in cookie storage (not localStorage).
    localStorage.removeItem(LEGACY_AUTH_SESSION_TOKEN_STORAGE_KEY);
    return this.readCookie(AUTH_SESSION_COOKIE_NAME);
  }

  saveAuthSessionToken(token: string): void {
    localStorage.removeItem(LEGACY_AUTH_SESSION_TOKEN_STORAGE_KEY);
    if (token) {
      this.writeCookie(AUTH_SESSION_COOKIE_NAME, token, AUTH_SESSION_MAX_AGE_SECONDS);
      return;
    }
    this.clearCookie(AUTH_SESSION_COOKIE_NAME);
  }

  loadAuthUsername(): string {
    return localStorage.getItem(AUTH_USERNAME_STORAGE_KEY) || '';
  }

  saveAuthUsername(username: string): void {
    if (username) {
      localStorage.setItem(AUTH_USERNAME_STORAGE_KEY, username);
      return;
    }
    localStorage.removeItem(AUTH_USERNAME_STORAGE_KEY);
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
