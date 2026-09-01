import { describe, expect, it, vi } from 'vitest';
import { type AudioEngine } from './audioEngine';
import { WorldAudioRouter } from './worldAudio';

function createAudioMock() {
  return {
    setSpatialTransmissionResolver: vi.fn(),
    playSpatialSample: vi.fn(async () => undefined),
    playSpatialSampleAndWait: vi.fn(async () => undefined),
  } as unknown as AudioEngine;
}

const listener = { x: 1, y: 2, z: 0, acousticZoneId: 'elevator:car-1' };
const source = { x: 3, y: 4, z: 0, acousticZoneId: 'floor:0' };

describe('WorldAudioRouter', () => {
  it('suppresses every world one-shot when its source zone is isolated', () => {
    const audio = createAudioMock();
    const router = new WorldAudioRouter(
      audio,
      () => listener,
      () => true,
      () => ({ gain: 0, lowpassHz: 800 }),
      () => false,
    );

    router.playSample('/sounds/step-1.ogg', source);

    expect(audio.playSpatialSample).not.toHaveBeenCalled();
  });

  it('passes audible sources through the shared positional engine', () => {
    const audio = createAudioMock();
    const router = new WorldAudioRouter(
      audio,
      () => listener,
      () => true,
      () => ({ gain: 0.4, lowpassHz: 800 }),
      () => true,
    );

    router.playSample('/sounds/step-1.ogg', { ...source, gain: 0.7, range: 12 });

    expect(audio.playSpatialSample).toHaveBeenCalledWith(
      '/sounds/step-1.ogg',
      { ...source, gain: 0.7, range: 12 },
      listener,
      0.7,
      12,
    );
  });

  it('starts a landing sample at zero rider transmission so an opening door can reveal it', () => {
    const audio = createAudioMock();
    const router = new WorldAudioRouter(
      audio,
      () => listener,
      () => true,
      () => ({ gain: 0, lowpassHz: 800 }),
      () => true,
    );

    router.playSample('/sounds/elevator_open.ogg', source);

    expect(audio.playSpatialSample).toHaveBeenCalled();
  });

  it('suppresses every world one-shot when the world layer is disabled', () => {
    const audio = createAudioMock();
    const router = new WorldAudioRouter(
      audio,
      () => listener,
      () => false,
      () => ({ gain: 1, lowpassHz: 20_000 }),
      () => true,
    );

    router.playSample('/sounds/step-1.ogg', source);

    expect(audio.playSpatialSample).not.toHaveBeenCalled();
  });
});
