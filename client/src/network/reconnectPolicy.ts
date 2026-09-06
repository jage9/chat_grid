/** Returns the base wait before a 1-indexed reconnect attempt. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(2_000 * 2 ** Math.min(attempt - 1, 5), 60_000);
}

/** Applies up to 15% jitter using a supplied random value between zero and one. */
export function jitterReconnectDelayMs(baseDelayMs: number, randomValue: number): number {
  return Math.round(baseDelayMs * (0.85 + randomValue * 0.3));
}

/** Short-delay retries stay quiet after the first attempt's announcement. */
export function shouldAnnounceReconnect(baseDelayMs: number): boolean {
  return baseDelayMs >= 16_000;
}

/** A pong breaks the streak; two consecutive missed intervals are stale. */
export function nextHeartbeatState(missedPongs: number, receivedPong: boolean): {
  missedPongs: number;
  stale: boolean;
} {
  const nextMissedPongs = receivedPong ? 0 : missedPongs + 1;
  return { missedPongs: nextMissedPongs, stale: nextMissedPongs >= 2 };
}
