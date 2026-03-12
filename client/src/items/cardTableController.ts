import { handleListControlKey } from '../input/listController';
import { handleYesNoMenuInput, YES_NO_OPTIONS } from '../input/yesNoMenu';
import type { OutgoingMessage } from '../network/protocol';
import type { GameMode, WorldItem } from '../state/gameState';

const CARD_ACTIONS = ['Discard', 'Return to draw pile', 'Cancel'] as const;

const RANK_NAMES: Record<string, string> = {
  A: 'Ace',
  '2': 'Two',
  '3': 'Three',
  '4': 'Four',
  '5': 'Five',
  '6': 'Six',
  '7': 'Seven',
  '8': 'Eight',
  '9': 'Nine',
  '10': 'Ten',
  J: 'Jack',
  Q: 'Queen',
  K: 'King',
};

const SUIT_NAMES: Record<string, string> = {
  S: 'Spades',
  H: 'Hearts',
  D: 'Diamonds',
  C: 'Clubs',
};

function cardName(code: string): string {
  if (code === 'JO1' || code === 'JO2') return 'Joker';
  const suit = code.slice(-1);
  const rank = code.slice(0, -1);
  return `${RANK_NAMES[rank] ?? rank} of ${SUIT_NAMES[suit] ?? suit}`;
}

type CardTableControllerDeps = {
  state: {
    mode: GameMode;
    items: Map<string, WorldItem>;
    player: { nickname: string };
    cardTableItemId: string | null;
    cardTableMenuIndex: number;
    cardTableHandIndex: number;
    cardTableCardActionIndex: number;
    cardTableDiscardIndex: number;
    cardTableConfirmIndex: number;
  };
  signalingSend: (message: OutgoingMessage) => void;
  updateStatus: (message: string) => void;
  sfxUiBlip: () => void;
  sfxUiCancel: () => void;
};

function getDrawPile(item: WorldItem): string[] {
  const raw = item.params['draw_pile'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is string => typeof c === 'string');
}

function getDiscardPile(item: WorldItem): string[] {
  const raw = item.params['discard_pile'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is string => typeof c === 'string');
}

function getHand(item: WorldItem, nickname: string): string[] {
  const hands = item.params['hands'];
  if (!hands || typeof hands !== 'object' || Array.isArray(hands)) return [];
  const hand = (hands as Record<string, unknown>)[nickname];
  if (!Array.isArray(hand)) return [];
  return hand.filter((c): c is string => typeof c === 'string');
}

function buildMainMenuEntries(item: WorldItem, nickname: string): string[] {
  const drawPile = getDrawPile(item);
  const discardPile = getDiscardPile(item);
  const hand = getHand(item, nickname);
  return [
    drawPile.length > 0 ? `Draw a card (${drawPile.length} in pile)` : 'Draw a card (pile empty)',
    discardPile.length > 0 ? `Draw from discard (${discardPile.length})` : 'Draw from discard (none)',
    hand.length > 0 ? `View hand (${hand.length} cards)` : 'View hand (empty)',
    'Shuffle and reset',
    'Close',
  ];
}

export function createCardTableController(deps: CardTableControllerDeps): {
  beginCardTableMenu: (item: WorldItem) => void;
  handleCardTableMenuModeInput: (code: string, key: string) => void;
  handleCardTableHandModeInput: (code: string, key: string) => void;
  handleCardTableCardActionModeInput: (code: string, key: string) => void;
  handleCardTableDiscardModeInput: (code: string, key: string) => void;
  handleCardTableConfirmResetModeInput: (code: string, key: string) => void;
  refreshCardTableStatus: () => void;
} {
  function getActiveItem(): WorldItem | null {
    return deps.state.cardTableItemId ? (deps.state.items.get(deps.state.cardTableItemId) ?? null) : null;
  }

  function exitMenu(): void {
    deps.state.mode = 'normal';
    deps.state.cardTableItemId = null;
  }

  function beginCardTableMenu(item: WorldItem): void {
    deps.state.cardTableItemId = item.id;
    deps.state.cardTableMenuIndex = 0;
    deps.state.mode = 'cardTableMenu';
    const entries = buildMainMenuEntries(item, deps.state.player.nickname);
    deps.updateStatus(`${item.title}. ${entries[0]}.`);
    deps.sfxUiBlip();
  }

  function handleCardTableMenuModeInput(code: string, key: string): void {
    const item = getActiveItem();
    if (!item) {
      exitMenu();
      return;
    }

    const nickname = deps.state.player.nickname;
    const entries = buildMainMenuEntries(item, nickname);
    const control = handleListControlKey(code, key, entries, deps.state.cardTableMenuIndex, (e) => e);

    if (control.type === 'move') {
      deps.state.cardTableMenuIndex = control.index;
      deps.updateStatus(entries[control.index]);
      deps.sfxUiBlip();
      return;
    }

    if (control.type === 'select') {
      const idx = deps.state.cardTableMenuIndex;

      if (idx === 0) {
        // Draw a card
        const drawPile = getDrawPile(item);
        if (drawPile.length === 0) {
          deps.updateStatus('Draw pile is empty.');
          deps.sfxUiCancel();
          return;
        }
        const card = drawPile[0];
        const newDrawPile = drawPile.slice(1);
        const hands = item.params['hands'];
        const handsObj: Record<string, string[]> =
          hands && typeof hands === 'object' && !Array.isArray(hands)
            ? (hands as Record<string, string[]>)
            : {};
        const currentHand = Array.isArray(handsObj[nickname]) ? [...handsObj[nickname]] : [];
        currentHand.push(card);
        const newHands = { ...handsObj, [nickname]: currentHand };
        deps.signalingSend({
          type: 'item_update',
          itemId: item.id,
          params: { draw_pile: newDrawPile, hands: newHands },
        });
        deps.updateStatus(`Drew ${cardName(card)}. ${newDrawPile.length} cards remaining in pile.`);
        deps.sfxUiBlip();
        return;
      }

      if (idx === 1) {
        // Draw from discard
        const discardPile = getDiscardPile(item);
        if (discardPile.length === 0) {
          deps.updateStatus('Discard pile is empty.');
          deps.sfxUiCancel();
          return;
        }
        deps.state.cardTableDiscardIndex = 0;
        deps.state.mode = 'cardTableDiscard';
        deps.updateStatus(`Discard pile. ${cardName(discardPile[0])}.`);
        deps.sfxUiBlip();
        return;
      }

      if (idx === 2) {
        // View hand
        const hand = getHand(item, nickname);
        if (hand.length === 0) {
          deps.updateStatus('Your hand is empty.');
          deps.sfxUiCancel();
          return;
        }
        deps.state.cardTableHandIndex = 0;
        deps.state.mode = 'cardTableHand';
        deps.updateStatus(`Your hand. ${cardName(hand[0])}.`);
        deps.sfxUiBlip();
        return;
      }

      if (idx === 3) {
        // Shuffle and reset — confirm first
        deps.state.cardTableConfirmIndex = 0;
        deps.state.mode = 'cardTableConfirmReset';
        deps.updateStatus(`Shuffle and reset ${item.title}? ${YES_NO_OPTIONS[0].label}.`);
        deps.sfxUiBlip();
        return;
      }

      // Close
      exitMenu();
      deps.updateStatus('Closed.');
      deps.sfxUiCancel();
      return;
    }

    if (control.type === 'cancel') {
      exitMenu();
      deps.updateStatus('Closed.');
      deps.sfxUiCancel();
    }
  }

  function handleCardTableHandModeInput(code: string, key: string): void {
    const item = getActiveItem();
    if (!item) {
      exitMenu();
      return;
    }

    const nickname = deps.state.player.nickname;
    const hand = getHand(item, nickname);
    const entries = [...hand.map(cardName), 'Back'];
    const control = handleListControlKey(code, key, entries, deps.state.cardTableHandIndex, (e) => e);

    if (control.type === 'move') {
      deps.state.cardTableHandIndex = control.index;
      deps.updateStatus(entries[control.index]);
      deps.sfxUiBlip();
      return;
    }

    if (control.type === 'select') {
      if (deps.state.cardTableHandIndex === hand.length) {
        // Back
        deps.state.mode = 'cardTableMenu';
        const menuEntries = buildMainMenuEntries(item, nickname);
        deps.updateStatus(menuEntries[deps.state.cardTableMenuIndex] ?? menuEntries[0]);
        deps.sfxUiCancel();
        return;
      }
      // Select a card → card action submenu
      deps.state.cardTableCardActionIndex = 0;
      deps.state.mode = 'cardTableCardAction';
      const selectedCard = hand[deps.state.cardTableHandIndex];
      deps.updateStatus(`${cardName(selectedCard)}. ${CARD_ACTIONS[0]}.`);
      deps.sfxUiBlip();
      return;
    }

    if (control.type === 'cancel') {
      deps.state.mode = 'cardTableMenu';
      const menuEntries = buildMainMenuEntries(item, nickname);
      deps.updateStatus(menuEntries[deps.state.cardTableMenuIndex] ?? menuEntries[0]);
      deps.sfxUiCancel();
    }
  }

  function handleCardTableCardActionModeInput(code: string, key: string): void {
    const item = getActiveItem();
    if (!item) {
      exitMenu();
      return;
    }

    const nickname = deps.state.player.nickname;
    const hand = getHand(item, nickname);
    const cardIndex = deps.state.cardTableHandIndex;

    if (cardIndex >= hand.length) {
      // Card no longer exists, go back to hand
      deps.state.cardTableHandIndex = Math.max(0, hand.length - 1);
      deps.state.mode = 'cardTableHand';
      const entries = [...hand.map(cardName), 'Back'];
      deps.updateStatus(entries[deps.state.cardTableHandIndex] ?? 'Back');
      deps.sfxUiCancel();
      return;
    }

    const control = handleListControlKey(code, key, CARD_ACTIONS, deps.state.cardTableCardActionIndex, (e) => e);

    if (control.type === 'move') {
      deps.state.cardTableCardActionIndex = control.index;
      deps.updateStatus(CARD_ACTIONS[control.index]);
      deps.sfxUiBlip();
      return;
    }

    if (control.type === 'select') {
      const actionIdx = deps.state.cardTableCardActionIndex;
      const card = hand[cardIndex];
      const newHand = [...hand];
      newHand.splice(cardIndex, 1);

      const hands = item.params['hands'];
      const handsObj: Record<string, string[]> =
        hands && typeof hands === 'object' && !Array.isArray(hands)
          ? (hands as Record<string, string[]>)
          : {};

      if (actionIdx === 0) {
        // Discard
        const discardPile = getDiscardPile(item);
        const newDiscard = [card, ...discardPile];
        const newHands = { ...handsObj, [nickname]: newHand };
        deps.signalingSend({
          type: 'item_update',
          itemId: item.id,
          params: { discard_pile: newDiscard, hands: newHands },
        });
        deps.state.cardTableHandIndex = Math.min(cardIndex, Math.max(0, newHand.length - 1));
        if (newHand.length === 0) {
          deps.state.mode = 'cardTableMenu';
          deps.state.cardTableMenuIndex = 2; // view hand entry
          deps.updateStatus(`${cardName(card)} discarded. Hand is empty.`);
        } else {
          deps.state.mode = 'cardTableHand';
          deps.updateStatus(`${cardName(card)} discarded.`);
        }
        deps.sfxUiBlip();
        return;
      }

      if (actionIdx === 1) {
        // Return to draw pile
        const drawPile = getDrawPile(item);
        const newDrawPile = [...drawPile, card];
        const newHands = { ...handsObj, [nickname]: newHand };
        deps.signalingSend({
          type: 'item_update',
          itemId: item.id,
          params: { draw_pile: newDrawPile, hands: newHands },
        });
        deps.state.cardTableHandIndex = Math.min(cardIndex, Math.max(0, newHand.length - 1));
        if (newHand.length === 0) {
          deps.state.mode = 'cardTableMenu';
          deps.state.cardTableMenuIndex = 2;
          deps.updateStatus(`${cardName(card)} returned to draw pile. Hand is empty.`);
        } else {
          deps.state.mode = 'cardTableHand';
          deps.updateStatus(`${cardName(card)} returned to draw pile.`);
        }
        deps.sfxUiBlip();
        return;
      }

      // Cancel
      deps.state.mode = 'cardTableHand';
      const entries = [...hand.map(cardName), 'Back'];
      deps.updateStatus(entries[cardIndex] ?? 'Back');
      deps.sfxUiCancel();
      return;
    }

    if (control.type === 'cancel') {
      deps.state.mode = 'cardTableHand';
      const entries = [...hand.map(cardName), 'Back'];
      deps.updateStatus(entries[cardIndex] ?? 'Back');
      deps.sfxUiCancel();
    }
  }

  function handleCardTableDiscardModeInput(code: string, key: string): void {
    const item = getActiveItem();
    if (!item) {
      exitMenu();
      return;
    }

    const nickname = deps.state.player.nickname;
    const discardPile = getDiscardPile(item);
    const entries = [...discardPile.map(cardName), 'Back'];
    const control = handleListControlKey(code, key, entries, deps.state.cardTableDiscardIndex, (e) => e);

    if (control.type === 'move') {
      deps.state.cardTableDiscardIndex = control.index;
      deps.updateStatus(entries[control.index]);
      deps.sfxUiBlip();
      return;
    }

    if (control.type === 'select') {
      if (deps.state.cardTableDiscardIndex === discardPile.length) {
        // Back
        deps.state.mode = 'cardTableMenu';
        const menuEntries = buildMainMenuEntries(item, nickname);
        deps.updateStatus(menuEntries[deps.state.cardTableMenuIndex] ?? menuEntries[0]);
        deps.sfxUiCancel();
        return;
      }

      // Take card from discard into hand
      const cardIdx = deps.state.cardTableDiscardIndex;
      const card = discardPile[cardIdx];
      const newDiscard = [...discardPile];
      newDiscard.splice(cardIdx, 1);

      const hands = item.params['hands'];
      const handsObj: Record<string, string[]> =
        hands && typeof hands === 'object' && !Array.isArray(hands)
          ? (hands as Record<string, string[]>)
          : {};
      const currentHand = Array.isArray(handsObj[nickname]) ? [...handsObj[nickname]] : [];
      currentHand.push(card);
      const newHands = { ...handsObj, [nickname]: currentHand };

      deps.signalingSend({
        type: 'item_update',
        itemId: item.id,
        params: { discard_pile: newDiscard, hands: newHands },
      });

      deps.state.mode = 'cardTableMenu';
      deps.state.cardTableMenuIndex = 0;
      deps.updateStatus(`Took ${cardName(card)} from discard pile.`);
      deps.sfxUiBlip();
      return;
    }

    if (control.type === 'cancel') {
      deps.state.mode = 'cardTableMenu';
      const menuEntries = buildMainMenuEntries(item, nickname);
      deps.updateStatus(menuEntries[deps.state.cardTableMenuIndex] ?? menuEntries[0]);
      deps.sfxUiCancel();
    }
  }

  function handleCardTableConfirmResetModeInput(code: string, key: string): void {
    const item = getActiveItem();
    if (!item) {
      exitMenu();
      return;
    }

    const control = handleYesNoMenuInput(code, key, deps.state.cardTableConfirmIndex);

    if (control.type === 'move') {
      deps.state.cardTableConfirmIndex = control.index;
      deps.updateStatus(YES_NO_OPTIONS[control.index].label);
      deps.sfxUiBlip();
      return;
    }

    if (control.type === 'select') {
      if (YES_NO_OPTIONS[deps.state.cardTableConfirmIndex].id === 'yes') {
        deps.signalingSend({ type: 'item_secondary_use', itemId: item.id });
        exitMenu();
        deps.updateStatus('Shuffling and resetting card table.');
        deps.sfxUiBlip();
      } else {
        deps.state.mode = 'cardTableMenu';
        const menuEntries = buildMainMenuEntries(item, deps.state.player.nickname);
        deps.updateStatus(menuEntries[deps.state.cardTableMenuIndex] ?? menuEntries[0]);
        deps.sfxUiCancel();
      }
      return;
    }

    if (control.type === 'cancel') {
      deps.state.mode = 'cardTableMenu';
      const menuEntries = buildMainMenuEntries(item, deps.state.player.nickname);
      deps.updateStatus(menuEntries[deps.state.cardTableMenuIndex] ?? menuEntries[0]);
      deps.sfxUiCancel();
    }
  }

  function refreshCardTableStatus(): void {
    const item = getActiveItem();
    if (!item) return;

    const nickname = deps.state.player.nickname;
    const mode = deps.state.mode;

    if (mode === 'cardTableMenu') {
      const entries = buildMainMenuEntries(item, nickname);
      deps.state.cardTableMenuIndex = Math.min(deps.state.cardTableMenuIndex, entries.length - 1);
      deps.updateStatus(`Updated. ${entries[deps.state.cardTableMenuIndex]}.`);
    } else if (mode === 'cardTableHand') {
      const hand = getHand(item, nickname);
      const entries = [...hand.map(cardName), 'Back'];
      deps.state.cardTableHandIndex = Math.min(deps.state.cardTableHandIndex, entries.length - 1);
      deps.updateStatus(`Updated. ${entries[deps.state.cardTableHandIndex]}.`);
    } else if (mode === 'cardTableCardAction') {
      const hand = getHand(item, nickname);
      if (deps.state.cardTableHandIndex >= hand.length) {
        deps.state.cardTableHandIndex = Math.max(0, hand.length - 1);
        if (hand.length === 0) {
          deps.state.mode = 'cardTableMenu';
          const menuEntries = buildMainMenuEntries(item, nickname);
          deps.updateStatus(`Updated. ${menuEntries[deps.state.cardTableMenuIndex] ?? menuEntries[0]}.`);
        } else {
          deps.state.mode = 'cardTableHand';
          const entries = [...hand.map(cardName), 'Back'];
          deps.updateStatus(`Updated. ${entries[deps.state.cardTableHandIndex]}.`);
        }
      } else {
        const card = hand[deps.state.cardTableHandIndex];
        deps.updateStatus(`Updated. ${cardName(card)}. ${CARD_ACTIONS[deps.state.cardTableCardActionIndex]}.`);
      }
    } else if (mode === 'cardTableDiscard') {
      const discardPile = getDiscardPile(item);
      const entries = [...discardPile.map(cardName), 'Back'];
      deps.state.cardTableDiscardIndex = Math.min(deps.state.cardTableDiscardIndex, entries.length - 1);
      deps.updateStatus(`Updated. ${entries[deps.state.cardTableDiscardIndex]}.`);
    }
  }

  return {
    beginCardTableMenu,
    handleCardTableMenuModeInput,
    handleCardTableHandModeInput,
    handleCardTableCardActionModeInput,
    handleCardTableDiscardModeInput,
    handleCardTableConfirmResetModeInput,
    refreshCardTableStatus,
  };
}
