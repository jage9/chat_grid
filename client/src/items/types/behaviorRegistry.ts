import { type IncomingMessage } from '../../network/protocol';
import { type GameMode, type WorldItem } from '../../state/gameState';
import { createPianoBehavior } from './piano/behavior';
import { type ItemBehavior, type ItemBehaviorDeps } from './runtimeShared';

/** Runtime registry that composes all per-item client behavior modules. */
export class ItemBehaviorRegistry {
  private readonly behaviors: ItemBehavior[];

  constructor(deps: ItemBehaviorDeps) {
    this.behaviors = [createPianoBehavior(deps)];
  }

  /** Runs per-item initialization hooks after app bootstrap. */
  async initialize(): Promise<void> {
    for (const behavior of this.behaviors) {
      await behavior.onInit?.();
    }
  }

  /** Runs all per-item teardown hooks during disconnect/reset flows. */
  cleanup(): void {
    for (const behavior of this.behaviors) {
      behavior.onCleanup?.();
    }
  }

  /** Forwards incoming messages to behavior-specific use-result hooks. */
  onUseResultMessage(message: IncomingMessage): void {
    for (const behavior of this.behaviors) {
      behavior.onUseResultMessage?.(message);
    }
  }

  /** Lets item behaviors consume custom action-result status handling. */
  onActionResultStatus(message: Extract<IncomingMessage, { type: 'item_action_result' }>): boolean {
    for (const behavior of this.behaviors) {
      if (behavior.onActionResultStatus?.(message)) {
        return true;
      }
    }
    return false;
  }

  /** Runs per-item world-update hooks after state changes. */
  onWorldUpdate(): void {
    for (const behavior of this.behaviors) {
      behavior.onWorldUpdate?.();
    }
  }

  /** Routes property preview changes into per-item behavior hooks. */
  onPropertyPreviewChange(item: WorldItem, key: string, value: unknown): void {
    for (const behavior of this.behaviors) {
      behavior.onPropertyPreviewChange?.(item, key, value);
    }
  }

  /** Gives item behaviors first chance to handle mode input. */
  handleModeInput(mode: GameMode, code: string): boolean {
    for (const behavior of this.behaviors) {
      if (behavior.handleModeInput?.(mode, code)) {
        return true;
      }
    }
    return false;
  }

  /** Gives item behaviors first chance to handle mode key-up events. */
  handleModeKeyUp(mode: GameMode, code: string): boolean {
    for (const behavior of this.behaviors) {
      if (behavior.handleModeKeyUp?.(mode, code)) {
        return true;
      }
    }
    return false;
  }

  /** Routes incoming item-piano-note packets to the item behavior owning that protocol. */
  onRemotePianoNote(message: Extract<IncomingMessage, { type: 'item_piano_note' }>): void {
    for (const behavior of this.behaviors) {
      behavior.onRemotePianoNote?.(message);
    }
  }

  /** Stops all remote notes for one sender across behavior modules that own remote note runtimes. */
  stopAllRemoteNotesForSender(senderId: string): void {
    for (const behavior of this.behaviors) {
      behavior.onStopAllRemoteNotesForSender?.(senderId);
    }
  }
}
