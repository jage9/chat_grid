import type { ModeInput } from './commandTypes';

type MobileControllerDeps = {
  dom: {
    canvas: HTMLCanvasElement;
    mobileControls: HTMLDivElement;
    toggleButton: HTMLButtonElement;
    dpadUp: HTMLButtonElement;
    dpadDown: HTMLButtonElement;
    dpadLeft: HTMLButtonElement;
    dpadRight: HTMLButtonElement;
    btnChat: HTMLButtonElement;
    btnUse: HTMLButtonElement;
    btnLocateUser: HTMLButtonElement;
    btnLocateItem: HTMLButtonElement;
    btnCommandPalette: HTMLButtonElement;
  };
  state: {
    running: boolean;
    keysPressed: Record<string, boolean>;
  };
  handleModeInput: (input: ModeInput) => void;
  openCommandPalette: () => void;
};

/**
 * Wires touch handlers for the on-screen mobile controls panel.
 * Movement uses hold-to-walk by writing directly into keysPressed (same as the
 * keyboard controller). Action buttons dispatch through handleModeInput so they
 * travel the same code path as their keyboard equivalents.
 */
export function setupMobileControls(deps: MobileControllerDeps): void {
  const { dom, state } = deps;

  // ── Toggle ───────────────────────────────────────────────────────────────
  dom.toggleButton.addEventListener('click', () => {
    const expanded = dom.mobileControls.dataset['expanded'] === 'true';
    const next = String(!expanded);
    dom.mobileControls.dataset['expanded'] = next;
    dom.toggleButton.setAttribute('aria-expanded', next);
  });

  // ── D-pad movement ───────────────────────────────────────────────────────
  const dpadMap: Array<[HTMLButtonElement, string]> = [
    [dom.dpadUp,    'ArrowUp'],
    [dom.dpadDown,  'ArrowDown'],
    [dom.dpadLeft,  'ArrowLeft'],
    [dom.dpadRight, 'ArrowRight'],
  ];

  for (const [btn, arrowCode] of dpadMap) {
    btn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (!state.running) return;
      state.keysPressed[arrowCode] = true;
    }, { passive: false });

    btn.addEventListener('touchend', () => {
      state.keysPressed[arrowCode] = false;
    });

    btn.addEventListener('touchcancel', () => {
      state.keysPressed[arrowCode] = false;
    });
  }

  // ── Action buttons ───────────────────────────────────────────────────────
  type ActionDef = [HTMLButtonElement, string, string];
  const actionMap: ActionDef[] = [
    [dom.btnChat,       'Slash',  '/'],
    [dom.btnUse,        'Enter',  'Enter'],
    [dom.btnLocateUser, 'KeyL',   'l'],
    [dom.btnLocateItem, 'KeyI',   'i'],
  ];

  for (const [btn, code, key] of actionMap) {
    btn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (!state.running) return;
      dom.canvas.focus();
      deps.handleModeInput({ code, key, ctrlKey: false, shiftKey: false });
    }, { passive: false });
  }

  dom.btnCommandPalette.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (!state.running) return;
    dom.canvas.focus();
    deps.openCommandPalette();
  }, { passive: false });
}
