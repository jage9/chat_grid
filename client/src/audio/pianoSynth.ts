import { resolveSpatialMix } from './spatial';

export const PIANO_INSTRUMENT_OPTIONS = [
  'piano',
  'electric_piano',
  'guitar',
  'organ',
  'bass',
  'violin',
  'synth_lead',
  'brass',
  'nintendo',
  'drum_kit',
] as const;

export type PianoInstrumentId = (typeof PIANO_INSTRUMENT_OPTIONS)[number];

type VoiceRuntime = {
  gain: GainNode;
  panner: StereoPannerNode | null;
  oscillators: OscillatorNode[];
  modulators: OscillatorNode[];
  releaseSeconds: number;
  sourceGroupId: string;
};

type PianoContext = {
  audioCtx: AudioContext;
  destination: AudioNode;
};

type PianoSpatialSource = {
  x: number;
  y: number;
  range: number;
};

type InstrumentPreset = {
  oscillators: Array<{ type: OscillatorType; detune?: number; gain?: number; ratio?: number }>;
  filter?: { type: BiquadFilterType; frequency: number; q?: number };
  gain: number;
  sustainRatio?: number;
  holdSustain?: boolean;
  releaseScale?: number;
  vibrato?: { rateHz: number; depthCents: number };
};

const PRESETS: Record<Exclude<PianoInstrumentId, 'drum_kit'>, InstrumentPreset> = {
  piano: {
    oscillators: [
      { type: 'triangle', gain: 1 },
      { type: 'sine', ratio: 2, gain: 0.28 },
    ],
    filter: { type: 'lowpass', frequency: 5200, q: 0.7 },
    gain: 0.32,
    sustainRatio: 0.5,
    holdSustain: false,
    releaseScale: 0.9,
  },
  electric_piano: {
    oscillators: [
      { type: 'sine', gain: 1 },
      { type: 'triangle', detune: 5, gain: 0.35 },
    ],
    filter: { type: 'lowpass', frequency: 4200, q: 0.8 },
    gain: 0.3,
    sustainRatio: 0.52,
    holdSustain: false,
    releaseScale: 0.8,
  },
  guitar: {
    oscillators: [
      { type: 'triangle', gain: 1 },
      { type: 'sawtooth', detune: -3, gain: 0.2 },
    ],
    filter: { type: 'lowpass', frequency: 3200, q: 0.9 },
    gain: 0.24,
    sustainRatio: 0.48,
    holdSustain: false,
    releaseScale: 0.7,
  },
  organ: {
    oscillators: [
      { type: 'square', gain: 0.8 },
      { type: 'sine', ratio: 2, gain: 0.28 },
      { type: 'sine', ratio: 3, gain: 0.2 },
    ],
    filter: { type: 'lowpass', frequency: 6500, q: 0.6 },
    gain: 0.18,
    sustainRatio: 0.72,
    holdSustain: true,
    releaseScale: 1.4,
  },
  bass: {
    oscillators: [
      { type: 'sawtooth', gain: 0.9 },
      { type: 'square', ratio: 0.5, gain: 0.25 },
    ],
    filter: { type: 'lowpass', frequency: 1500, q: 1.1 },
    gain: 0.28,
    sustainRatio: 0.45,
    holdSustain: false,
    releaseScale: 0.9,
  },
  violin: {
    oscillators: [
      { type: 'sawtooth', gain: 0.8 },
      { type: 'triangle', detune: 3, gain: 0.35 },
    ],
    filter: { type: 'lowpass', frequency: 3600, q: 1.0 },
    gain: 0.24,
    sustainRatio: 0.68,
    holdSustain: true,
    releaseScale: 1.5,
    vibrato: { rateHz: 5.7, depthCents: 12 },
  },
  synth_lead: {
    oscillators: [
      { type: 'sawtooth', gain: 0.85 },
      { type: 'square', detune: 6, gain: 0.3 },
    ],
    filter: { type: 'lowpass', frequency: 5400, q: 0.9 },
    gain: 0.2,
    sustainRatio: 0.6,
    holdSustain: true,
    releaseScale: 1,
    vibrato: { rateHz: 6.8, depthCents: 9 },
  },
  brass: {
    oscillators: [
      { type: 'sawtooth', gain: 0.72 },
      { type: 'square', ratio: 2, gain: 0.2 },
    ],
    filter: { type: 'lowpass', frequency: 3300, q: 1.05 },
    gain: 0.22,
    sustainRatio: 0.62,
    holdSustain: true,
    releaseScale: 0.92,
    vibrato: { rateHz: 5.1, depthCents: 5 },
  },
  nintendo: {
    oscillators: [
      { type: 'square', gain: 1 },
      { type: 'square', detune: 2, gain: 0.08 },
    ],
    filter: { type: 'lowpass', frequency: 5200, q: 1.2 },
    gain: 0.22,
    sustainRatio: 0.62,
    holdSustain: true,
    releaseScale: 0.65,
  },
};

export const DEFAULT_PIANO_SETTINGS_BY_INSTRUMENT: Record<
  PianoInstrumentId,
  { attack: number; decay: number; release: number; brightness: number }
> = {
  piano: { attack: 15, decay: 45, release: 35, brightness: 55 },
  electric_piano: { attack: 12, decay: 40, release: 30, brightness: 62 },
  guitar: { attack: 8, decay: 35, release: 25, brightness: 50 },
  organ: { attack: 25, decay: 70, release: 45, brightness: 48 },
  bass: { attack: 2, decay: 24, release: 18, brightness: 34 },
  violin: { attack: 22, decay: 75, release: 55, brightness: 58 },
  synth_lead: { attack: 6, decay: 30, release: 22, brightness: 72 },
  brass: { attack: 10, decay: 45, release: 30, brightness: 60 },
  nintendo: { attack: 1, decay: 24, release: 15, brightness: 85 },
  drum_kit: { attack: 1, decay: 22, release: 12, brightness: 68 },
};

/** Maps 0..100 control values to note attack seconds. */
function attackPercentToSeconds(value: number): number {
  const clamped = Math.max(0, Math.min(100, value));
  return 0.002 + (clamped / 100) * 0.6;
}

/** Maps 0..100 control values to note decay/release seconds. */
function decayPercentToSeconds(value: number): number {
  const clamped = Math.max(0, Math.min(100, value));
  return 0.05 + (clamped / 100) * 2.7;
}

/** Maps 0..100 control values to release tail seconds after note-off. */
function releasePercentToSeconds(value: number): number {
  const clamped = Math.max(0, Math.min(100, value));
  return 0.03 + (clamped / 100) * 3.4;
}

/** Maps 0..100 control values to low-pass filter brightness multiplier. */
function brightnessPercentToMultiplier(value: number): number {
  const clamped = Math.max(0, Math.min(100, value));
  return 0.45 + (clamped / 100) * 1.55;
}

/** Maps midi note number to one deterministic drum voice variant. */
function drumVariantForMidi(midi: number): DrumVariant {
  const palette: DrumVariant[] = [
    'kick_sub',
    'kick_punch',
    'snare_tight',
    'snare_body',
    'hat_closed',
    'hat_open',
    'tom_low',
    'tom_mid',
    'tom_high',
    'clap',
    'pow_mid',
    'pow_high',
    'snare_noise',
    'noise_8bit',
  ];
  const index = ((Math.round(midi) % palette.length) + palette.length) % palette.length;
  return palette[index];
}

/** Converts midi note number to frequency in hertz. */
function midiToFrequency(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Small helper to safely stop audio nodes. */
function safeStop(oscillator: OscillatorNode, when: number): void {
  try {
    oscillator.stop(when);
  } catch {
    // Ignore already-stopped oscillators.
  }
}

type DrumVariant =
  | 'kick_sub'
  | 'kick_punch'
  | 'snare_tight'
  | 'snare_body'
  | 'snare_noise'
  | 'clap'
  | 'hat_closed'
  | 'hat_open'
  | 'tom_low'
  | 'tom_mid'
  | 'tom_high'
  | 'pow_mid'
  | 'pow_high'
  | 'noise_8bit';

export class PianoSynth {
  private readonly voices = new Map<string, VoiceRuntime>();
  private readonly activeVoiceKeysByGroup = new Map<string, Set<string>>();
  private readonly drumNoiseBuffers = new WeakMap<AudioContext, AudioBuffer>();
  private readonly bitNoiseBuffers = new WeakMap<AudioContext, AudioBuffer>();

  /** Stops and disconnects all active notes. */
  stopAll(): void {
    for (const key of Array.from(this.voices.keys())) {
      this.noteOff(key);
    }
  }

  /** Starts one note for a specific keyboard key id. */
  noteOn(
    keyId: string,
    sourceGroupId: string,
    midi: number,
    instrument: PianoInstrumentId,
    voiceMode: 'mono' | 'poly',
    attackPercent: number,
    decayPercent: number,
    releasePercent: number,
    brightnessPercent: number,
    context: PianoContext,
    spatial: PianoSpatialSource,
  ): void {
    if (this.voices.has(keyId)) return;
    if (voiceMode === 'mono') {
      const previousKeys = this.activeVoiceKeysByGroup.get(sourceGroupId);
      if (previousKeys) {
        for (const previousKey of Array.from(previousKeys)) {
          this.noteOff(previousKey);
        }
      }
    }
    if (instrument === 'drum_kit') {
      this.playDrumHit(midi, context, spatial, attackPercent, decayPercent, releasePercent, brightnessPercent);
      return;
    }

    const preset = PRESETS[instrument] ?? PRESETS.piano;
    const now = context.audioCtx.currentTime;
    const attackSeconds = attackPercentToSeconds(attackPercent);
    const decaySeconds = decayPercentToSeconds(decayPercent);
    const releaseSeconds = Math.max(0.02, releasePercentToSeconds(releasePercent) * (preset.releaseScale ?? 1));

    const spatialMix = resolveSpatialMix({
      dx: spatial.x,
      dy: spatial.y,
      range: spatial.range,
      baseGain: 1,
    });
    if (!spatialMix || spatialMix.gain <= 0) return;

    const voiceGain = context.audioCtx.createGain();
    voiceGain.gain.setValueAtTime(0.0001, now);
    const peakGain = Math.max(0.0001, preset.gain * spatialMix.gain);
    const sustainGain = Math.max(0.0001, peakGain * (preset.sustainRatio ?? 0.55));
    const holdsSustain = preset.holdSustain !== false;
    voiceGain.gain.exponentialRampToValueAtTime(peakGain, now + attackSeconds);
    if (holdsSustain) {
      voiceGain.gain.exponentialRampToValueAtTime(sustainGain, now + attackSeconds + decaySeconds * 0.6);
    } else {
      // Struck/plucked timbres naturally decay even if the key remains held.
      voiceGain.gain.exponentialRampToValueAtTime(0.0001, now + attackSeconds + decaySeconds);
    }

    let tailNode: AudioNode = voiceGain;
    if (preset.filter) {
      const filter = context.audioCtx.createBiquadFilter();
      filter.type = preset.filter.type;
      filter.frequency.setValueAtTime(preset.filter.frequency * brightnessPercentToMultiplier(brightnessPercent), now);
      filter.Q.setValueAtTime(preset.filter.q ?? 0.7, now);
      voiceGain.connect(filter);
      tailNode = filter;
    }

    let panner: StereoPannerNode | null = null;
    if (typeof context.audioCtx.createStereoPanner === 'function') {
      panner = context.audioCtx.createStereoPanner();
      panner.pan.setValueAtTime(spatialMix.pan, now);
      tailNode.connect(panner).connect(context.destination);
    } else {
      tailNode.connect(context.destination);
    }

    const frequency = midiToFrequency(midi);
    const oscillators: OscillatorNode[] = [];
    const modulators: OscillatorNode[] = [];
    for (const partial of preset.oscillators) {
      const oscillator = context.audioCtx.createOscillator();
      oscillator.type = partial.type;
      oscillator.frequency.setValueAtTime(frequency * (partial.ratio ?? 1), now);
      oscillator.detune.setValueAtTime(partial.detune ?? 0, now);
      const oscGain = context.audioCtx.createGain();
      oscGain.gain.setValueAtTime(partial.gain ?? 1, now);
      oscillator.connect(oscGain).connect(voiceGain);
      oscillator.start(now);
      oscillators.push(oscillator);
      if (preset.vibrato) {
        const lfo = context.audioCtx.createOscillator();
        const lfoGain = context.audioCtx.createGain();
        lfo.frequency.setValueAtTime(preset.vibrato.rateHz, now);
        lfoGain.gain.setValueAtTime(preset.vibrato.depthCents, now);
        lfo.connect(lfoGain).connect(oscillator.detune);
        lfo.start(now);
        modulators.push(lfo);
      }
    }

    this.voices.set(keyId, {
      gain: voiceGain,
      panner,
      oscillators,
      modulators,
      releaseSeconds,
      sourceGroupId,
    });
    const groupKeys = this.activeVoiceKeysByGroup.get(sourceGroupId) ?? new Set<string>();
    groupKeys.add(keyId);
    this.activeVoiceKeysByGroup.set(sourceGroupId, groupKeys);
  }

  /** Releases one active note tied to a keyboard key id. */
  noteOff(keyId: string): void {
    const voice = this.voices.get(keyId);
    if (!voice) return;
    this.voices.delete(keyId);
    const groupKeys = this.activeVoiceKeysByGroup.get(voice.sourceGroupId);
    if (groupKeys) {
      groupKeys.delete(keyId);
      if (groupKeys.size === 0) {
        this.activeVoiceKeysByGroup.delete(voice.sourceGroupId);
      } else {
        this.activeVoiceKeysByGroup.set(voice.sourceGroupId, groupKeys);
      }
    }
    const now = voice.gain.context.currentTime;
    const currentGain = Math.max(0.0001, voice.gain.gain.value);
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(currentGain, now);
    voice.gain.gain.exponentialRampToValueAtTime(0.0001, now + voice.releaseSeconds);
    for (const oscillator of voice.oscillators) {
      safeStop(oscillator, now + voice.releaseSeconds + 0.02);
    }
    for (const oscillator of voice.modulators) {
      safeStop(oscillator, now + voice.releaseSeconds + 0.02);
    }
    window.setTimeout(() => {
      try {
        voice.gain.disconnect();
      } catch {
        // Ignore stale disconnects.
      }
      if (voice.panner) {
        try {
          voice.panner.disconnect();
        } catch {
          // Ignore stale disconnects.
        }
      }
    }, Math.max(60, Math.round((voice.releaseSeconds + 0.04) * 1000)));
  }

  /** Plays one synthesized drum hit for drum-kit instrument mode. */
  private playDrumHit(
    midi: number,
    context: PianoContext,
    spatial: PianoSpatialSource,
    attackPercent: number,
    decayPercent: number,
    releasePercent: number,
    brightnessPercent: number,
  ): void {
    const now = context.audioCtx.currentTime;
    const spatialMix = resolveSpatialMix({
      dx: spatial.x,
      dy: spatial.y,
      range: spatial.range,
      baseGain: 1,
    });
    if (!spatialMix || spatialMix.gain <= 0) return;
    const variant = drumVariantForMidi(midi);
    const midiOffset = (Math.round(midi) - 60) / 24;
    const decaySeconds = 0.03 + decayPercentToSeconds(decayPercent) * 0.5;
    const releaseSeconds = 0.02 + releasePercentToSeconds(releasePercent) * 0.35;
    const attackSeconds = Math.max(0.001, attackPercentToSeconds(attackPercent) * 0.18);
    const brightnessMultiplier = brightnessPercentToMultiplier(brightnessPercent);

    const gain = context.audioCtx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.22 * spatialMix.gain, now + attackSeconds);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + decaySeconds);

    if (typeof context.audioCtx.createStereoPanner === 'function') {
      const panner = context.audioCtx.createStereoPanner();
      panner.pan.setValueAtTime(spatialMix.pan, now);
      gain.connect(panner).connect(context.destination);
    } else {
      gain.connect(context.destination);
    }

    if (variant === 'kick_sub') {
      this.playKick808(context, gain, now, (decaySeconds + releaseSeconds * 0.35) * 1.15, 145, 36);
      return;
    }
    if (variant === 'kick_punch') {
      this.playKick808(context, gain, now, decaySeconds + releaseSeconds * 0.2, 185, 52);
      return;
    }
    if (variant === 'snare_tight') {
      this.playSnare(context, gain, now, decaySeconds * 0.55 + releaseSeconds * 0.08, 0.75);
      return;
    }
    if (variant === 'snare_body') {
      this.playSnare(context, gain, now, decaySeconds * 0.92 + releaseSeconds * 0.18, 1);
      return;
    }
    if (variant === 'snare_noise') {
      this.playSnare(context, gain, now, decaySeconds * 0.8 + releaseSeconds * 0.15, 0.45);
      this.playNoiseDrum(context, gain, now, decaySeconds * 0.75, 'highpass', 1900 * brightnessMultiplier, true);
      return;
    }
    if (variant === 'tom_low') {
      this.playTom(context, gain, now, 120, 70, decaySeconds * 0.95 + releaseSeconds * 0.2);
      return;
    }
    if (variant === 'tom_mid') {
      this.playTom(context, gain, now, 175, 100, decaySeconds * 0.86 + releaseSeconds * 0.16);
      return;
    }
    if (variant === 'tom_high') {
      this.playTom(context, gain, now, 250, 138, decaySeconds * 0.78 + releaseSeconds * 0.14);
      return;
    }
    if (variant === 'hat_closed') {
      this.playNoiseDrum(context, gain, now, decaySeconds * 0.25, 'highpass', 6500 * brightnessMultiplier, false);
      return;
    }
    if (variant === 'hat_open') {
      this.playNoiseDrum(context, gain, now, decaySeconds * 0.8 + releaseSeconds * 0.2, 'highpass', 5200 * brightnessMultiplier, false);
      return;
    }
    if (variant === 'clap') {
      this.playClap(context, gain, now, decaySeconds + releaseSeconds * 0.1);
      return;
    }
    if (variant === 'pow_mid') {
      this.playPowDown(context, gain, now, 310 + midiOffset * 30, 150 + midiOffset * 15, decaySeconds * 0.95 + releaseSeconds * 0.15);
      return;
    }
    if (variant === 'pow_high') {
      this.playPowDown(context, gain, now, 420 + midiOffset * 40, 210 + midiOffset * 22, decaySeconds * 0.88 + releaseSeconds * 0.12);
      return;
    }
    if (variant === 'noise_8bit') {
      this.playNoiseDrum(context, gain, now, decaySeconds * 0.45, 'bandpass', 2700 * brightnessMultiplier, true);
      return;
    }
    this.playSnare(context, gain, now, decaySeconds + releaseSeconds * 0.12, 1);
  }

  /** 808-like kick: deep sine sweep with long-ish tail. */
  private playKick808(
    context: PianoContext,
    gain: GainNode,
    now: number,
    decaySeconds: number,
    startHz: number,
    endHz: number,
  ): void {
    const kick = context.audioCtx.createOscillator();
    kick.type = 'sine';
    kick.frequency.setValueAtTime(startHz, now);
    kick.frequency.exponentialRampToValueAtTime(endHz, now + Math.max(0.07, decaySeconds * 0.95));
    const body = context.audioCtx.createGain();
    body.gain.setValueAtTime(1, now);
    body.gain.exponentialRampToValueAtTime(0.0001, now + Math.max(0.08, decaySeconds));
    kick.connect(body).connect(gain);
    kick.start(now);
    safeStop(kick, now + Math.max(0.1, decaySeconds) + 0.05);
  }

  /** Simple tom synthesis with tuned sine drop. */
  private playTom(context: PianoContext, gain: GainNode, now: number, startHz: number, endHz: number, decaySeconds: number): void {
    const tom = context.audioCtx.createOscillator();
    tom.type = 'sine';
    tom.frequency.setValueAtTime(startHz, now);
    tom.frequency.exponentialRampToValueAtTime(endHz, now + Math.max(0.05, decaySeconds * 0.85));
    const body = context.audioCtx.createGain();
    body.gain.setValueAtTime(1, now);
    body.gain.exponentialRampToValueAtTime(0.0001, now + Math.max(0.07, decaySeconds));
    tom.connect(body).connect(gain);
    tom.start(now);
    safeStop(tom, now + Math.max(0.1, decaySeconds) + 0.04);
  }

  /** White-noise percussion core used by hats/snare/noise blips. */
  private playNoiseDrum(
    context: PianoContext,
    gain: GainNode,
    now: number,
    decaySeconds: number,
    filterType: BiquadFilterType,
    filterHz: number,
    bitStyle: boolean,
  ): void {
    const noise = context.audioCtx.createBufferSource();
    noise.buffer = bitStyle ? this.getBitNoiseBuffer(context.audioCtx) : this.getNoiseBuffer(context.audioCtx);
    const noiseFilter = context.audioCtx.createBiquadFilter();
    noiseFilter.type = filterType;
    noiseFilter.frequency.setValueAtTime(filterHz, now);
    noise.connect(noiseFilter).connect(gain);
    noise.start(now);
    safeStop(noise, now + Math.max(0.02, decaySeconds) + 0.03);
  }

  /** Snare: short tone + filtered noise burst. */
  private playSnare(context: PianoContext, gain: GainNode, now: number, decaySeconds: number, toneLevel: number): void {
    const tone = context.audioCtx.createOscillator();
    tone.type = 'triangle';
    tone.frequency.setValueAtTime(220, now);
    tone.frequency.exponentialRampToValueAtTime(130, now + Math.max(0.03, decaySeconds * 0.45));
    const toneGain = context.audioCtx.createGain();
    toneGain.gain.setValueAtTime(0.45 * Math.max(0, toneLevel), now);
    toneGain.gain.exponentialRampToValueAtTime(0.0001, now + Math.max(0.04, decaySeconds * 0.55));
    tone.connect(toneGain).connect(gain);
    tone.start(now);
    safeStop(tone, now + Math.max(0.06, decaySeconds * 0.6) + 0.03);
    this.playNoiseDrum(context, gain, now, decaySeconds * 0.65, 'highpass', 1800, false);
  }

  /** Clap: layered short filtered noise bursts. */
  private playClap(context: PianoContext, gain: GainNode, now: number, decaySeconds: number): void {
    const burstTimes = [0, 0.018, 0.035];
    for (const burstOffset of burstTimes) {
      const noise = context.audioCtx.createBufferSource();
      noise.buffer = this.getNoiseBuffer(context.audioCtx);
      const filter = context.audioCtx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(2100, now + burstOffset);
      const burstGain = context.audioCtx.createGain();
      burstGain.gain.setValueAtTime(0.0001, now + burstOffset);
      burstGain.gain.exponentialRampToValueAtTime(0.85, now + burstOffset + 0.002);
      burstGain.gain.exponentialRampToValueAtTime(0.0001, now + burstOffset + Math.max(0.03, decaySeconds * 0.25));
      noise.connect(filter).connect(burstGain).connect(gain);
      noise.start(now + burstOffset);
      safeStop(noise, now + burstOffset + Math.max(0.05, decaySeconds * 0.32));
    }
  }

  /** Retro game-like downward-bending midrange hit for drum fills. */
  private playPowDown(context: PianoContext, gain: GainNode, now: number, startHz: number, endHz: number, decaySeconds: number): void {
    const osc = context.audioCtx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(startHz, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(35, endHz), now + Math.max(0.04, decaySeconds * 0.9));
    const amp = context.audioCtx.createGain();
    amp.gain.setValueAtTime(0.75, now);
    amp.gain.exponentialRampToValueAtTime(0.0001, now + Math.max(0.06, decaySeconds));
    const filter = context.audioCtx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1700, now);
    filter.Q.setValueAtTime(1.2, now);
    osc.connect(filter).connect(amp).connect(gain);
    osc.start(now);
    safeStop(osc, now + Math.max(0.08, decaySeconds) + 0.03);
  }

  /** Returns or lazily builds short white-noise buffer for percussion synthesis. */
  private getNoiseBuffer(audioCtx: AudioContext): AudioBuffer {
    const existing = this.drumNoiseBuffers.get(audioCtx);
    if (existing) return existing;
    const length = Math.max(1, Math.floor(audioCtx.sampleRate * 0.5));
    const buffer = audioCtx.createBuffer(1, length, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < length; index += 1) {
      data[index] = Math.random() * 2 - 1;
    }
    this.drumNoiseBuffers.set(audioCtx, buffer);
    return buffer;
  }

  /** Returns quantized 8-bit style noise buffer for retro percussion. */
  private getBitNoiseBuffer(audioCtx: AudioContext): AudioBuffer {
    const existing = this.bitNoiseBuffers.get(audioCtx);
    if (existing) return existing;
    const length = Math.max(1, Math.floor(audioCtx.sampleRate * 0.45));
    const buffer = audioCtx.createBuffer(1, length, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    let held = 0;
    for (let index = 0; index < length; index += 1) {
      if (index % 16 === 0) {
        const raw = Math.random() * 2 - 1;
        held = Math.round(raw * 8) / 8;
      }
      data[index] = held;
    }
    this.bitNoiseBuffers.set(audioCtx, buffer);
    return buffer;
  }
}
