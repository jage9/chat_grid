import { describe, expect, it } from 'vitest';

import { formatLastSeen } from './lastSeen';

describe('formatLastSeen', () => {
  const now = 1_800_000_000_000;

  it('reports connected users as present now', () => {
    expect(formatLastSeen(now - 60_000, true, now)).toBe('last seen now');
  });

  it('formats offline presence as relative time', () => {
    expect(formatLastSeen(now - 5 * 60_000, false, now)).toBe('last seen 5 minutes ago');
    expect(formatLastSeen(now - 2 * 60 * 60_000, false, now)).toBe('last seen 2 hours ago');
    expect(formatLastSeen(now - 3 * 24 * 60 * 60_000, false, now)).toBe('last seen 3 days ago');
  });
});
