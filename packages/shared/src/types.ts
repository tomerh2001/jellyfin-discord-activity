import { z } from "zod";

export const discordUserSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(1),
  globalName: z.string().nullable().optional(),
  avatar: z.string().nullable().optional()
});

export const discordContextSchema = z.object({
  instanceId: z.string().min(1),
  guildId: z.string().min(1).optional(),
  channelId: z.string().min(1).optional()
});

export const discordExchangeRequestSchema = discordContextSchema.extend({
  code: z.string().min(1),
  redirectUri: z.string().url().optional(),
  mockUser: discordUserSchema.optional()
});

export const discordExchangeResponseSchema = z.object({
  appToken: z.string().min(1),
  discordAccessToken: z.string().min(1).optional(),
  user: discordUserSchema,
  expiresAt: z.string().datetime()
});

export const meResponseSchema = z.object({
  discordUser: discordUserSchema,
  jellyfinLinked: z.boolean(),
  discordContext: discordContextSchema.optional(),
  appSessionExpiresAt: z.string().datetime()
});

export const logoutResponseSchema = z.object({
  ok: z.literal(true)
});

export const jellyfinStatusSchema = z.object({
  linked: z.boolean(),
  authMode: z.enum(["per-user", "shared"]).default("per-user"),
  serverUrl: z.string().url().optional(),
  username: z.string().optional()
});

export const jellyfinLinkRequestSchema = z.object({
  serverUrl: z.string().url().optional(),
  username: z.string().min(1),
  password: z.string()
});

export const jellyfinUserSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1)
});

export const jellyfinLinkResponseSchema = z.object({
  linked: z.literal(true),
  jellyfinUser: jellyfinUserSchema,
  serverUrl: z.string().url()
});

export const jellyfinUnlinkResponseSchema = z.object({
  linked: z.literal(false)
});

export const jellyfinLibrarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  collectionType: z.string().nullable().optional()
});

export const jellyfinLibrariesResponseSchema = z.object({
  libraries: z.array(jellyfinLibrarySchema)
});

export const jellyfinItemTypeSchema = z.enum(["Movie", "Episode", "Series", "Season", "Folder", "BoxSet"]);

export const jellyfinItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.string().min(1),
  overview: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
  seriesName: z.string().nullable().optional(),
  seasonName: z.string().nullable().optional(),
  productionYear: z.number().int().nullable().optional(),
  indexNumber: z.number().int().nullable().optional(),
  parentIndexNumber: z.number().int().nullable().optional(),
  runtimeTicks: z.number().int().positive().nullable().optional(),
  imageItemId: z.string().nullable().optional(),
  imageTag: z.string().nullable().optional()
});

export const jellyfinItemsQuerySchema = z.object({
  parentId: z.string().min(1).optional(),
  query: z.string().optional(),
  type: z.string().optional(),
  recursive: z.preprocess((value) => {
    if (value === "false") {
      return false;
    }

    if (value === "true") {
      return true;
    }

    return value;
  }, z.boolean()).default(true),
  parentIndexNumber: z.coerce.number().int().min(0).optional(),
  startIndex: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

export const jellyfinItemsResponseSchema = z.object({
  items: z.array(jellyfinItemSchema),
  totalRecordCount: z.number().int().nonnegative()
});

export const jellyfinItemDetailsResponseSchema = z.object({
  item: jellyfinItemSchema
});

export const currentRoomQuerySchema = z.object({
  instanceId: z.string().min(1)
});

export const claimHostRequestSchema = z.object({
  instanceId: z.string().min(1),
  guildId: z.string().min(1).optional(),
  channelId: z.string().min(1).optional()
});

export const selectMediaRequestSchema = z.object({
  instanceId: z.string().min(1),
  itemId: z.string().min(1),
  mediaSourceId: z.string().min(1).optional(),
  title: z.string().min(1),
  runtimeTicks: z.number().int().positive().optional(),
  audioStreamIndex: z.number().int().optional(),
  subtitleStreamIndex: z.number().int().nonnegative().optional()
});

export const playbackPrepareRequestSchema = z.object({
  itemId: z.string().min(1),
  mediaSourceId: z.string().min(1).optional(),
  audioStreamIndex: z.number().int().optional(),
  subtitleStreamIndex: z.number().int().optional(),
  maxStreamingBitrate: z.number().int().positive().optional()
});

export const playbackTrackSchema = z.object({
  index: z.number().int(),
  type: z.enum(["Audio", "Subtitle"]),
  label: z.string().min(1),
  codec: z.string().nullable().optional(),
  language: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  isDefault: z.boolean().optional(),
  isForced: z.boolean().optional(),
  isExternal: z.boolean().optional()
});

export const playbackPrepareResponseSchema = z.object({
  playback: z.object({
    itemId: z.string().min(1),
    mediaSourceId: z.string().min(1),
    playMethod: z.enum(["hls", "direct"]),
    streamUrl: z.string().min(1),
    expiresAt: z.string().datetime(),
    container: z.string().min(1).optional(),
    videoCodec: z.string().min(1).optional(),
    audioCodec: z.string().min(1).optional(),
    selectedAudioStreamIndex: z.number().int().optional(),
    selectedSubtitleStreamIndex: z.number().int(),
    audioTracks: z.array(playbackTrackSchema),
    subtitleTracks: z.array(playbackTrackSchema)
  })
});

export const roomResponseSchema = z.object({
  room: z.object({
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
    playState: z.enum(["idle", "loading", "playing", "paused", "buffering", "ended"]),
    positionSeconds: z.number().nonnegative(),
    updatedAt: z.string().datetime()
  })
});

export const healthSchema = z.object({
  ok: z.literal(true)
});

export type DiscordUser = z.infer<typeof discordUserSchema>;
export type DiscordContext = z.infer<typeof discordContextSchema>;
export type DiscordExchangeRequest = z.infer<typeof discordExchangeRequestSchema>;
export type DiscordExchangeResponse = z.infer<typeof discordExchangeResponseSchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;
export type LogoutResponse = z.infer<typeof logoutResponseSchema>;
export type JellyfinStatus = z.infer<typeof jellyfinStatusSchema>;
export type JellyfinLinkRequest = z.infer<typeof jellyfinLinkRequestSchema>;
export type JellyfinUser = z.infer<typeof jellyfinUserSchema>;
export type JellyfinLinkResponse = z.infer<typeof jellyfinLinkResponseSchema>;
export type JellyfinUnlinkResponse = z.infer<typeof jellyfinUnlinkResponseSchema>;
export type JellyfinLibrary = z.infer<typeof jellyfinLibrarySchema>;
export type JellyfinLibrariesResponse = z.infer<typeof jellyfinLibrariesResponseSchema>;
export type JellyfinItem = z.infer<typeof jellyfinItemSchema>;
export type JellyfinItemsQuery = z.infer<typeof jellyfinItemsQuerySchema>;
export type JellyfinItemsResponse = z.infer<typeof jellyfinItemsResponseSchema>;
export type JellyfinItemDetailsResponse = z.infer<typeof jellyfinItemDetailsResponseSchema>;
export type CurrentRoomQuery = z.infer<typeof currentRoomQuerySchema>;
export type ClaimHostRequest = z.infer<typeof claimHostRequestSchema>;
export type SelectMediaRequest = z.infer<typeof selectMediaRequestSchema>;
export type PlaybackPrepareRequest = z.infer<typeof playbackPrepareRequestSchema>;
export type PlaybackPrepareResponse = z.infer<typeof playbackPrepareResponseSchema>;
export type RoomResponse = z.infer<typeof roomResponseSchema>;
export type HealthResponse = z.infer<typeof healthSchema>;
