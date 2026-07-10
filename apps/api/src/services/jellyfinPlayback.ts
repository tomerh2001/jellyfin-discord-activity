import { z } from "zod";
import type { AppEnv } from "../env.js";
import { decryptString } from "./crypto.js";
import type { JellyfinAccount } from "./jellyfin.js";
import { JellyfinError } from "./jellyfin.js";

const mediaSourceSchema = z.object({
  Id: z.string().min(1),
  Container: z.string().nullable().optional(),
  SupportsDirectPlay: z.boolean().optional(),
  SupportsDirectStream: z.boolean().optional(),
  SupportsTranscoding: z.boolean().optional(),
  TranscodingUrl: z.string().nullable().optional(),
  TranscodingSubProtocol: z.string().nullable().optional(),
  TranscodingContainer: z.string().nullable().optional(),
  MediaStreams: z.array(z.object({
    Type: z.string().optional(),
    Codec: z.string().nullable().optional(),
    Index: z.number().int().optional(),
    DisplayTitle: z.string().nullable().optional(),
    Title: z.string().nullable().optional(),
    Language: z.string().nullable().optional(),
    IsDefault: z.boolean().optional(),
    IsForced: z.boolean().optional(),
    IsExternal: z.boolean().optional()
  })).optional()
});

const playbackInfoResponseSchema = z.object({
  MediaSources: z.array(mediaSourceSchema).default([])
});

export type PlaybackInfoInput = {
  itemId: string;
  mediaSourceId?: string | undefined;
  audioStreamIndex?: number | undefined;
  subtitleStreamIndex?: number | undefined;
  maxStreamingBitrate?: number | undefined;
};

export type PreparedPlayback = {
  itemId: string;
  mediaSourceId: string;
  playMethod: "hls" | "direct";
  upstreamPath: string;
  container?: string;
  videoCodec?: string;
  audioCodec?: string;
  selectedAudioStreamIndex?: number;
  selectedSubtitleStreamIndex: number;
  audioTracks: PlaybackTrack[];
  subtitleTracks: PlaybackTrack[];
};

export type PlaybackTrack = {
  index: number;
  type: "Audio" | "Subtitle";
  label: string;
  codec?: string | null;
  language?: string | null;
  title?: string | null;
  isDefault?: boolean;
  isForced?: boolean;
  isExternal?: boolean;
};

export async function getPlaybackInfo(env: AppEnv, account: JellyfinAccount, input: PlaybackInfoInput): Promise<PreparedPlayback> {
  const token = decryptString(env, account.encryptedAccessToken);
  const url = new URL(`${account.serverUrl}/Items/${encodeURIComponent(input.itemId)}/PlaybackInfo`);

  url.searchParams.set("UserId", account.jellyfinUserId);
  url.searchParams.set("MaxStreamingBitrate", String(input.maxStreamingBitrate ?? env.STREAM_MAX_BITRATE));
  url.searchParams.set("EnableDirectPlay", "true");
  url.searchParams.set("EnableDirectStream", "true");
  url.searchParams.set("EnableTranscoding", "true");

  if (input.mediaSourceId) {
    url.searchParams.set("MediaSourceId", input.mediaSourceId);
  }

  if (input.audioStreamIndex !== undefined) {
    url.searchParams.set("AudioStreamIndex", String(input.audioStreamIndex));
  }

  if (isSelectedSubtitleStream(input.subtitleStreamIndex)) {
    url.searchParams.set("SubtitleStreamIndex", String(input.subtitleStreamIndex));
    url.searchParams.set("SubtitleMethod", "Encode");
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: jellyfinAuthorizationHeader(token),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      DeviceProfile: browserDeviceProfile(input.maxStreamingBitrate ?? env.STREAM_MAX_BITRATE)
    })
  });

  const payload: unknown = await response.json().catch(() => ({}));

  if (response.status === 401) {
    throw new JellyfinError("jellyfin_token_invalid", "Jellyfin account needs to be linked again.", response.status, payload);
  }

  if (response.status === 403) {
    throw new JellyfinError("jellyfin_access_denied", "Jellyfin denied playback access.", response.status, payload);
  }

  if (!response.ok) {
    throw new JellyfinError("jellyfin_playback_failed", "Could not prepare Jellyfin playback.", response.status, payload);
  }

  const result = playbackInfoResponseSchema.parse(payload);
  const source = input.mediaSourceId
    ? result.MediaSources.find((candidate) => candidate.Id === input.mediaSourceId)
    : result.MediaSources[0];

  if (!source) {
    throw new JellyfinError("jellyfin_media_source_missing", "No playable Jellyfin media source was returned.", response.status, payload);
  }

  return selectPlaybackMethod(env, input, source);
}

function selectPlaybackMethod(
  env: AppEnv,
  input: PlaybackInfoInput,
  source: z.infer<typeof mediaSourceSchema>
): PreparedPlayback {
  const streams = source.MediaStreams ?? [];
  const audioTracks = streams.filter((stream) => stream.Type === "Audio" && stream.Index !== undefined).map((stream) => mapTrack(stream, "Audio"));
  const subtitleTracks = streams.filter((stream) => stream.Type === "Subtitle" && stream.Index !== undefined).map((stream) => mapTrack(stream, "Subtitle"));
  const selectedAudioStreamIndex = input.audioStreamIndex ?? audioTracks.find((track) => track.isDefault)?.index ?? audioTracks[0]?.index;
  const selectedSubtitleStreamIndex = input.subtitleStreamIndex ?? -1;
  const videoCodec = streams.find((stream) => stream.Type === "Video")?.Codec ?? undefined;
  const audioCodec = streams.find((stream) => stream.Type === "Audio")?.Codec ?? undefined;
  const tracks = {
    ...(selectedAudioStreamIndex !== undefined ? { selectedAudioStreamIndex } : {}),
    selectedSubtitleStreamIndex,
    audioTracks,
    subtitleTracks
  };

  if (env.STREAM_PROXY_MODE !== "direct" && source.SupportsTranscoding !== false) {
    return {
      itemId: input.itemId,
      mediaSourceId: source.Id,
      playMethod: "hls",
      upstreamPath: buildHlsPath(input, source, env.STREAM_MAX_BITRATE),
      ...(source.TranscodingContainer ? { container: source.TranscodingContainer } : {}),
      ...(videoCodec ? { videoCodec } : {}),
      ...(audioCodec ? { audioCodec } : {}),
      ...tracks
    };
  }

  if (source.SupportsDirectPlay === false && source.SupportsDirectStream === false) {
    throw new JellyfinError("jellyfin_direct_play_unavailable", "Jellyfin did not return a direct playable media source.", 200, source);
  }

  const container = source.Container?.split(",")[0]?.trim() || "mp4";

  return {
    itemId: input.itemId,
    mediaSourceId: source.Id,
    playMethod: "direct",
    upstreamPath: buildDirectPath(input, source.Id, container),
    container,
    ...(videoCodec ? { videoCodec } : {}),
    ...(audioCodec ? { audioCodec } : {}),
    ...tracks
  };
}

function buildHlsPath(input: PlaybackInfoInput, source: z.infer<typeof mediaSourceSchema>, maxBitrate: number): string {
  const url = new URL(`/Videos/${encodeURIComponent(input.itemId)}/master.m3u8`, "https://jellyfin.local");
  const params = url.searchParams;

  params.set("MediaSourceId", source.Id);
  params.set("VideoCodec", "h264");
  params.set("AudioCodec", "aac");
  params.set("MaxStreamingBitrate", String(input.maxStreamingBitrate ?? maxBitrate));

  if (input.audioStreamIndex !== undefined) {
    params.set("AudioStreamIndex", String(input.audioStreamIndex));
  }

  if (isSelectedSubtitleStream(input.subtitleStreamIndex)) {
    params.set("SubtitleStreamIndex", String(input.subtitleStreamIndex));
    params.set("SubtitleMethod", "Encode");
  }

  return `${url.pathname}?${params.toString()}`;
}

function buildDirectPath(input: PlaybackInfoInput, mediaSourceId: string, container: string): string {
  const params = new URLSearchParams({
    Static: "true",
    MediaSourceId: mediaSourceId
  });

  if (input.audioStreamIndex !== undefined) {
    params.set("AudioStreamIndex", String(input.audioStreamIndex));
  }

  if (isSelectedSubtitleStream(input.subtitleStreamIndex)) {
    params.set("SubtitleStreamIndex", String(input.subtitleStreamIndex));
  }

  return `/Videos/${encodeURIComponent(input.itemId)}/stream.${encodeURIComponent(container)}?${params.toString()}`;
}

function isSelectedSubtitleStream(index: number | undefined): index is number {
  return index !== undefined && index >= 0;
}

function mapTrack(stream: NonNullable<z.infer<typeof mediaSourceSchema>["MediaStreams"]>[number], type: "Audio" | "Subtitle"): PlaybackTrack {
  const index = stream.Index ?? 0;
  const codec = stream.Codec?.trim();
  const language = stream.Language?.trim();
  const title = stream.Title?.trim();
  const displayTitle = stream.DisplayTitle?.trim();
  const fallbackLabel = [
    type,
    language?.toUpperCase(),
    codec?.toUpperCase()
  ].filter(Boolean).join(" ");

  return {
    index,
    type,
    label: displayTitle || title || fallbackLabel || `${type} ${index}`,
    ...(codec ? { codec } : {}),
    ...(language ? { language } : {}),
    ...(title ? { title } : {}),
    ...(stream.IsDefault !== undefined ? { isDefault: stream.IsDefault } : {}),
    ...(stream.IsForced !== undefined ? { isForced: stream.IsForced } : {}),
    ...(stream.IsExternal !== undefined ? { isExternal: stream.IsExternal } : {})
  };
}

function browserDeviceProfile(maxStreamingBitrate: number) {
  return {
    MaxStreamingBitrate: maxStreamingBitrate,
    MaxStaticBitrate: maxStreamingBitrate,
    MusicStreamingTranscodingBitrate: Math.min(maxStreamingBitrate, 1_500_000),
    DirectPlayProfiles: [
      {
        Type: "Video",
        Container: "mp4,m4v",
        VideoCodec: "h264",
        AudioCodec: "aac,mp3,ac3,eac3"
      },
      {
        Type: "Video",
        Container: "webm",
        VideoCodec: "vp8,vp9",
        AudioCodec: "vorbis,opus"
      },
      {
        Type: "Audio",
        Container: "mp3,aac,m4a,flac,ogg,opus,wav",
        AudioCodec: "mp3,aac,flac,vorbis,opus,pcm"
      }
    ],
    TranscodingProfiles: [
      {
        Type: "Video",
        Context: "Streaming",
        Protocol: "hls",
        Container: "ts",
        VideoCodec: "h264",
        AudioCodec: "aac",
        MaxAudioChannels: "2",
        MinSegments: "1",
        SegmentLength: 6,
        BreakOnNonKeyFrames: true
      },
      {
        Type: "Video",
        Context: "Streaming",
        Protocol: "http",
        Container: "mp4",
        VideoCodec: "h264",
        AudioCodec: "aac",
        MaxAudioChannels: "2"
      }
    ],
    SubtitleProfiles: [
      { Format: "vtt", Method: "External" },
      { Format: "srt", Method: "External" },
      { Format: "ass", Method: "External" },
      { Format: "ssa", Method: "External" }
    ]
  };
}

function jellyfinAuthorizationHeader(token: string): string {
  const parts = [
    `Client="${escapeHeaderValue("Jellyfin Discord Activity")}"`,
    `Device="${escapeHeaderValue("Discord Activity Backend")}"`,
    `DeviceId="${escapeHeaderValue("jellyfin-discord-activity-backend")}"`,
    `Version="${escapeHeaderValue("0.1.0")}"`,
    `Token="${escapeHeaderValue(token)}"`
  ];

  return `MediaBrowser ${parts.join(", ")}`;
}

function escapeHeaderValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}
