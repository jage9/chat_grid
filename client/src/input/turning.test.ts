import { describe, expect, it } from 'vitest';
import { resolveMainModeCommand } from './mainCommandRouter';
import { getAvailableMainModeCommands, type MainModeCommandAvailabilityContext } from './mainModeCommands';

const availability: MainModeCommandAvailabilityContext = {
  hrtfEnabled: false, voiceSendAllowed: true, mainHelpAvailable: true,
  hasAdminActions: false, hasWorldBuilder: false, itemTypeCount: 0,
  visibleItemCount: 0, userCount: 0, chatMessageCount: 0, hasCarriedItem: false,
  squareItemCount: 0, usableItemCount: 0, manageableItemCount: 0,
  hasEditableItemTarget: false, hasInspectableItemTarget: false,
};

describe('turning and effects shortcuts', () => {
  it.each([false, true])('opens effects with Shift+E when HRTF is %s', (hrtf) => {
    expect(resolveMainModeCommand('KeyE', true, hrtf)).toBe('openEffectSelect');
    const commands = getAvailableMainModeCommands({ ...availability, hrtfEnabled: hrtf });
    expect(commands.find((command) => command.id === 'openEffectSelect')?.shortcut).toBe('Shift+E');
  });

  it('binds unshifted Q/E and exposes turning commands only in HRTF', () => {
    expect(resolveMainModeCommand('KeyQ', false, true)).toBe('turnLeft');
    expect(resolveMainModeCommand('KeyE', false, true)).toBe('turnRight');
    expect(resolveMainModeCommand('KeyQ', false, false)).toBeNull();
    expect(resolveMainModeCommand('KeyE', false, false)).toBeNull();
    expect(resolveMainModeCommand('KeyQ', true, true)).toBeNull();
    expect(getAvailableMainModeCommands(availability).some((command) => command.id === 'turnLeft')).toBe(false);
    const commands = getAvailableMainModeCommands({ ...availability, hrtfEnabled: true });
    expect(commands.find((command) => command.id === 'turnLeft')?.shortcut).toBe('Q');
    expect(commands.find((command) => command.id === 'turnRight')?.shortcut).toBe('E');
  });
});
