/** Formats one server presence timestamp for compact spoken user-list output. */
export function formatLastSeen(lastSeenAt: number | null, online = false, now = Date.now()): string {
  if (online) return 'last seen now';
  if (lastSeenAt === null || !Number.isFinite(lastSeenAt) || lastSeenAt <= 0) return 'last seen unknown';

  const elapsedSeconds = Math.max(0, Math.floor((now - lastSeenAt) / 1000));
  if (elapsedSeconds < 60) return 'last seen just now';
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `last seen ${elapsedMinutes} ${elapsedMinutes === 1 ? 'minute' : 'minutes'} ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `last seen ${elapsedHours} ${elapsedHours === 1 ? 'hour' : 'hours'} ago`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  return `last seen ${elapsedDays} ${elapsedDays === 1 ? 'day' : 'days'} ago`;
}
