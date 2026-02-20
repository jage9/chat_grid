export type EffectId = 'reverb' | 'echo' | 'flanger' | 'high_pass' | 'low_pass' | 'off';

export type EffectPreset = { id: EffectId; label: string; defaultValue: number };

export const EFFECT_SEQUENCE: EffectPreset[] = [
  { id: 'reverb', label: 'Reverb', defaultValue: 50 },
  { id: 'echo', label: 'Echo', defaultValue: 50 },
  { id: 'flanger', label: 'Flanger', defaultValue: 50 },
  { id: 'high_pass', label: 'High Pass', defaultValue: 50 },
  { id: 'low_pass', label: 'Low Pass', defaultValue: 50 },
  { id: 'off', label: 'Off', defaultValue: 0 },
];

export const EFFECT_IDS = new Set<EffectId>(EFFECT_SEQUENCE.map((effect) => effect.id));

export type EffectRuntime = {
  nodes: AudioNode[];
  flangerLfo: OscillatorNode | null;
  flangerLfoGain: GainNode | null;
};

export function clampEffectLevel(value: number): number {
  const clamped = Math.max(0, Math.min(100, value));
  return Math.round(clamped / 5) * 5;
}

export function disconnectEffectRuntime(runtime: EffectRuntime | null): void {
  if (!runtime) return;
  for (const node of runtime.nodes) {
    node.disconnect();
  }
  if (runtime.flangerLfo) {
    runtime.flangerLfo.stop();
    runtime.flangerLfo.disconnect();
  }
  runtime.flangerLfoGain?.disconnect();
}

export function connectEffectChain(
  audioCtx: AudioContext,
  input: AudioNode,
  destination: AudioNode,
  effect: EffectId,
  effectValue: number,
): EffectRuntime {
  const runtime: EffectRuntime = {
    nodes: [],
    flangerLfo: null,
    flangerLfoGain: null,
  };
  const effectMix = clampEffectLevel(effectValue) / 100;

  if (effect === 'off') {
    input.connect(destination);
    return runtime;
  }

  if (effect === 'high_pass' || effect === 'low_pass') {
    const filter = audioCtx.createBiquadFilter();
    filter.type = effect === 'high_pass' ? 'highpass' : 'lowpass';
    if (effect === 'high_pass') {
      filter.frequency.value = 120 + effectMix * 7000;
    } else {
      filter.frequency.value = 7800 - effectMix * 7600;
    }
    filter.Q.value = 0.7 + effectMix * 8;
    input.connect(filter);
    filter.connect(destination);
    runtime.nodes.push(filter);
    return runtime;
  }

  if (effect === 'echo') {
    const delay = audioCtx.createDelay(1);
    delay.delayTime.value = 0.04 + effectMix * 0.76;
    const feedback = audioCtx.createGain();
    feedback.gain.value = 0.04 + effectMix * 0.88;
    const wetGain = audioCtx.createGain();
    wetGain.gain.value = 0.08 + effectMix * 0.92;
    const dryGain = audioCtx.createGain();
    dryGain.gain.value = 1 - effectMix * 0.85;

    input.connect(dryGain);
    dryGain.connect(destination);
    input.connect(delay);
    delay.connect(wetGain);
    wetGain.connect(destination);
    delay.connect(feedback);
    feedback.connect(delay);

    runtime.nodes.push(delay, feedback, wetGain, dryGain);
    return runtime;
  }

  if (effect === 'reverb') {
    const convolver = audioCtx.createConvolver();
    convolver.buffer = createImpulseResponse(audioCtx, 0.4 + effectMix * 4.2, 1 + effectMix * 3.6);
    const wetGain = audioCtx.createGain();
    wetGain.gain.value = 0.06 + effectMix * 0.94;
    const dryGain = audioCtx.createGain();
    dryGain.gain.value = 1 - effectMix * 0.8;

    input.connect(dryGain);
    dryGain.connect(destination);
    input.connect(convolver);
    convolver.connect(wetGain);
    wetGain.connect(destination);

    runtime.nodes.push(convolver, wetGain, dryGain);
    return runtime;
  }

  const delay = audioCtx.createDelay(0.05);
  delay.delayTime.value = 0.0005 + effectMix * 0.012;
  const feedback = audioCtx.createGain();
  feedback.gain.value = 0.04 + effectMix * 0.9;
  const wetGain = audioCtx.createGain();
  wetGain.gain.value = 0.05 + effectMix * 0.95;
  const dryGain = audioCtx.createGain();
  dryGain.gain.value = 1 - effectMix * 0.82;

  const lfo = audioCtx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 0.05 + effectMix * 1.8;
  const lfoGain = audioCtx.createGain();
  lfoGain.gain.value = 0.0002 + effectMix * 0.015;

  lfo.connect(lfoGain);
  lfoGain.connect(delay.delayTime);
  lfo.start();

  input.connect(dryGain);
  dryGain.connect(destination);
  input.connect(delay);
  delay.connect(wetGain);
  wetGain.connect(destination);
  delay.connect(feedback);
  feedback.connect(delay);

  runtime.flangerLfo = lfo;
  runtime.flangerLfoGain = lfoGain;
  runtime.nodes.push(delay, feedback, wetGain, lfoGain, dryGain);
  return runtime;
}

function createImpulseResponse(audioCtx: AudioContext, duration: number, decay: number): AudioBuffer {
  const length = Math.floor(audioCtx.sampleRate * duration);
  const impulse = audioCtx.createBuffer(2, length, audioCtx.sampleRate);
  for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
    const data = impulse.getChannelData(channel);
    for (let i = 0; i < length; i += 1) {
      const noise = Math.random() * 2 - 1;
      data[i] = noise * Math.pow(1 - i / length, decay);
    }
  }
  return impulse;
}
