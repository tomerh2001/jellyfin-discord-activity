import { z } from "zod";

export const playStateSchema = z.enum(["idle", "loading", "playing", "paused", "buffering", "ended"]);
export const playerActionSchema = z.enum(["play", "pause", "seek", "buffering", "ended"]);

export const participantSchema = z.object({
  discordUserId: z.string().min(1),
  username: z.string().min(1),
  avatar: z.string().nullable().optional(),
  isHost: z.boolean(),
  connectedAt: z.string().datetime()
});

export const roomStateSchema = z.object({
  instanceId: z.string().min(1),
  guildId: z.string().min(1).optional(),
  channelId: z.string().min(1).optional(),
  hostDiscordUserId: z.string().min(1).optional(),
  itemId: z.string().min(1).optional(),
  mediaSourceId: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  runtimeTicks: z.number().int().positive().optional(),
  audioStreamIndex: z.number().int().optional(),
  subtitleStreamIndex: z.number().int().nonnegative().optional(),
  playState: playStateSchema,
  positionSeconds: z.number().nonnegative(),
  updatedAt: z.string().datetime()
});

const baseClientMessageSchema = z.object({
  ts: z.number().int().nonnegative()
});

export const clientMessageSchema = z.discriminatedUnion("type", [
  baseClientMessageSchema.extend({
    type: z.literal("hello"),
    instanceId: z.string().min(1),
    guildId: z.string().min(1).optional(),
    channelId: z.string().min(1).optional()
  }),
  baseClientMessageSchema.extend({
    type: z.literal("claim_host")
  }),
  baseClientMessageSchema.extend({
    type: z.literal("select_media"),
    itemId: z.string().min(1),
    mediaSourceId: z.string().min(1).optional(),
    title: z.string().min(1),
    runtimeTicks: z.number().int().positive().optional(),
    audioStreamIndex: z.number().int().optional(),
    subtitleStreamIndex: z.number().int().nonnegative().optional()
  }),
  baseClientMessageSchema.extend({
    type: z.literal("ready"),
    itemId: z.string().min(1),
    positionSeconds: z.number().nonnegative().optional()
  }),
  baseClientMessageSchema.extend({
    type: z.literal("player_event"),
    action: playerActionSchema,
    positionSeconds: z.number().nonnegative()
  }),
  baseClientMessageSchema.extend({
    type: z.literal("state_update"),
    playState: z.enum(["playing", "paused", "buffering"]),
    positionSeconds: z.number().nonnegative()
  }),
  baseClientMessageSchema.extend({
    type: z.literal("ping"),
    clientTs: z.number().int().nonnegative()
  }),
  baseClientMessageSchema.extend({
    type: z.literal("leave")
  })
]);

const baseServerMessageSchema = z.object({
  serverTs: z.number().int().nonnegative()
});

export const serverMessageSchema = z.discriminatedUnion("type", [
  baseServerMessageSchema.extend({
    type: z.literal("hello_ack"),
    clientId: z.string().min(1)
  }),
  baseServerMessageSchema.extend({
    type: z.literal("room_state"),
    room: roomStateSchema
  }),
  baseServerMessageSchema.extend({
    type: z.literal("participants_update"),
    participants: z.array(participantSchema)
  }),
  baseServerMessageSchema.extend({
    type: z.literal("host_changed"),
    hostDiscordUserId: z.string().min(1)
  }),
  baseServerMessageSchema.extend({
    type: z.literal("media_selected"),
    itemId: z.string().min(1),
    mediaSourceId: z.string().min(1).optional(),
    title: z.string().min(1),
    runtimeTicks: z.number().int().positive().optional(),
    audioStreamIndex: z.number().int().optional(),
    subtitleStreamIndex: z.number().int().nonnegative().optional()
  }),
  baseServerMessageSchema.extend({
    type: z.literal("player_event"),
    action: playerActionSchema,
    positionSeconds: z.number().nonnegative(),
    targetServerTs: z.number().int().nonnegative()
  }),
  baseServerMessageSchema.extend({
    type: z.literal("state_update"),
    playState: z.enum(["playing", "paused", "buffering"]),
    positionSeconds: z.number().nonnegative()
  }),
  baseServerMessageSchema.extend({
    type: z.literal("pong"),
    clientTs: z.number().int().nonnegative()
  }),
  baseServerMessageSchema.extend({
    type: z.literal("error"),
    code: z.string().min(1),
    message: z.string().min(1)
  })
]);

export type PlayState = z.infer<typeof playStateSchema>;
export type Participant = z.infer<typeof participantSchema>;
export type RoomState = z.infer<typeof roomStateSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;
