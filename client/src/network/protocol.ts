import { z } from 'zod';

export const itemSchema = z.object({
  id: z.string(),
  type: z.string().min(1),
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
  player: z.object({
    id: z.string(),
    nickname: z.string(),
    x: z.number().int(),
    y: z.number().int(),
  }),
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
      movementTickMs: z.number().int().positive().optional(),
      movementMaxStepsPerTick: z.number().int().positive().optional(),
    })
    .optional(),
  serverInfo: z
    .object({
      instanceId: z.string(),
      version: z.string().optional(),
    })
    .optional(),
  auth: z
    .object({
      authenticated: z.boolean(),
      userId: z.string().nullable().optional(),
      username: z.string().nullable().optional(),
      role: z.string().nullable().optional(),
      policy: z
        .object({
          usernameMinLength: z.number().int().positive(),
          usernameMaxLength: z.number().int().positive(),
          passwordMinLength: z.number().int().positive(),
          passwordMaxLength: z.number().int().positive(),
        })
        .optional(),
    })
    .optional(),
  uiDefinitions: z
    .object({
      itemTypeOrder: z.array(z.string().min(1)),
      itemTypes: z.array(
        z.object({
          type: z.string().min(1),
          label: z.string().optional(),
          tooltip: z.string().optional(),
          editableProperties: z.array(z.string()),
          capabilities: z.array(z.string()).optional(),
          propertyMetadata: z
            .record(
              z.string(),
              z.object({
                valueType: z.enum(['boolean', 'text', 'number', 'list', 'sound']).optional(),
                label: z.string().optional(),
                tooltip: z.string().optional(),
                maxLength: z.number().int().positive().optional(),
                options: z.array(z.string()).optional(),
                visibleWhen: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
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

export const authRequiredSchema = z.object({
  type: z.literal('auth_required'),
  message: z.string(),
  authPolicy: z
    .object({
      usernameMinLength: z.number().int().positive(),
      usernameMaxLength: z.number().int().positive(),
      passwordMinLength: z.number().int().positive(),
      passwordMaxLength: z.number().int().positive(),
    })
    .optional(),
});

export const authResultSchema = z.object({
  type: z.literal('auth_result'),
  ok: z.boolean(),
  message: z.string(),
  sessionToken: z.string().optional(),
  username: z.string().optional(),
  role: z.string().optional(),
  nickname: z.string().optional(),
  authPolicy: z
    .object({
      usernameMinLength: z.number().int().positive(),
      usernameMaxLength: z.number().int().positive(),
      passwordMinLength: z.number().int().positive(),
      passwordMaxLength: z.number().int().positive(),
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

export const teleportCompleteSchema = z.object({
  type: z.literal('teleport_complete'),
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
  action: z.enum(['add', 'pickup', 'drop', 'delete', 'use', 'secondary_use', 'update']),
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

export const itemClockAnnounceSchema = z.object({
  type: z.literal('item_clock_announce'),
  itemId: z.string(),
  sounds: z.array(z.string()),
  x: z.number().int(),
  y: z.number().int(),
});

export const itemPianoNoteSchema = z.object({
  type: z.literal('item_piano_note'),
  itemId: z.string(),
  senderId: z.string(),
  keyId: z.string(),
  midi: z.number().int().min(0).max(127),
  on: z.boolean(),
  instrument: z.string(),
  voiceMode: z.enum(['mono', 'poly']),
  octave: z.number().int().min(-2).max(2),
  attack: z.number().int().min(0).max(100),
  decay: z.number().int().min(0).max(100),
  release: z.number().int().min(0).max(100),
  brightness: z.number().int().min(0).max(100),
  x: z.number().int(),
  y: z.number().int(),
  emitRange: z.number().int().min(1),
});

export const itemPianoStatusSchema = z.object({
  type: z.literal('item_piano_status'),
  itemId: z.string(),
  event: z.enum([
    'use_mode_entered',
    'record_started',
    'record_paused',
    'record_resumed',
    'record_stopped',
    'playback_started',
    'playback_stopped',
  ]),
  recordingState: z.enum(['idle', 'recording', 'paused', 'playback']).optional(),
});

export const incomingMessageSchema = z.discriminatedUnion('type', [
  authRequiredSchema,
  authResultSchema,
  welcomeMessageSchema,
  signalMessageSchema,
  updatePositionSchema,
  teleportCompleteSchema,
  updateNicknameSchema,
  userLeftSchema,
  chatMessageSchema,
  pongSchema,
  nicknameResultSchema,
  itemUpsertSchema,
  itemRemoveSchema,
  itemActionResultSchema,
  itemUseSoundSchema,
  itemClockAnnounceSchema,
  itemPianoNoteSchema,
  itemPianoStatusSchema,
]);

export type IncomingMessage = z.infer<typeof incomingMessageSchema>;

export type OutgoingMessage =
  | { type: 'auth_register'; username: string; password: string; email?: string }
  | { type: 'auth_login'; username: string; password: string }
  | { type: 'auth_resume'; sessionToken: string }
  | { type: 'auth_logout' }
  | { type: 'signal'; targetId: string; sdp?: RTCSessionDescriptionInit; ice?: RTCIceCandidateInit }
  | { type: 'update_position'; x: number; y: number }
  | { type: 'teleport_complete'; x: number; y: number }
  | { type: 'update_nickname'; nickname: string }
  | { type: 'chat_message'; message: string }
  | { type: 'ping'; clientSentAt: number }
  | { type: 'item_add'; itemType: string }
  | { type: 'item_pickup'; itemId: string }
  | { type: 'item_drop'; itemId: string; x: number; y: number }
  | { type: 'item_delete'; itemId: string }
  | { type: 'item_use'; itemId: string }
  | { type: 'item_secondary_use'; itemId: string }
  | { type: 'item_piano_note'; itemId: string; keyId: string; midi: number; on: boolean }
  | { type: 'item_piano_recording'; itemId: string; action: 'toggle_record' | 'playback' | 'stop_playback' | 'stop_record' }
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
