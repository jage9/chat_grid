import { describe, expect, it, vi } from 'vitest';
import type { WorldItem } from '../state/gameState';
import { AudioEngine } from './audioEngine';
import { RadioStationRuntime } from './radioStationRuntime';

function item(overrides: Partial<WorldItem> = {}): WorldItem {
  return {
    id: 'radio-1',
    type: 'radio_station',
    title: 'Radio',
    x: 0,
    y: 0,
    z: 0,
    createdBy: 'user-1',
    updatedBy: 'user-1',
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    capabilities: [],
    occupiedOffsets: [{ x: 0, y: 0 }],
    params: { streamUrl: 'https://example.test/stream' },
    ...overrides,
  };
}

describe('radio station subscription range', () => {
  it('includes vertical separation when deciding whether to preload a radio', async () => {
    const ensureContext = vi.fn();
    const runtime = new RadioStationRuntime(
      { ensureContext } as unknown as AudioEngine,
      () => ({ range: 10, directional: false, facingDeg: 0 }),
    );
    await runtime.sync([item()], { x: 0, y: 0, z: 16 });
    expect(ensureContext).not.toHaveBeenCalled();
    await runtime.sync([item()], { x: 0, y: 0, z: 14 });
    expect(ensureContext).toHaveBeenCalledOnce();
  });
});
