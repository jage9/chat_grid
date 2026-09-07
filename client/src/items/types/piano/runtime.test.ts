import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcousticMix } from '../../../audio/acoustics';
import type { PianoSpatialSource } from '../../../audio/pianoSynth';
import type { SpatialAudioPosition } from '../../../audio/audioEngine';
import type { WorldItem } from '../../../state/gameState';
import { PianoController } from './runtime';

const piano = vi.hoisted(() => {
  class MockPianoSynth {
    static instances: MockPianoSynth[] = [];
    noteOn = vi.fn();
    noteOff = vi.fn();
    updateSpatialAudio = vi.fn();

    constructor() {
      MockPianoSynth.instances.push(this);
    }
  }
  return { MockPianoSynth };
});

vi.mock('../../../audio/pianoSynth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../audio/pianoSynth')>()),
  PianoSynth: piano.MockPianoSynth,
}));

function createItem(): WorldItem {
  return {
    id: 'piano-1',
    type: 'piano',
    title: 'Piano',
    x: 4,
    y: 5,
    z: 40,
    createdBy: 'owner',
    updatedBy: 'owner',
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    capabilities: [],
    params: { instrument: 'piano', voiceMode: 'poly', emitRange: 15 },
    occupiedOffsets: [{ x: 0, y: 0 }],
  };
}

function setup() {
  const item = createItem();
  const items = new Map([[item.id, item]]);
  const listener: SpatialAudioPosition = { x: 0, y: 0, z: 0, acousticZoneId: 'floor:0' };
  let updateSpatialAudio = () => {};
  const transmission: AcousticMix = { gain: 0.25, lowpassHz: 900 };
  const audio = {
    ensureContext: vi.fn(async () => undefined),
    context: {} as AudioContext,
    getOutputDestinationNode: vi.fn(() => ({} as AudioNode)),
    registerSpatialUpdater: vi.fn((update: () => void) => {
      updateSpatialAudio = update;
      return vi.fn();
    }),
    resolveSpatialTransmission: vi.fn((_source: SpatialAudioPosition, _listener: SpatialAudioPosition) => transmission),
    sfxUiBlip: vi.fn(),
    sfxUiCancel: vi.fn(),
  };
  const state = {
    mode: 'normal' as const,
    items,
    player: { id: 'listener', x: listener.x, y: listener.y, z: listener.z, acousticZoneId: listener.acousticZoneId },
  };
  const controller = new PianoController({
    state,
    audio,
    signalingSend: vi.fn(),
    updateStatus: vi.fn(),
    openHelpViewer: vi.fn(),
    getWallAcousticMix: vi.fn(() => ({ gain: 1, lowpassHz: 20_000 })),
  });
  return { audio, controller, item, items, listener, transmission, updateSpatialAudio };
}

beforeEach(() => {
  piano.MockPianoSynth.instances = [];
  vi.stubGlobal('window', { setTimeout, clearTimeout });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PianoController spatial audio', () => {
  it('routes remote notes across floors through the shared transmission resolver', () => {
    const { audio, controller, item, listener, transmission } = setup();
    controller.playRemoteNote({
      itemId: item.id,
      senderId: 'remote',
      keyId: 'KeyA',
      midi: 60,
      instrument: 'piano',
      voiceMode: 'poly',
      octave: 0,
      attack: 10,
      decay: 40,
      release: 30,
      brightness: 50,
      x: item.x,
      y: item.y,
      z: item.z,
      emitRange: 15,
    });

    expect(audio.resolveSpatialTransmission).toHaveBeenCalledWith(
      { x: item.x, y: item.y, z: item.z, acousticZoneId: 'floor:40' },
      listener,
    );
    const synth = piano.MockPianoSynth.instances[0]!;
    const spatial = synth.noteOn.mock.calls[0]?.[10] as PianoSpatialSource;
    expect(spatial.acousticGain).toBe(transmission.gain);
    expect(spatial.occlusionLowpassHz).toBe(transmission.lowpassHz);
    expect(spatial.x).toBe(item.x - listener.x);
    expect(spatial.z).toBe(item.z - listener.z);
  });

  it('updates a remote voice after its item moves and mutes it when the item is deleted', () => {
    const { controller, item, items, updateSpatialAudio } = setup();
    controller.playRemoteNote({
      itemId: item.id,
      senderId: 'remote',
      keyId: 'KeyA',
      midi: 60,
      instrument: 'piano',
      voiceMode: 'poly',
      octave: 0,
      attack: 10,
      decay: 40,
      release: 30,
      brightness: 50,
      x: item.x,
      y: item.y,
      z: item.z,
      emitRange: 15,
    });
    const synth = piano.MockPianoSynth.instances[0]!;
    const spatial = synth.noteOn.mock.calls[0]?.[10] as PianoSpatialSource;
    item.x = 8;
    updateSpatialAudio();
    expect(spatial.getPosition?.()).toMatchObject({ x: 8, y: item.y, z: item.z });
    items.delete(item.id);
    expect(spatial.getPosition?.()).toBeNull();
    expect(synth.updateSpatialAudio).toHaveBeenCalledWith(
      expect.objectContaining({ x: 0, y: 0, z: 0, acousticZoneId: 'floor:0' }),
      expect.any(Function),
    );
  });

  it('keeps played notes on shared transmission while previews stay local', async () => {
    const { audio, controller, item } = setup();
    await controller.startUseMode(item.id);
    controller.handleModeInput({ code: 'KeyA', key: 'a', ctrlKey: false, shiftKey: false });
    const synth = piano.MockPianoSynth.instances[0]!;
    let spatial = synth.noteOn.mock.calls[synth.noteOn.mock.calls.length - 1]?.[10] as PianoSpatialSource;
    expect(spatial.useTransmission).toBe(true);
    expect(audio.resolveSpatialTransmission).toHaveBeenCalled();

    controller.onPreviewPropertyChange(item, 'attack', 30);
    await Promise.resolve();
    await Promise.resolve();
    spatial = synth.noteOn.mock.calls[synth.noteOn.mock.calls.length - 1]?.[10] as PianoSpatialSource;
    expect(spatial.useTransmission).toBe(false);
  });
});
