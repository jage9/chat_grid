import { describe, expect, it, vi } from 'vitest';
import type { GameMode } from '../state/gameState';
import { createAdminController } from './adminController';

function createDeps() {
  return {
    state: {
      mode: 'normal' as GameMode,
      nicknameInput: '',
      cursorPos: 0,
    },
    signalingSend: vi.fn(),
    announceMenuEntry: vi.fn(),
    updateStatus: vi.fn(),
    sfxUiBlip: vi.fn(),
    sfxUiCancel: vi.fn(),
    applyTextInputEdit: vi.fn(),
    setReplaceTextOnNextType: vi.fn(),
  };
}

describe('admin controller registered-user list', () => {
  it('opens the read-only list from the server-authored Shift+Z action', () => {
    const deps = createDeps();
    const controller = createAdminController(deps);
    controller.setServerAdminMenuActions([
      {
        id: 'list_users',
        label: 'List users',
        tooltip: 'List registered users.',
      },
    ]);

    controller.openAdminMenu();
    expect(deps.announceMenuEntry).toHaveBeenCalledWith('Users', 'List users');

    controller.handleAdminMenuModeInput('Enter', 'Enter');
    expect(deps.signalingSend).toHaveBeenCalledWith({ type: 'admin_users_list' });

    controller.handleAdminUsersList({
      type: 'admin_users_list',
      users: [
        {
          id: 'user-1',
          username: 'alpha',
          role: 'user',
          status: 'active',
          lastSeenAt: 1_800_000_000_000,
          online: true,
        },
      ],
    });
    expect(deps.state.mode).toBe('adminUserList');
    expect(deps.announceMenuEntry).toHaveBeenLastCalledWith('Users', 'alpha, user, active, last seen now');

    controller.handleAdminUserListModeInput('Enter', 'Enter');
    expect(deps.signalingSend).toHaveBeenCalledTimes(1);
  });
});
