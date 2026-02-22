import { z } from 'zod';

export const itemSchema = z.object({
  id: z.string(),
  type: z.enum(['radio_station', 'dice', 'wheel', 'clock']),
  title: z.string(),
  x: z.number().int(),
  y: z.number().int(),
  createdBy: z.string(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  version: z.number().int(),
  capabilities: z.array(z.string()),
  useSound: z.string().optional(),
  emitSound: z.string().optional(),
  params: z.record(z.string(), z.unknown()),
  carrierId: z.string().nullable().optional(),
});

export const welcomeMessageSchema = z.object({
  type: z.literal('welcome'),
  id: z.string(),
  users: z.array(
    z.object({
      id: z.string(),
      nickname: z.string(),
      x: z.number().int(),
      y: z.number().int(),
    }),
  ),
  items: z.array(itemSchema).optional(),
  worldConfig: z
    .object({
      gridSize: z.number().int().positive(),
    })
    .optional(),
  uiDefinitions: z
    .object({
      itemTypeOrder: z.array(z.enum(['radio_station', 'dice', 'wheel', 'clock'])),
      itemTypes: z.array(
        z.object({
          type: z.enum(['radio_station', 'dice', 'wheel', 'clock']),
          label: z.string().optional(),
          tooltip: z.string().optional(),
          editableProperties: z.array(z.string()),
          propertyOptions: z.record(z.string(), z.array(z.string())).optional(),
          propertyMetadata: z
            .record(
              z.string(),
              z.object({
                valueType: z.enum(['boolean', 'text', 'number', 'list', 'sound']).optional(),
                tooltip: z.string().optional(),
                range: z
                  .object({
                    min: z.number(),
                    max: z.number(),
                    step: z.number().optional(),
                  })
                  .optional(),
              }),
            )
            .optional(),
          globalProperties: z.record(z.string(), z.unknown()).optional(),
        }),
      ),
    })
    .optional(),
});

export const signalMessageSchema = z.object({
  type: z.literal('signal'),
  senderId: z.string(),
  senderNickname: z.string().optional(),
  x: z.number().int().optional(),
  y: z.number().int().optional(),
  targetId: z.string().optional(),
  sdp: z.any().optional(),
  ice: z.any().optional(),
});

export const updatePositionSchema = z.object({
  type: z.literal('update_position'),
  id: z.string(),
  x: z.number().int(),
  y: z.number().int(),
});

export const updateNicknameSchema = z.object({
  type: z.literal('update_nickname'),
  id: z.string(),
  nickname: z.string().min(1).max(32),
});

export const userLeftSchema = z.object({
  type: z.literal('user_left'),
  id: z.string(),
});

export const chatMessageSchema = z.object({
  type: z.literal('chat_message'),
  message: z.string(),
  senderId: z.string().optional(),
  senderNickname: z.string().optional(),
  system: z.boolean().optional(),
});

export const pongSchema = z.object({
  type: z.literal('pong'),
  clientSentAt: z.number().int(),
});

export const nicknameResultSchema = z.object({
  type: z.literal('nickname_result'),
  accepted: z.boolean(),
  requestedNickname: z.string(),
  effectiveNickname: z.string(),
  reason: z.string().optional(),
});

export const itemUpsertSchema = z.object({
  type: z.literal('item_upsert'),
  item: itemSchema,
});

export const itemRemoveSchema = z.object({
  type: z.literal('item_remove'),
  itemId: z.string(),
});

export const itemActionResultSchema = z.object({
  type: z.literal('item_action_result'),
  ok: z.boolean(),
  action: z.enum(['add', 'pickup', 'drop', 'delete', 'use', 'update']),
  message: z.string(),
  itemId: z.string().optional(),
});

export const itemUseSoundSchema = z.object({
  type: z.literal('item_use_sound'),
  itemId: z.string(),
  sound: z.string(),
  x: z.number().int(),
  y: z.number().int(),
});

export const incomingMessageSchema = z.discriminatedUnion('type', [
  welcomeMessageSchema,
  signalMessageSchema,
  updatePositionSchema,
  updateNicknameSchema,
  userLeftSchema,
  chatMessageSchema,
  pongSchema,
  nicknameResultSchema,
  itemUpsertSchema,
  itemRemoveSchema,
  itemActionResultSchema,
  itemUseSoundSchema,
]);

export type IncomingMessage = z.infer<typeof incomingMessageSchema>;

export type OutgoingMessage =
  | { type: 'signal'; targetId: string; sdp?: RTCSessionDescriptionInit; ice?: RTCIceCandidateInit }
  | { type: 'update_position'; x: number; y: number }
  | { type: 'update_nickname'; nickname: string }
  | { type: 'chat_message'; message: string }
  | { type: 'ping'; clientSentAt: number }
  | { type: 'item_add'; itemType: 'radio_station' | 'dice' | 'wheel' | 'clock' }
  | { type: 'item_pickup'; itemId: string }
  | { type: 'item_drop'; itemId: string; x: number; y: number }
  | { type: 'item_delete'; itemId: string }
  | { type: 'item_use'; itemId: string }
  | {
      type: 'item_update';
      itemId: string;
      title?: string;
      params?: Record<string, unknown>;
    };

export type RemoteUser = {
  id: string;
  nickname: string;
  x: number;
  y: number;
};
