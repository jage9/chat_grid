import { describe, expect, it } from 'vitest';
import {
  jitterReconnectDelayMs,
  nextHeartbeatState,
  reconnectDelayMs,
  shouldAnnounceReconnect,
} from './reconnectPolicy';

describe('reconnect policy', () => {
  it.each([
    [1, 2_000], [2, 4_000], [3, 8_000], [4, 16_000],
    [5, 32_000], [6, 60_000], [7, 60_000], [100, 60_000], [10_000, 60_000],
  ])('waits %i attempts into the schedule for %i ms', (attempt, delay) => {
    expect(reconnectDelayMs(attempt)).toBe(delay);
  });

  it.each([2_000, 60_000])('applies deterministic jitter to %i ms', (delay) => {
    expect(jitterReconnectDelayMs(delay, 0)).toBe(delay * 0.85);
    expect(jitterReconnectDelayMs(delay, 0.5)).toBe(delay);
    expect(jitterReconnectDelayMs(delay, 1)).toBe(Math.round(delay * 1.15));
  });

  it.each([
    [2_000, false], [4_000, false], [8_000, false], [15_999, false],
    [16_000, true], [32_000, true], [60_000, true],
  ])('announces a base delay of %i ms: %s', (delay, expected) => {
    expect(shouldAnnounceReconnect(delay)).toBe(expected);
  });

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
