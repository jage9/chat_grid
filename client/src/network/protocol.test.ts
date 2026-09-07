import { describe, expect, it } from 'vitest';
import { incomingMessageSchema } from './protocol';

describe('item target protocol messages', () => {
  it('parses transfer and hand target responses as distinct message types', () => {
    const transfer = incomingMessageSchema.parse({
      type: 'item_transfer_targets',
      itemId: 'ground-item',
      targets: [{ userId: 'offline-user', username: 'Offline user', online: false }],
    });
    const hand = incomingMessageSchema.parse({
      type: 'item_hand_targets',
      itemId: 'held-item',
      targets: [{ userId: 'nearby-user', username: 'Nearby user', online: true }],
    });

    expect(transfer.type).toBe('item_transfer_targets');
    expect(hand.type).toBe('item_hand_targets');
  });

  it('accepts hand as an item action result', () => {
    const result = incomingMessageSchema.parse({
      type: 'item_action_result',
      ok: true,
      action: 'hand',
      itemId: 'held-item',
      message: 'Handed item.',
    });

    expect(result).toMatchObject({ type: 'item_action_result', action: 'hand' });
  });
});
