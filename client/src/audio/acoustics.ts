/** Gain and low-pass filtering contributed by world geometry. */
export type AcousticMix = { gain: number; lowpassHz: number };

export const OPEN_AIR_LOWPASS_HZ = 20_000;

/** Clamp an acoustic mix before applying it to Web Audio nodes. */
export function normalizeAcousticMix(mix: AcousticMix): AcousticMix {
  return {
    gain: Math.max(0, Math.min(1, Number.isFinite(mix.gain) ? mix.gain : 1)),
    lowpassHz: Math.max(20, Math.min(OPEN_AIR_LOWPASS_HZ, Number.isFinite(mix.lowpassHz) ? mix.lowpassHz : OPEN_AIR_LOWPASS_HZ)),
  };
}

/** Smoothly apply an acoustic cutoff without clicks during movement. */
export function applyAcousticLowpass(audioCtx: AudioContext, filter: BiquadFilterNode, lowpassHz: number): void {
  filter.frequency.setTargetAtTime(
    Math.max(20, Math.min(OPEN_AIR_LOWPASS_HZ, lowpassHz)),
    audioCtx.currentTime,
    0.02,
  );
}
