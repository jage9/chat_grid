// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { SettingsStore } from './settingsStore';
import { resolveMainModeCommand } from '../input/mainCommandRouter';

beforeEach(() => localStorage.clear());
describe('HRTF preference and shortcut', () => {
  it('defaults to standard and remembers either choice', () => {
    const settings = new SettingsStore();
    expect(settings.loadSpatialMode()).toBe('standard');
    settings.saveSpatialMode('hrtf');
    expect(new SettingsStore().loadSpatialMode()).toBe('hrtf');
    settings.saveSpatialMode('standard');
    expect(new SettingsStore().loadSpatialMode()).toBe('standard');
  });
  it('keeps plain 4 for world audio and assigns Shift+4 to HRTF', () => {
    expect(resolveMainModeCommand('Digit4', false)).toBe('toggleWorldLayer');
    expect(resolveMainModeCommand('Digit4', true)).toBe('toggleHrtf');
  });
});
