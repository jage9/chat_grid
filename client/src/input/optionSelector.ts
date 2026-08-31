import type { GameMode } from '../state/gameState';
import { handleListControlKey } from './listController';

export type OptionSelectorEntry = { id: string; label: string };

export type OptionSelectorRequest = {
  title: string;
  options: OptionSelectorEntry[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onCancel: () => void;
};

type OptionSelectorDeps = {
  state: { mode: GameMode };
  announceMenuEntry: (title: string, option: string) => void;
  updateStatus: (message: string) => void;
  blip: () => void;
  cancel: () => void;
};

/** Create the shared option-list interaction used by item and structure properties. */
export function createOptionSelector(deps: OptionSelectorDeps) {
  let request: OptionSelectorRequest | null = null;
  let index = 0;

  function open(next: OptionSelectorRequest): void {
    if (next.options.length === 0) return;
    request = next;
    const selectedIndex = next.options.findIndex((entry) => entry.id === next.selectedId);
    index = selectedIndex >= 0 ? selectedIndex : 0;
    deps.state.mode = 'optionSelect';
    deps.announceMenuEntry(next.title, next.options[index].label);
  }

  function handleInput(code: string, key: string): void {
    if (!request || request.options.length === 0) {
      deps.state.mode = 'normal';
      return;
    }
    if (code === 'PageUp' || code === 'PageDown') {
      const jump = Math.min(10, Math.max(1, request.options.length - 1));
      const delta = code === 'PageUp' ? -jump : jump;
      index = (index + delta + request.options.length * 1000) % request.options.length;
      deps.updateStatus(request.options[index].label);
      deps.blip();
      return;
    }
    const control = handleListControlKey(code, key, request.options, index, (entry) => entry.label);
    if (control.type === 'move') {
      index = control.index;
      deps.updateStatus(request.options[index].label);
      deps.blip();
      return;
    }
    if (control.type === 'select') {
      const active = request;
      request = null;
      active.onSelect(active.options[index].id);
      return;
    }
    if (control.type === 'cancel') {
      const active = request;
      request = null;
      active.onCancel();
      deps.cancel();
    }
  }

  return { open, handleInput };
}
