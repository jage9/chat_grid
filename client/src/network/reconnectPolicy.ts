/** A pong breaks the streak; two consecutive missed intervals are stale. */
export function nextHeartbeatState(missedPongs: number, receivedPong: boolean): {
  missedPongs: number;
  stale: boolean;
} {
  const nextMissedPongs = receivedPong ? 0 : missedPongs + 1;
  return { missedPongs: nextMissedPongs, stale: nextMissedPongs >= 2 };
}
