import { resolveSpatialMix } from './spatial';

export const PIANO_INSTRUMENT_OPTIONS = [
  'piano',
  'electric_piano',
  'guitar',
  'organ',
  'bass',
  'violin',
  'synth_lead',
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
    releaseScale: 1,
    vibrato: { rateHz: 6.8, depthCents: 9 },
  },
  nintendo: {
    oscillators: [
      { type: 'square', gain: 1 },
      { type: 'square', detune: 8, gain: 0.16 },
    ],
    filter: { type: 'lowpass', frequency: 5200, q: 1.2 },
    gain: 0.22,
    sustainRatio: 0.62,
    releaseScale: 0.65,
  },
};

export const DEFAULT_ENVELOPE_BY_INSTRUMENT: Record<PianoInstrumentId, { attack: number; decay: number }> = {
  piano: { attack: 15, decay: 45 },
  electric_piano: { attack: 12, decay: 40 },
  guitar: { attack: 8, decay: 35 },
  organ: { attack: 25, decay: 70 },
  bass: { attack: 10, decay: 35 },
  violin: { attack: 22, decay: 75 },
  synth_lead: { attack: 6, decay: 30 },
  nintendo: { attack: 2, decay: 28 },
  drum_kit: { attack: 1, decay: 22 },
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

type DrumVariant = 'kick_808' | 'snare' | 'clap' | 'hat_closed' | 'hat_open' | 'tom_low' | 'tom_high' | 'noise_8bit';
const DRUM_VARIANTS: DrumVariant[] = ['kick_808', 'snare', 'clap', 'hat_closed', 'hat_open', 'tom_low', 'tom_high', 'noise_8bit'];

export class PianoSynth {
  private readonly voices = new Map<string, VoiceRuntime>();
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
    midi: number,
    instrument: PianoInstrumentId,
    attackPercent: number,
    decayPercent: number,
    context: PianoContext,
    spatial: PianoSpatialSource,
  ): void {
    if (this.voices.has(keyId)) return;
    if (instrument === 'drum_kit') {
      this.playDrumHit(keyId, midi, context, spatial, attackPercent, decayPercent);
      return;
    }

    const preset = PRESETS[instrument] ?? PRESETS.piano;
    const now = context.audioCtx.currentTime;
    const attackSeconds = attackPercentToSeconds(attackPercent);
    const decaySeconds = decayPercentToSeconds(decayPercent);
    const releaseSeconds = Math.max(0.02, decaySeconds * (preset.releaseScale ?? 1));

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
    voiceGain.gain.exponentialRampToValueAtTime(peakGain, now + attackSeconds);
    voiceGain.gain.exponentialRampToValueAtTime(sustainGain, now + attackSeconds + decaySeconds * 0.6);

    let tailNode: AudioNode = voiceGain;
    if (preset.filter) {
      const filter = context.audioCtx.createBiquadFilter();
      filter.type = preset.filter.type;
      filter.frequency.setValueAtTime(preset.filter.frequency, now);
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
    });
  }

  /** Releases one active note tied to a keyboard key id. */
  noteOff(keyId: string): void {
    const voice = this.voices.get(keyId);
    if (!voice) return;
    this.voices.delete(keyId);
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
    keyId: string,
    midi: number,
    context: PianoContext,
    spatial: PianoSpatialSource,
    attackPercent: number,
    decayPercent: number,
  ): void {
    const now = context.audioCtx.currentTime;
    const spatialMix = resolveSpatialMix({
      dx: spatial.x,
      dy: spatial.y,
      range: spatial.range,
      baseGain: 1,
    });
    if (!spatialMix || spatialMix.gain <= 0) return;
    const typeIndex = Math.abs((midi % DRUM_VARIANTS.length) + this.hashKey(keyId)) % DRUM_VARIANTS.length;
    const variant = DRUM_VARIANTS[typeIndex];
    const decaySeconds = 0.03 + decayPercentToSeconds(decayPercent) * 0.5;
    const attackSeconds = Math.max(0.001, attackPercentToSeconds(attackPercent) * 0.18);

    const gain = context.audioCtx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.22 * spatialMix.gain, now + attackSeconds);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + decaySeconds);

    let tailNode: AudioNode = gain;
    if (typeof context.audioCtx.createStereoPanner === 'function') {
      const panner = context.audioCtx.createStereoPanner();
      panner.pan.setValueAtTime(spatialMix.pan, now);
      tailNode.connect(panner).connect(context.destination);
      tailNode = panner;
    } else {
      tailNode.connect(context.destination);
    }

    if (variant === 'kick_808') {
      this.playKick808(context, gain, now, decaySeconds);
      return;
    }
    if (variant === 'tom_low') {
      this.playTom(context, gain, now, 120, 68, decaySeconds * 0.95);
      return;
    }
    if (variant === 'tom_high') {
      this.playTom(context, gain, now, 220, 125, decaySeconds * 0.8);
      return;
    }
    if (variant === 'hat_closed') {
      this.playNoiseDrum(context, gain, now, decaySeconds * 0.25, 'highpass', 6500, false);
      return;
    }
    if (variant === 'hat_open') {
      this.playNoiseDrum(context, gain, now, decaySeconds * 0.8, 'highpass', 5200, false);
      return;
    }
    if (variant === 'noise_8bit') {
      this.playNoiseDrum(context, gain, now, decaySeconds * 0.45, 'bandpass', 2700, true);
      return;
    }
    if (variant === 'clap') {
      this.playClap(context, gain, now, decaySeconds);
      return;
    }
    this.playSnare(context, gain, now, decaySeconds);
  }

  /** 808-like kick: deep sine sweep with long-ish tail. */
  private playKick808(context: PianoContext, gain: GainNode, now: number, decaySeconds: number): void {
    const kick = context.audioCtx.createOscillator();
    kick.type = 'sine';
    kick.frequency.setValueAtTime(160, now);
    kick.frequency.exponentialRampToValueAtTime(42, now + Math.max(0.07, decaySeconds * 0.95));
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
  private playSnare(context: PianoContext, gain: GainNode, now: number, decaySeconds: number): void {
    const tone = context.audioCtx.createOscillator();
    tone.type = 'triangle';
    tone.frequency.setValueAtTime(220, now);
    tone.frequency.exponentialRampToValueAtTime(130, now + Math.max(0.03, decaySeconds * 0.45));
    const toneGain = context.audioCtx.createGain();
    toneGain.gain.setValueAtTime(0.45, now);
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

  /** Returns deterministic hash for key ids to map drum voice variants. */
  private hashKey(value: string): number {
    let out = 0;
    for (let index = 0; index < value.length; index += 1) {
      out = ((out << 5) - out + value.charCodeAt(index)) | 0;
    }
    return out;
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
