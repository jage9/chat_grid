import { describe, expect, it, vi } from 'vitest';
import type { GameMode } from '../state/gameState';
import { createConfirmationController } from './confirmationController';
import { createOptionSelector } from './optionSelector';

function deps() {
  return {
    state: { mode: 'normal' as GameMode },
    announceMenuEntry: vi.fn(),
    updateStatus: vi.fn(),
    blip: vi.fn(),
    cancel: vi.fn(),
  };
}

describe('shared menu controllers', () => {
  it('selects a current option through the reusable option flow', () => {
    const shared = deps();
    const onSelect = vi.fn();
    const selector = createOptionSelector(shared);
    selector.open({
      title: 'Type',
      options: [{ id: 'brick', label: 'Brick' }, { id: 'glass', label: 'Glass' }],
      selectedId: 'glass',
      onSelect,
      onCancel: vi.fn(),
    });

    expect(shared.state.mode).toBe('optionSelect');
    expect(shared.announceMenuEntry).toHaveBeenCalledWith('Type', 'Glass');
    selector.handleInput('Enter', 'Enter');
    expect(onSelect).toHaveBeenCalledWith('glass');
  });

  it('uses the shared default-No confirmation without tooltip handling', () => {
    const shared = deps();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const confirmation = createConfirmationController(shared);
    confirmation.open({ prompt: 'Delete wall?', onConfirm, onCancel });

    confirmation.handleInput('Space', ' ');
    expect(shared.updateStatus).not.toHaveBeenCalled();
    confirmation.handleInput('ArrowDown', 'ArrowDown');
    confirmation.handleInput('Enter', 'Enter');
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
