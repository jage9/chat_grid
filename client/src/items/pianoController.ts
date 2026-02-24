import {
  DEFAULT_PIANO_SETTINGS_BY_INSTRUMENT,
  PIANO_INSTRUMENT_OPTIONS,
  PianoSynth,
  type PianoInstrumentId,
} from '../audio/pianoSynth';
import { type IncomingMessage, type OutgoingMessage } from '../network/protocol';
import { type GameMode, type WorldItem } from '../state/gameState';

const PIANO_WHITE_KEY_MIDI_BY_CODE: Record<string, number> = {
  KeyA: 60,
  KeyS: 62,
  KeyD: 64,
  KeyF: 65,
  KeyG: 67,
  KeyH: 69,
  KeyJ: 71,
  KeyK: 72,
  KeyL: 74,
  Semicolon: 76,
  Quote: 77,
};

const PIANO_SHARP_KEY_MIDI_BY_CODE: Record<string, number> = {
  KeyW: 61,
  KeyE: 63,
  KeyT: 66,
  KeyY: 68,
  KeyU: 70,
  KeyO: 73,
  KeyP: 75,
  BracketRight: 78,
};

type PianoDemoEvent = {
  t: number;
  keyId: string;
  midi: number;
  on: boolean;
  instrument?: string;
  voiceMode?: 'mono' | 'poly';
  attack?: number;
  decay?: number;
  release?: number;
  brightness?: number;
  emitRange?: number;
};

type PianoDemoSong = {
  id: string;
  events: PianoDemoEvent[];
};

type HelpItem = {
  keys: string;
  description: string;
};

type HelpSection = {
  title: string;
  items: HelpItem[];
};

type HelpData = {
  sections: HelpSection[];
};

type PianoControllerDeps = {
  state: {
    mode: GameMode;
    items: Map<string, WorldItem>;
    player: { id: string | null; x: number; y: number };
  };
  audio: {
    ensureContext: () => Promise<void>;
    context: AudioContext | null;
    getOutputDestinationNode: () => AudioNode | null;
    sfxUiBlip: () => void;
    sfxUiCancel: () => void;
  };
  signalingSend: (message: OutgoingMessage) => void;
  updateStatus: (message: string) => void;
  openHelpViewer: (lines: string[], returnMode: GameMode) => void;
};

/** Encapsulates all client-side piano item behavior and per-mode runtime state. */
export class PianoController {
  private readonly deps: PianoControllerDeps;

  private readonly pianoSynth = new PianoSynth();

  private readonly activePianoKeys = new Set<string>();
  private readonly activePianoKeyMidi = new Map<string, number>();
  private readonly activePianoHeldOrder: string[] = [];
  private readonly activePianoDemoTimeoutIds: number[] = [];
  private readonly activePianoDemoNotes = new Map<string, { runtimeKey: string; midi: number }>();
  private readonly activeRemotePianoKeys = new Set<string>();
  private readonly pianoDemoSongs = new Map<string, PianoDemoSong>();

  private helpViewerLines: string[] = [];
  private activePianoItemId: string | null = null;
  private activePianoMonophonicKey: string | null = null;
  private activePianoDemoRunToken = 0;
  private activePianoDemoItemId: string | null = null;
  private pianoDemoDefaultSongId = '';
  private activePianoRecordingState: 'idle' | 'recording' | 'paused' = 'idle';
  private pianoPreviewTimeoutId: number | null = null;

  constructor(deps: PianoControllerDeps) {
    this.deps = deps;
  }

  /** Loads piano-mode help content and stores a flattened line view for `?` help while using piano. */
  async loadHelpFromUrl(url: string): Promise<void> {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) {
        return;
      }
      const help = (await response.json()) as HelpData;
      if (!Array.isArray(help.sections) || help.sections.length === 0) {
        return;
      }
      this.helpViewerLines = this.buildHelpLines(help);
    } catch {
      // Keep piano help unavailable if loading fails.
    }
  }

  /** Loads compact piano demo songs used by Enter-key demo playback while in piano mode. */
  async loadDemoFromUrl(url: string): Promise<void> {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) {
        return;
      }
      const data = (await response.json()) as {
        defaultSongId?: unknown;
        songs?: unknown;
      };
      this.pianoDemoSongs.clear();
      this.pianoDemoDefaultSongId = '';

      if (data.songs && typeof data.songs === 'object') {
        const songs = data.songs as Record<string, unknown>;
        for (const [songId, rawSong] of Object.entries(songs)) {
          if (!rawSong || typeof rawSong !== 'object') continue;
          const song = rawSong as Record<string, unknown>;
          const meta = song.meta as Record<string, unknown> | undefined;
          const states = Array.isArray(song.states) ? song.states : [];
          const keys = Array.isArray(song.keys) ? song.keys.filter((value): value is string => typeof value === 'string') : [];
          const compactEvents = Array.isArray(song.events) ? song.events : [];
          const events: PianoDemoEvent[] = [];
          const resolveState = (stateIndex: number): Partial<PianoDemoEvent> => {
            if (stateIndex < 0 || stateIndex >= states.length) {
              return {};
            }
            const row = states[stateIndex];
            if (!Array.isArray(row) || row.length < 7) {
              return {};
            }
            return {
              instrument: typeof row[0] === 'string' ? row[0] : undefined,
              voiceMode: row[1] === 'mono' ? 'mono' : row[1] === 'poly' ? 'poly' : undefined,
              attack: typeof row[2] === 'number' ? Math.max(0, Math.min(100, Math.round(row[2]))) : undefined,
              decay: typeof row[3] === 'number' ? Math.max(0, Math.min(100, Math.round(row[3]))) : undefined,
              release: typeof row[4] === 'number' ? Math.max(0, Math.min(100, Math.round(row[4]))) : undefined,
              brightness: typeof row[5] === 'number' ? Math.max(0, Math.min(100, Math.round(row[5]))) : undefined,
              emitRange: typeof row[6] === 'number' ? Math.max(5, Math.min(20, Math.round(row[6]))) : undefined,
            };
          };
          for (const compact of compactEvents) {
            if (!Array.isArray(compact) || compact.length < 4) continue;
            const [rawT, rawKeyIdx, rawMidi, rawOn, rawStateIdx] = compact;
            if (typeof rawT !== 'number' || typeof rawKeyIdx !== 'number' || typeof rawMidi !== 'number') continue;
            const keyId = keys[Math.max(0, Math.round(rawKeyIdx))];
            if (!keyId) continue;
            const eventState = typeof rawStateIdx === 'number' ? resolveState(Math.round(rawStateIdx)) : {};
            events.push({
              t: Math.max(0, Math.round(rawT)),
              keyId: keyId.slice(0, 32),
              midi: Math.max(0, Math.min(127, Math.round(rawMidi))),
              on: Boolean(rawOn),
              instrument: eventState.instrument ?? (typeof meta?.instrument === 'string' ? meta.instrument : undefined),
              voiceMode: eventState.voiceMode ?? (meta?.voiceMode === 'mono' ? 'mono' : meta?.voiceMode === 'poly' ? 'poly' : undefined),
              attack:
                eventState.attack ??
                (Number.isFinite(Number(meta?.attack)) ? Math.max(0, Math.min(100, Math.round(Number(meta?.attack)))) : undefined),
              decay:
                eventState.decay ??
                (Number.isFinite(Number(meta?.decay)) ? Math.max(0, Math.min(100, Math.round(Number(meta?.decay)))) : undefined),
              release:
                eventState.release ??
                (Number.isFinite(Number(meta?.release)) ? Math.max(0, Math.min(100, Math.round(Number(meta?.release)))) : undefined),
              brightness:
                eventState.brightness ??
                (Number.isFinite(Number(meta?.brightness)) ? Math.max(0, Math.min(100, Math.round(Number(meta?.brightness)))) : undefined),
              emitRange:
                eventState.emitRange ??
                (Number.isFinite(Number(meta?.emitRange)) ? Math.max(5, Math.min(20, Math.round(Number(meta?.emitRange)))) : undefined),
            });
          }
          events.sort((a, b) => a.t - b.t);
          if (events.length > 0) {
            this.pianoDemoSongs.set(songId, { id: songId, events });
          }
        }
        const preferredId = String(data.defaultSongId ?? '').trim();
        if (preferredId && this.pianoDemoSongs.has(preferredId)) {
          this.pianoDemoDefaultSongId = preferredId;
        } else {
          this.pianoDemoDefaultSongId = this.pianoDemoSongs.keys().next().value ?? '';
        }
      }
    } catch {
      // Demo remains unavailable if loading/parsing fails.
    }
  }

  /** Starts local piano key mode for one used piano item. */
  async startUseMode(itemId: string): Promise<void> {
    const item = this.deps.state.items.get(itemId);
    if (!item || item.type !== 'piano') return;
    this.activePianoItemId = itemId;
    this.activePianoKeys.clear();
    this.activePianoKeyMidi.clear();
    this.activePianoHeldOrder.length = 0;
    this.activePianoMonophonicKey = null;
    this.activePianoRecordingState = 'idle';
    this.deps.state.mode = 'pianoUse';
    await this.deps.audio.ensureContext();
    this.deps.updateStatus(`using ${item.title}, press question mark for help.`);
    this.deps.audio.sfxUiBlip();
  }

  /** Exits local piano key mode and releases any held notes. */
  stopUseMode(announce = true): void {
    if (!this.activePianoItemId) return;
    this.stopDemo(true);
    const itemId = this.activePianoItemId;
    for (const code of Array.from(this.activePianoKeys)) {
      const midi = this.activePianoKeyMidi.get(code);
      if (!Number.isFinite(midi)) continue;
      this.deps.signalingSend({ type: 'item_piano_note', itemId, keyId: code, midi, on: false });
      this.pianoSynth.noteOff(code);
    }
    this.activePianoItemId = null;
    this.activePianoKeys.clear();
    this.activePianoKeyMidi.clear();
    this.activePianoHeldOrder.length = 0;
    this.activePianoMonophonicKey = null;
    this.activePianoRecordingState = 'idle';
    this.deps.state.mode = 'normal';
    if (announce) {
      this.deps.updateStatus('Stopped piano.');
      this.deps.audio.sfxUiCancel();
    }
  }

  /** Handles realtime keyboard performance while piano item mode is active. */
  handleModeInput(code: string): void {
    if (code === 'Escape') {
      this.stopUseMode(true);
      return;
    }
    if (code === 'Slash') {
      this.deps.openHelpViewer(this.helpViewerLines, 'pianoUse');
      return;
    }
    const itemId = this.activePianoItemId;
    if (!itemId) {
      this.deps.state.mode = 'normal';
      return;
    }
    const item = this.deps.state.items.get(itemId);
    if (!item || item.type !== 'piano') {
      this.stopUseMode(false);
      return;
    }
    if (code === 'Enter') {
      if (this.activePianoRecordingState !== 'idle') {
        this.deps.updateStatus('Stop or pause recording first.');
        this.deps.audio.sfxUiCancel();
        return;
      }
      this.deps.signalingSend({ type: 'item_piano_recording', itemId, action: 'stop_playback' });
      this.startDemo(item, itemId);
      this.deps.updateStatus('demo play');
      this.deps.audio.sfxUiBlip();
      return;
    }
    if (code === 'KeyZ') {
      this.deps.signalingSend({ type: 'item_piano_recording', itemId, action: 'toggle_record' });
      return;
    }
    if (code === 'KeyX') {
      if (this.activePianoRecordingState !== 'idle') {
        this.deps.updateStatus('Stop or pause recording first.');
        this.deps.audio.sfxUiCancel();
        return;
      }
      this.stopDemo(true);
      this.deps.signalingSend({ type: 'item_piano_recording', itemId, action: 'playback' });
      return;
    }
    if (code === 'KeyC') {
      this.stopDemo(true);
      this.deps.signalingSend({ type: 'item_piano_recording', itemId, action: 'stop_playback' });
      this.deps.signalingSend({ type: 'item_piano_recording', itemId, action: 'stop_record' });
      this.activePianoRecordingState = 'idle';
      return;
    }
    if (code === 'Equal' || code === 'Minus') {
      const current = this.getPianoParams(item).octave;
      const next = Math.max(-2, Math.min(2, current + (code === 'Equal' ? 1 : -1)));
      item.params.octave = next;
      this.deps.signalingSend({ type: 'item_update', itemId, params: { octave: next } });
      this.deps.updateStatus(`octave ${next}.`);
      return;
    }
    if (code.startsWith('Digit')) {
      const digit = Number(code.slice(5));
      const instrumentIndex = digit === 0 ? 9 : digit - 1;
      if (Number.isInteger(instrumentIndex) && instrumentIndex >= 0 && instrumentIndex < PIANO_INSTRUMENT_OPTIONS.length) {
        const instrument = PIANO_INSTRUMENT_OPTIONS[instrumentIndex];
        if (instrument) {
          const defaults = DEFAULT_PIANO_SETTINGS_BY_INSTRUMENT[instrument];
          const voiceMode = this.defaultsVoiceModeForInstrument(instrument);
          const octave = this.defaultsOctaveForInstrument(instrument);
          item.params.instrument = instrument;
          item.params.voiceMode = voiceMode;
          item.params.octave = octave;
          item.params.attack = defaults.attack;
          item.params.decay = defaults.decay;
          item.params.release = defaults.release;
          item.params.brightness = defaults.brightness;
          this.deps.signalingSend({
            type: 'item_update',
            itemId,
            params: {
              instrument,
            },
          });
          void this.previewSettingChange(item, {
            instrument,
            octave,
            attack: defaults.attack,
            decay: defaults.decay,
            release: defaults.release,
            brightness: defaults.brightness,
          });
          this.deps.updateStatus(`Instrument ${instrument}.`);
        }
        return;
      }
    }

    const midi = this.getPianoMidiForCode(code);
    if (midi === null) return;
    if (this.activePianoKeys.has(code)) return;
    const config = this.getPianoParams(item);
    const playedMidi = Math.max(0, Math.min(127, midi + config.octave * 12));
    this.activePianoKeys.add(code);
    this.activePianoKeyMidi.set(code, playedMidi);
    this.activePianoHeldOrder.push(code);
    if (config.voiceMode === 'mono') {
      const previousCode = this.activePianoMonophonicKey;
      if (previousCode && previousCode !== code) {
        const previousMidi = this.activePianoKeyMidi.get(previousCode);
        this.pianoSynth.noteOff(previousCode);
        if (Number.isFinite(previousMidi)) {
          this.deps.signalingSend({ type: 'item_piano_note', itemId, keyId: previousCode, midi: previousMidi, on: false });
        }
      }
      this.activePianoMonophonicKey = code;
    }
    this.playLocalNote(item, itemId, code, playedMidi, config);
  }

  /** Handles key release while in piano mode, including mono fallback retrigger behavior. */
  handleModeKeyUp(code: string): void {
    if (!this.activePianoKeys.delete(code)) return;
    const orderIndex = this.activePianoHeldOrder.lastIndexOf(code);
    if (orderIndex >= 0) {
      this.activePianoHeldOrder.splice(orderIndex, 1);
    }
    const itemId = this.activePianoItemId;
    const midi = this.activePianoKeyMidi.get(code);
    this.activePianoKeyMidi.delete(code);
    if (!itemId || !Number.isFinite(midi)) {
      this.pianoSynth.noteOff(code);
      if (this.activePianoMonophonicKey === code) {
        this.activePianoMonophonicKey = null;
      }
      return;
    }
    const item = this.deps.state.items.get(itemId);
    if (!item || item.type !== 'piano') {
      this.pianoSynth.noteOff(code);
      if (this.activePianoMonophonicKey === code) {
        this.activePianoMonophonicKey = null;
      }
      return;
    }
    const config = this.getPianoParams(item);
    if (config.voiceMode !== 'mono') {
      this.pianoSynth.noteOff(code);
      this.deps.signalingSend({ type: 'item_piano_note', itemId, keyId: code, midi, on: false });
      return;
    }
    if (this.activePianoMonophonicKey !== code) {
      return;
    }
    this.pianoSynth.noteOff(code);
    this.deps.signalingSend({ type: 'item_piano_note', itemId, keyId: code, midi, on: false });
    const fallbackCode = this.activePianoHeldOrder[this.activePianoHeldOrder.length - 1] ?? null;
    if (!fallbackCode) {
      this.activePianoMonophonicKey = null;
      return;
    }
    const fallbackMidi = this.activePianoKeyMidi.get(fallbackCode);
    if (!Number.isFinite(fallbackMidi)) {
      this.activePianoMonophonicKey = null;
      return;
    }
    this.activePianoMonophonicKey = fallbackCode;
    this.playLocalNote(item, itemId, fallbackCode, fallbackMidi, config);
  }

  /** Plays one inbound piano note from another user using item spatial position. */
  playRemoteNote(note: {
    itemId: string;
    senderId: string;
    keyId: string;
    midi: number;
    instrument: string;
    voiceMode: 'mono' | 'poly';
    octave: number;
    attack: number;
    decay: number;
    release: number;
    brightness: number;
    x: number;
    y: number;
    emitRange: number;
  }): void {
    const ctx = this.deps.audio.context;
    const destination = this.deps.audio.getOutputDestinationNode();
    if (!ctx || !destination) return;
    const runtimeKey = `${note.senderId}:${note.itemId}:${note.keyId}`;
    if (this.activeRemotePianoKeys.has(runtimeKey)) return;
    if (note.voiceMode === 'mono') {
      this.stopRemoteNotesForSource(note.senderId, note.itemId);
    }
    this.activeRemotePianoKeys.add(runtimeKey);
    this.pianoSynth.noteOn(
      runtimeKey,
      `remote:${note.senderId}:${note.itemId}`,
      Math.max(0, Math.min(127, Math.round(note.midi))),
      this.normalizePianoInstrument(note.instrument),
      note.voiceMode,
      Math.max(0, Math.min(100, Math.round(note.attack))),
      Math.max(0, Math.min(100, Math.round(note.decay))),
      Math.max(0, Math.min(100, Math.round(note.release))),
      Math.max(0, Math.min(100, Math.round(note.brightness))),
      { audioCtx: ctx, destination },
      {
        x: note.x - this.deps.state.player.x,
        y: note.y - this.deps.state.player.y,
        range: Math.max(1, Math.round(note.emitRange)),
      },
    );
  }

  /** Stops one inbound piano note previously started for another user. */
  stopRemoteNote(senderId: string, keyId: string): void {
    const prefix = `${senderId}:`;
    for (const runtimeKey of Array.from(this.activeRemotePianoKeys)) {
      if (!runtimeKey.startsWith(prefix) || !runtimeKey.endsWith(`:${keyId}`)) continue;
      this.activeRemotePianoKeys.delete(runtimeKey);
      this.pianoSynth.noteOff(runtimeKey);
    }
  }

  /** Stops all currently active remote piano notes for a sender id. */
  stopAllRemoteNotesForSender(senderId: string): void {
    const prefix = `${senderId}:`;
    for (const runtimeKey of Array.from(this.activeRemotePianoKeys)) {
      if (!runtimeKey.startsWith(prefix)) continue;
      this.activeRemotePianoKeys.delete(runtimeKey);
      this.pianoSynth.noteOff(runtimeKey);
    }
  }

  /** Applies recording-state transitions from successful piano use result messages. */
  onUseResultMessage(message: IncomingMessage): void {
    if (
      message.type !== 'item_action_result' ||
      !message.ok ||
      message.action !== 'use' ||
      typeof message.itemId !== 'string' ||
      !this.activePianoItemId ||
      message.itemId !== this.activePianoItemId
    ) {
      return;
    }
    if (message.message === 'record' || message.message === 'resume') {
      this.activePianoRecordingState = 'recording';
    } else if (message.message === 'pause') {
      this.activePianoRecordingState = 'paused';
    } else if (message.message === 'stop') {
      this.activePianoRecordingState = 'idle';
    }
  }

  /** Exits piano mode if the active piano item disappears from local world state. */
  syncAfterWorldUpdate(): void {
    if (this.activePianoItemId && !this.deps.state.items.has(this.activePianoItemId)) {
      this.stopUseMode(false);
    }
  }

  /** Applies live preview hooks for editable piano properties in item property menus. */
  onPreviewPropertyChange(item: WorldItem, key: string, value: unknown): void {
    if (item.type !== 'piano') return;
    if (key === 'instrument') {
      const instrument = this.normalizePianoInstrument(value);
      const defaults = DEFAULT_PIANO_SETTINGS_BY_INSTRUMENT[instrument];
      const octave = this.defaultsOctaveForInstrument(instrument);
      void this.previewSettingChange(item, {
        instrument,
        octave,
        attack: defaults.attack,
        decay: defaults.decay,
        release: defaults.release,
        brightness: defaults.brightness,
      });
      return;
    }
    if (key === 'attack') {
      const attack = Number(value);
      if (!Number.isFinite(attack)) return;
      void this.previewSettingChange(item, { attack });
      return;
    }
    if (key === 'decay') {
      const decay = Number(value);
      if (!Number.isFinite(decay)) return;
      void this.previewSettingChange(item, { decay });
      return;
    }
    if (key === 'release') {
      const release = Number(value);
      if (!Number.isFinite(release)) return;
      void this.previewSettingChange(item, { release });
      return;
    }
    if (key === 'brightness') {
      const brightness = Number(value);
      if (!Number.isFinite(brightness)) return;
      void this.previewSettingChange(item, { brightness });
      return;
    }
    if (key === 'octave') {
      const octave = Number(value);
      if (!Number.isFinite(octave)) return;
      void this.previewSettingChange(item, { octave });
    }
  }

  /** Stops local/remote piano runtime state and timers, used during disconnect cleanup. */
  cleanup(): void {
    this.stopUseMode(false);
    for (const key of Array.from(this.activeRemotePianoKeys)) {
      this.activeRemotePianoKeys.delete(key);
      this.pianoSynth.noteOff(key);
    }
    if (this.pianoPreviewTimeoutId !== null) {
      window.clearTimeout(this.pianoPreviewTimeoutId);
      this.pianoPreviewTimeoutId = null;
    }
  }

  private buildHelpLines(help: HelpData): string[] {
    const lines: string[] = [];
    for (const section of help.sections) {
      lines.push(section.title);
      for (const item of section.items) {
        lines.push(`${item.keys}: ${item.description}`);
      }
    }
    return lines;
  }

  private getPianoParams(item: WorldItem): {
    instrument: PianoInstrumentId;
    voiceMode: 'mono' | 'poly';
    octave: number;
    attack: number;
    decay: number;
    release: number;
    brightness: number;
    emitRange: number;
  } {
    const rawInstrument = String(item.params.instrument ?? 'piano').trim().toLowerCase();
    const instrument: PianoInstrumentId =
      rawInstrument === 'electric_piano' ||
      rawInstrument === 'guitar' ||
      rawInstrument === 'organ' ||
      rawInstrument === 'bass' ||
      rawInstrument === 'violin' ||
      rawInstrument === 'synth_lead' ||
      rawInstrument === 'brass' ||
      rawInstrument === 'nintendo' ||
      rawInstrument === 'drum_kit'
        ? rawInstrument
        : 'piano';
    const rawAttack = Number(item.params.attack);
    const rawDecay = Number(item.params.decay);
    const rawOctave = Number(item.params.octave);
    const rawVoiceMode = String(item.params.voiceMode ?? this.defaultsVoiceModeForInstrument(instrument)).trim().toLowerCase();
    const rawRelease = Number(item.params.release);
    const rawBrightness = Number(item.params.brightness);
    const rawEmitRange = Number(item.params.emitRange ?? 15);
    const defaults = DEFAULT_PIANO_SETTINGS_BY_INSTRUMENT[instrument];
    return {
      instrument,
      voiceMode: rawVoiceMode === 'mono' ? 'mono' : 'poly',
      octave: Math.max(-2, Math.min(2, Number.isFinite(rawOctave) ? Math.round(rawOctave) : this.defaultsOctaveForInstrument(instrument))),
      attack: Math.max(0, Math.min(100, Number.isFinite(rawAttack) ? Math.round(rawAttack) : defaults.attack)),
      decay: Math.max(0, Math.min(100, Number.isFinite(rawDecay) ? Math.round(rawDecay) : defaults.decay)),
      release: Math.max(0, Math.min(100, Number.isFinite(rawRelease) ? Math.round(rawRelease) : defaults.release)),
      brightness: Math.max(0, Math.min(100, Number.isFinite(rawBrightness) ? Math.round(rawBrightness) : defaults.brightness)),
      emitRange: Math.max(5, Math.min(20, Number.isFinite(rawEmitRange) ? Math.round(rawEmitRange) : 15)),
    };
  }

  private defaultsVoiceModeForInstrument(instrument: PianoInstrumentId): 'mono' | 'poly' {
    if (instrument === 'bass' || instrument === 'violin') return 'mono';
    return 'poly';
  }

  private defaultsOctaveForInstrument(instrument: PianoInstrumentId): number {
    return instrument === 'bass' ? -1 : 0;
  }

  private normalizePianoInstrument(value: unknown): PianoInstrumentId {
    const raw = String(value ?? 'piano').trim().toLowerCase();
    if (raw === 'electric_piano') return 'electric_piano';
    if (raw === 'guitar') return 'guitar';
    if (raw === 'organ') return 'organ';
    if (raw === 'bass') return 'bass';
    if (raw === 'violin') return 'violin';
    if (raw === 'synth_lead') return 'synth_lead';
    if (raw === 'brass') return 'brass';
    if (raw === 'nintendo') return 'nintendo';
    if (raw === 'drum_kit') return 'drum_kit';
    return 'piano';
  }

  private getPianoMidiForCode(code: string): number | null {
    if (code in PIANO_WHITE_KEY_MIDI_BY_CODE) {
      return PIANO_WHITE_KEY_MIDI_BY_CODE[code]!;
    }
    if (code in PIANO_SHARP_KEY_MIDI_BY_CODE) {
      return PIANO_SHARP_KEY_MIDI_BY_CODE[code]!;
    }
    return null;
  }

  private playLocalNote(
    item: WorldItem,
    itemId: string,
    keyId: string,
    midi: number,
    config: ReturnType<PianoController['getPianoParams']>,
    sourceGroupId?: string,
  ): void {
    const ctx = this.deps.audio.context;
    const destination = this.deps.audio.getOutputDestinationNode();
    if (!ctx || !destination) return;
    const sourceX = item.carrierId === this.deps.state.player.id ? this.deps.state.player.x : item.x;
    const sourceY = item.carrierId === this.deps.state.player.id ? this.deps.state.player.y : item.y;
    this.pianoSynth.noteOn(
      keyId,
      sourceGroupId ?? `local:${itemId}`,
      midi,
      config.instrument,
      config.voiceMode,
      config.attack,
      config.decay,
      config.release,
      config.brightness,
      { audioCtx: ctx, destination },
      { x: sourceX - this.deps.state.player.x, y: sourceY - this.deps.state.player.y, range: config.emitRange },
    );
    this.deps.signalingSend({ type: 'item_piano_note', itemId, keyId, midi, on: true });
  }

  private stopDemo(sendNoteOff = true): boolean {
    const hadActiveDemo = this.activePianoDemoNotes.size > 0 || this.activePianoDemoTimeoutIds.length > 0;
    this.activePianoDemoRunToken += 1;
    while (this.activePianoDemoTimeoutIds.length > 0) {
      const timeoutId = this.activePianoDemoTimeoutIds.pop();
      if (typeof timeoutId === 'number') {
        window.clearTimeout(timeoutId);
      }
    }
    const itemId = this.activePianoDemoItemId;
    for (const [logicalKey, note] of Array.from(this.activePianoDemoNotes.entries())) {
      this.pianoSynth.noteOff(note.runtimeKey);
      if (sendNoteOff && itemId) {
        this.deps.signalingSend({ type: 'item_piano_note', itemId, keyId: note.runtimeKey, midi: note.midi, on: false });
      }
      this.activePianoDemoNotes.delete(logicalKey);
    }
    this.activePianoDemoItemId = null;
    return hadActiveDemo;
  }

  private startDemo(item: WorldItem, itemId: string): void {
    this.stopDemo(true);
    const requestedSongId = String(item.params.songId ?? '').trim();
    const songId = (requestedSongId && this.pianoDemoSongs.has(requestedSongId) ? requestedSongId : this.pianoDemoDefaultSongId) || '';
    const song = songId ? this.pianoDemoSongs.get(songId) ?? null : null;
    if (!song || song.events.length === 0) {
      this.deps.updateStatus('No demo loaded.');
      this.deps.audio.sfxUiCancel();
      return;
    }
    const runToken = this.activePianoDemoRunToken;
    this.activePianoDemoItemId = itemId;
    for (const event of song.events) {
      const timeoutId = window.setTimeout(() => {
        if (runToken !== this.activePianoDemoRunToken) return;
        const liveItem = this.deps.state.items.get(itemId);
        if (!liveItem || liveItem.type !== 'piano') return;
        const baseConfig = this.getPianoParams(liveItem);
        const config = {
          instrument: event.instrument ? this.normalizePianoInstrument(event.instrument) : baseConfig.instrument,
          voiceMode: event.voiceMode ?? baseConfig.voiceMode,
          octave: baseConfig.octave,
          attack: event.attack ?? baseConfig.attack,
          decay: event.decay ?? baseConfig.decay,
          release: event.release ?? baseConfig.release,
          brightness: event.brightness ?? baseConfig.brightness,
          emitRange: event.emitRange ?? baseConfig.emitRange,
        } as ReturnType<PianoController['getPianoParams']>;
        const logicalKey = event.keyId;
        const runtimeKey = `__piano_demo_${logicalKey}`;
        if (event.on) {
          if (this.activePianoDemoNotes.has(logicalKey)) return;
          this.activePianoDemoNotes.set(logicalKey, { runtimeKey, midi: event.midi });
          this.playLocalNote(liveItem, itemId, runtimeKey, event.midi, config, `demo:${itemId}`);
        } else {
          const active = this.activePianoDemoNotes.get(logicalKey);
          if (!active) return;
          this.activePianoDemoNotes.delete(logicalKey);
          this.pianoSynth.noteOff(active.runtimeKey);
          this.deps.signalingSend({ type: 'item_piano_note', itemId, keyId: active.runtimeKey, midi: active.midi, on: false });
        }
      }, Math.max(0, Math.round(event.t)));
      this.activePianoDemoTimeoutIds.push(timeoutId);
    }
  }

  private async previewSettingChange(
    item: WorldItem,
    overrides: Partial<{ instrument: PianoInstrumentId; octave: number; attack: number; decay: number; release: number; brightness: number }>,
  ): Promise<void> {
    if (item.type !== 'piano') return;
    await this.deps.audio.ensureContext();
    const ctx = this.deps.audio.context;
    const destination = this.deps.audio.getOutputDestinationNode();
    if (!ctx || !destination) return;
    const current = this.getPianoParams(item);
    const instrument = overrides.instrument ?? current.instrument;
    const octave = Math.max(-2, Math.min(2, Math.round(overrides.octave ?? current.octave)));
    const attack = Math.max(0, Math.min(100, Math.round(overrides.attack ?? current.attack)));
    const decay = Math.max(0, Math.min(100, Math.round(overrides.decay ?? current.decay)));
    const release = Math.max(0, Math.min(100, Math.round(overrides.release ?? current.release)));
    const brightness = Math.max(0, Math.min(100, Math.round(overrides.brightness ?? current.brightness)));
    const sourceX = item.carrierId === this.deps.state.player.id ? this.deps.state.player.x : item.x;
    const sourceY = item.carrierId === this.deps.state.player.id ? this.deps.state.player.y : item.y;
    const previewKeyId = '__piano_preview_c4__';
    this.pianoSynth.noteOff(previewKeyId);
    this.pianoSynth.noteOn(
      previewKeyId,
      'preview',
      Math.max(0, Math.min(127, 60 + octave * 12)),
      instrument,
      current.voiceMode,
      attack,
      decay,
      release,
      brightness,
      { audioCtx: ctx, destination },
      { x: sourceX - this.deps.state.player.x, y: sourceY - this.deps.state.player.y, range: current.emitRange },
    );
    if (this.pianoPreviewTimeoutId !== null) {
      window.clearTimeout(this.pianoPreviewTimeoutId);
    }
    this.pianoPreviewTimeoutId = window.setTimeout(() => {
      this.pianoSynth.noteOff(previewKeyId);
      this.pianoPreviewTimeoutId = null;
    }, 320);
  }

  private stopRemoteNotesForSource(senderId: string, itemId: string): void {
    const prefix = `${senderId}:${itemId}:`;
    for (const runtimeKey of Array.from(this.activeRemotePianoKeys)) {
      if (!runtimeKey.startsWith(prefix)) continue;
      this.activeRemotePianoKeys.delete(runtimeKey);
      this.pianoSynth.noteOff(runtimeKey);
    }
  }
}

