import { describe, expect, it } from 'vitest';
import { withAppBase } from './appPath';

describe('withAppBase', () => {
  it('resolves paths under a mount URL ending in a slash', () => {
    expect(withAppBase('/sounds/step.ogg', 'https://example.test/grid/'))
      .toBe('/grid/sounds/step.ogg');
  });

  it('resolves paths under a mounted index.html URL', () => {
    expect(withAppBase('client_branding.json', 'https://example.test/grid/index.html'))
      .toBe('/grid/client_branding.json');
  });

  it.each(['/', '/chgrid/', '/ttgrid/'])('keeps instance routes under %s', mount => {
    for (const route of ['ws', 'auth/session/set', 'auth/session/clear', 'media_proxy.php', 'sounds/a.ogg?v=1']) {
      expect(withAppBase(route, `https://example.test${mount}`)).toBe(mount + route);
    }
  });
});
