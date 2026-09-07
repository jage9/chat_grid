import { describe, expect, it } from 'vitest';
import { nextHeartbeatState } from './reconnectPolicy';

describe('heartbeat policy', () => {
  it('tolerates one missed pong but declares two consecutive misses stale', () => {
    const first = nextHeartbeatState(0, false);
    expect(first).toEqual({ missedPongs: 1, stale: false });
    expect(nextHeartbeatState(first.missedPongs, false)).toEqual({ missedPongs: 2, stale: true });
  });

  it.each([0, 1, 2])('resets %i misses on a pong and starts a fresh streak', (misses) => {
    const reset = nextHeartbeatState(misses, true);
    expect(reset).toEqual({ missedPongs: 0, stale: false });
    expect(nextHeartbeatState(reset.missedPongs, false)).toEqual({ missedPongs: 1, stale: false });
  });
});
