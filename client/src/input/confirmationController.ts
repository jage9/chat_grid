import type { GameMode } from '../state/gameState';
import { handleYesNoMenuInput, YES_NO_OPTIONS } from './yesNoMenu';

export type ConfirmationRequest = {
  prompt: string;
  onConfirm: () => void;
  onCancel: () => void;
};

type ConfirmationDeps = {
  state: { mode: GameMode };
  announceMenuEntry: (title: string, option: string) => void;
  updateStatus: (message: string) => void;
  blip: () => void;
  cancel: () => void;
};

/** Create the shared No/Yes confirmation flow used across features. */
export function createConfirmationController(deps: ConfirmationDeps) {
  let request: ConfirmationRequest | null = null;
  let index = 0;

  function open(next: ConfirmationRequest): void {
    request = next;
    index = 0;
    deps.state.mode = 'confirmYesNo';
    deps.announceMenuEntry(next.prompt, YES_NO_OPTIONS[index].label);
  }

  function handleInput(code: string, key: string): void {
    if (!request) {
      deps.state.mode = 'normal';
      return;
    }
    const control = handleYesNoMenuInput(code, key, index);
    if (control.type === 'move') {
      index = control.index;
      deps.updateStatus(YES_NO_OPTIONS[index].label);
      deps.blip();
      return;
    }
    if (control.type === 'cancel' || control.type === 'select') {
      const active = request;
      const confirmed = control.type === 'select' && YES_NO_OPTIONS[index].id === 'yes';
      request = null;
      if (confirmed) active.onConfirm();
      else {
        active.onCancel();
        deps.cancel();
      }
    }
  }

  return { open, handleInput };
}
