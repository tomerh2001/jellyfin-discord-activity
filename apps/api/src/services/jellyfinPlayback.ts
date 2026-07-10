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
    Width: z.number().int().optional(),
    Height: z.number().int().optional(),
    BitRate: z.number().int().optional(),
    DisplayTitle: z.string().nullable().optional(),
    Title: z.string().nullable().optional(),
    Language: z.string().nullable().optional(),
    IsDefault: z.boolean().optional(),
    IsForced: z.boolean().optional(),
    IsExternal: z.boolean().optional()
  })).optional()
});

const playbackInfoResponseSchema = z.object({
  PlaySessionId: z.string().nullable().optional(),
  MediaSources: z.array(mediaSourceSchema).default([])
});

export type PlaybackInfoInput = {
  itemId: string;
  mediaSourceId?: string | undefined;
  audioStreamIndex?: number | undefined;
  subtitleStreamIndex?: number | undefined;
  maxStreamingBitrate?: number | undefined;
  preferredPlayMethod?: "hls" | "direct" | "webm" | undefined;
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

type MediaSource = z.infer<typeof mediaSourceSchema>;

type PlaybackQuality = {
  maxStreamingBitrate: number;
  maxWidth: number;
  maxHeight: number;
  videoBitrate: number;
  audioBitrate: number;
};

const browserVideoCodecs = new Set(["h264", "avc", "avc1", "vp8", "vp9", "av1"]);
const browserAudioCodecs = new Set(["aac", "mp3", "mp4a", "opus", "vorbis", "flac"]);
const browserContainers = new Set(["mp4", "m4v", "webm", "mov"]);

export async function getPlaybackInfo(env: AppEnv, account: JellyfinAccount, input: PlaybackInfoInput): Promise<PreparedPlayback> {
  const token = decryptString(env, account.encryptedAccessToken);
  const url = new URL(`${account.serverUrl}/Items/${encodeURIComponent(input.itemId)}/PlaybackInfo`);
  const quality = playbackQuality(env, input);

  url.searchParams.set("UserId", account.jellyfinUserId);
  url.searchParams.set("MaxStreamingBitrate", String(quality.maxStreamingBitrate));
  url.searchParams.set("MaxWidth", String(quality.maxWidth));
  url.searchParams.set("MaxHeight", String(quality.maxHeight));
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
      DeviceProfile: browserDeviceProfile(quality)
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

  return selectPlaybackMethod(env, input, source, result.PlaySessionId ?? undefined);
}

function selectPlaybackMethod(
  env: AppEnv,
  input: PlaybackInfoInput,
  source: MediaSource,
  playSessionId?: string
): PreparedPlayback {
  const streams = source.MediaStreams ?? [];
  const audioTracks = streams.filter((stream) => stream.Type === "Audio" && stream.Index !== undefined).map((stream) => mapTrack(stream, "Audio"));
  const subtitleTracks = streams.filter((stream) => stream.Type === "Subtitle" && stream.Index !== undefined).map((stream) => mapTrack(stream, "Subtitle"));
  const selectedAudioStreamIndex = input.audioStreamIndex ?? audioTracks.find((track) => track.isDefault)?.index ?? audioTracks[0]?.index;
  const selectedSubtitleStreamIndex = input.subtitleStreamIndex ?? -1;
  const selectedAudio = selectedAudioStreamIndex !== undefined
    ? streams.find((stream) => stream.Type === "Audio" && stream.Index === selectedAudioStreamIndex)
    : streams.find((stream) => stream.Type === "Audio");
  const videoStream = streams.find((stream) => stream.Type === "Video");
  const videoCodec = videoStream?.Codec ?? undefined;
  const audioCodec = selectedAudio?.Codec ?? streams.find((stream) => stream.Type === "Audio")?.Codec ?? undefined;
  const tracks = {
    ...(selectedAudioStreamIndex !== undefined ? { selectedAudioStreamIndex } : {}),
    selectedSubtitleStreamIndex,
    audioTracks,
    subtitleTracks
  };
  const remuxEligible = canRemuxBrowserSafe(source, videoCodec, audioCodec);
  const forceCompatDirect = input.preferredPlayMethod === "direct";
  const forceCompatWebm = input.preferredPlayMethod === "webm";
  const forceDeploymentDirect = env.STREAM_PROXY_MODE === "direct";
  const forceHls = input.preferredPlayMethod === "hls";

  // Client compatibility: progressive WebM (VP9/Opus) for clients that reject H.264
  // (common on some Linux Electron builds without proprietary codecs).
  if (forceCompatWebm) {
    if (source.SupportsTranscoding !== false) {
      return {
        itemId: input.itemId,
        mediaSourceId: source.Id,
        playMethod: "direct",
        upstreamPath: buildTranscodeWebmPath(env, input, source, playSessionId),
        container: "webm",
        videoCodec: "vp9",
        audioCodec: "opus",
        ...tracks
      };
    }

    throw new JellyfinError("jellyfin_direct_play_unavailable", "Jellyfin could not prepare a WebM compatibility stream.", 200, source);
  }

  // Client compatibility path: always re-encode to progressive H.264/AAC MP4.
  // Static remux of the original file is rejected by some Discord clients (Linux Electron)
  // with MEDIA_ERR_SRC_NOT_SUPPORTED even when codecs report as h264/aac.
  if (forceCompatDirect) {
    if (source.SupportsTranscoding !== false) {
      return {
        itemId: input.itemId,
        mediaSourceId: source.Id,
        playMethod: "direct",
        upstreamPath: buildTranscodeHttpPath(env, input, source, playSessionId),
        container: "mp4",
        videoCodec: "h264",
        audioCodec: "aac",
        ...tracks
      };
    }

    if (remuxEligible) {
      return buildRemuxPlayback(input, source, videoCodec, audioCodec, tracks);
    }

    throw new JellyfinError("jellyfin_direct_play_unavailable", "Jellyfin did not return a direct playable media source.", 200, source);
  }

  // Deployment STREAM_PROXY_MODE=direct: prefer remux, else progressive transcode.
  if (forceDeploymentDirect) {
    if (remuxEligible) {
      return buildRemuxPlayback(input, source, videoCodec, audioCodec, tracks);
    }

    if (source.SupportsTranscoding !== false) {
      return {
        itemId: input.itemId,
        mediaSourceId: source.Id,
        playMethod: "direct",
        upstreamPath: buildTranscodeHttpPath(env, input, source, playSessionId),
        container: "mp4",
        videoCodec: "h264",
        audioCodec: "aac",
        ...tracks
      };
    }

    throw new JellyfinError("jellyfin_direct_play_unavailable", "Jellyfin did not return a direct playable media source.", 200, source);
  }

  // Prefer lossless remux when the client did not force HLS and Jellyfin allows it.
  if (!forceHls && remuxEligible) {
    return buildRemuxPlayback(input, source, videoCodec, audioCodec, tracks);
  }

  // HLS (prefer Jellyfin's TranscodingUrl when it is HLS).
  if (source.SupportsTranscoding !== false || isHlsTranscodingUrl(source)) {
    const hlsPath = resolveHlsPath(env, input, source, playSessionId);

    return {
      itemId: input.itemId,
      mediaSourceId: source.Id,
      playMethod: "hls",
      upstreamPath: hlsPath,
      ...(source.TranscodingContainer ? { container: source.TranscodingContainer } : { container: "ts" }),
      ...(videoCodec ? { videoCodec } : {}),
      ...(audioCodec ? { audioCodec } : {}),
      ...tracks
    };
  }

  if (source.SupportsDirectPlay === false && source.SupportsDirectStream === false) {
    throw new JellyfinError("jellyfin_direct_play_unavailable", "Jellyfin did not return a direct playable media source.", 200, source);
  }

  return buildRemuxPlayback(input, source, videoCodec, audioCodec, tracks);
}

function buildRemuxPlayback(
  input: PlaybackInfoInput,
  source: MediaSource,
  videoCodec: string | undefined,
  audioCodec: string | undefined,
  tracks: {
    selectedAudioStreamIndex?: number;
    selectedSubtitleStreamIndex: number;
    audioTracks: PlaybackTrack[];
    subtitleTracks: PlaybackTrack[];
  }
): PreparedPlayback {
  const sourceContainer = firstContainer(source.Container);
  const container = isBrowserContainer(sourceContainer) ? sourceContainer : "mp4";
  const useStatic = isBrowserContainer(sourceContainer) && source.SupportsDirectPlay !== false;

  return {
    itemId: input.itemId,
    mediaSourceId: source.Id,
    playMethod: "direct",
    upstreamPath: useStatic
      ? buildDirectPath(input, source.Id, container)
      : buildRemuxStreamPath(input, source.Id, container),
    container,
    ...(videoCodec ? { videoCodec } : {}),
    ...(audioCodec ? { audioCodec } : {}),
    ...tracks
  };
}

function canRemuxBrowserSafe(
  source: MediaSource,
  videoCodec: string | undefined,
  audioCodec: string | undefined
): boolean {
  if (source.SupportsDirectPlay !== true && source.SupportsDirectStream !== true) {
    return false;
  }

  // When MediaStreams are missing, trust Jellyfin's DirectPlay/DirectStream flags.
  if (!videoCodec && !audioCodec) {
    return true;
  }

  if (videoCodec && !isBrowserVideoCodec(videoCodec)) {
    return false;
  }

  if (audioCodec && !isBrowserAudioCodec(audioCodec)) {
    return false;
  }

  return true;
}

function isBrowserVideoCodec(codec: string | undefined): boolean {
  return normalizeCodec(codec) !== undefined && browserVideoCodecs.has(normalizeCodec(codec)!);
}

function isBrowserAudioCodec(codec: string | undefined): boolean {
  return normalizeCodec(codec) !== undefined && browserAudioCodecs.has(normalizeCodec(codec)!);
}

function isBrowserContainer(container: string | undefined): boolean {
  return Boolean(container && browserContainers.has(container.toLowerCase()));
}

function normalizeCodec(codec: string | undefined): string | undefined {
  return codec?.trim().toLowerCase().replace(/[^a-z0-9]/g, "") || undefined;
}

function firstContainer(container: string | null | undefined): string {
  return container?.split(",")[0]?.trim().toLowerCase() || "mp4";
}

function isHlsTranscodingUrl(source: MediaSource): boolean {
  if (!source.TranscodingUrl) {
    return false;
  }

  const protocol = source.TranscodingSubProtocol?.toLowerCase();
  if (protocol === "hls") {
    return true;
  }

  return source.TranscodingUrl.includes(".m3u8");
}

function resolveHlsPath(
  env: AppEnv,
  input: PlaybackInfoInput,
  source: MediaSource,
  playSessionId?: string
): string {
  if (isHlsTranscodingUrl(source) && source.TranscodingUrl) {
    return sanitizeUpstreamPath(source.TranscodingUrl, playSessionId);
  }

  return buildHlsPath(env, input, source, playSessionId);
}

function sanitizeUpstreamPath(transcodingUrl: string, playSessionId?: string): string {
  const url = new URL(transcodingUrl, "https://jellyfin.local");
  url.searchParams.delete("ApiKey");
  url.searchParams.delete("api_key");

  if (playSessionId && !url.searchParams.get("PlaySessionId")) {
    url.searchParams.set("PlaySessionId", playSessionId);
  }

  return `${url.pathname}${url.search}${url.hash}`;
}

function playbackQuality(env: AppEnv, input: PlaybackInfoInput): PlaybackQuality {
  const maxStreamingBitrate = input.maxStreamingBitrate ?? env.STREAM_MAX_BITRATE;
  const audioBitrate = Math.min(384_000, Math.max(128_000, Math.floor(maxStreamingBitrate * 0.04)));
  const videoBitrate = Math.max(1_000_000, maxStreamingBitrate - audioBitrate);

  return {
    maxStreamingBitrate,
    maxWidth: env.STREAM_MAX_WIDTH,
    maxHeight: env.STREAM_MAX_HEIGHT,
    videoBitrate,
    audioBitrate
  };
}

function buildHlsPath(env: AppEnv, input: PlaybackInfoInput, source: MediaSource, playSessionId?: string): string {
  const url = new URL(`/Videos/${encodeURIComponent(input.itemId)}/master.m3u8`, "https://jellyfin.local");
  const params = url.searchParams;
  const quality = playbackQuality(env, input);

  params.set("MediaSourceId", source.Id);
  params.set("VideoCodec", "h264");
  params.set("AudioCodec", "aac");
  params.set("VideoBitrate", String(quality.videoBitrate));
  params.set("AudioBitrate", String(quality.audioBitrate));
  params.set("MaxStreamingBitrate", String(quality.maxStreamingBitrate));
  params.set("MaxWidth", String(quality.maxWidth));
  params.set("MaxHeight", String(quality.maxHeight));
  params.set("TranscodingMaxAudioChannels", "2");
  params.set("SegmentContainer", "ts");
  params.set("BreakOnNonKeyFrames", "true");
  params.set("RequireAvc", "false");

  if (playSessionId) {
    params.set("PlaySessionId", playSessionId);
  }

  if (input.audioStreamIndex !== undefined) {
    params.set("AudioStreamIndex", String(input.audioStreamIndex));
  }

  if (isSelectedSubtitleStream(input.subtitleStreamIndex)) {
    params.set("SubtitleStreamIndex", String(input.subtitleStreamIndex));
    params.set("SubtitleMethod", "Encode");
  }

  return `${url.pathname}?${params.toString()}`;
}

function buildTranscodeHttpPath(env: AppEnv, input: PlaybackInfoInput, source: MediaSource, playSessionId?: string): string {
  const url = new URL(`/Videos/${encodeURIComponent(input.itemId)}/stream.mp4`, "https://jellyfin.local");
  const params = url.searchParams;
  const quality = playbackQuality(env, input);
  // Cap progressive compatibility streams a bit lower so the first fragments arrive faster
  // through Discord's Activity proxy on constrained clients (Linux Electron).
  const streamingBitrate = Math.min(quality.maxStreamingBitrate, 12_000_000);
  const audioBitrate = Math.min(192_000, Math.max(128_000, Math.floor(streamingBitrate * 0.04)));
  const videoBitrate = Math.max(1_000_000, streamingBitrate - audioBitrate);

  params.set("MediaSourceId", source.Id);
  params.set("VideoCodec", "h264");
  params.set("AudioCodec", "aac");
  params.set("VideoBitrate", String(videoBitrate));
  params.set("AudioBitrate", String(audioBitrate));
  params.set("MaxStreamingBitrate", String(streamingBitrate));
  params.set("MaxWidth", String(Math.min(quality.maxWidth, 1920)));
  params.set("MaxHeight", String(Math.min(quality.maxHeight, 1080)));
  params.set("TranscodingMaxAudioChannels", "2");
  params.set("MaxAudioChannels", "2");
  params.set("RequireAvc", "true");
  params.set("Profile", "high");
  params.set("Level", "41");
  params.set("CopyTimestamps", "true");
  params.set("EnableMpegtsM2TsMode", "false");

  if (playSessionId) {
    params.set("PlaySessionId", playSessionId);
  }

  if (input.audioStreamIndex !== undefined) {
    params.set("AudioStreamIndex", String(input.audioStreamIndex));
  }

  if (isSelectedSubtitleStream(input.subtitleStreamIndex)) {
    params.set("SubtitleStreamIndex", String(input.subtitleStreamIndex));
    params.set("SubtitleMethod", "Encode");
  }

  return `${url.pathname}?${params.toString()}`;
}

function buildTranscodeWebmPath(env: AppEnv, input: PlaybackInfoInput, source: MediaSource, playSessionId?: string): string {
  const url = new URL(`/Videos/${encodeURIComponent(input.itemId)}/stream.webm`, "https://jellyfin.local");
  const params = url.searchParams;
  const quality = playbackQuality(env, input);
  const streamingBitrate = Math.min(quality.maxStreamingBitrate, 8_000_000);
  const audioBitrate = Math.min(160_000, Math.max(96_000, Math.floor(streamingBitrate * 0.04)));
  const videoBitrate = Math.max(800_000, streamingBitrate - audioBitrate);

  params.set("MediaSourceId", source.Id);
  params.set("VideoCodec", "vp9");
  params.set("AudioCodec", "opus");
  params.set("VideoBitrate", String(videoBitrate));
  params.set("AudioBitrate", String(audioBitrate));
  params.set("MaxStreamingBitrate", String(streamingBitrate));
  params.set("MaxWidth", String(Math.min(quality.maxWidth, 1280)));
  params.set("MaxHeight", String(Math.min(quality.maxHeight, 720)));
  params.set("TranscodingMaxAudioChannels", "2");
  params.set("MaxAudioChannels", "2");
  params.set("CopyTimestamps", "true");

  if (playSessionId) {
    params.set("PlaySessionId", playSessionId);
  }

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

function buildRemuxStreamPath(input: PlaybackInfoInput, mediaSourceId: string, container: string): string {
  const params = new URLSearchParams({
    MediaSourceId: mediaSourceId,
    Static: "false"
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

function mapTrack(stream: NonNullable<MediaSource["MediaStreams"]>[number], type: "Audio" | "Subtitle"): PlaybackTrack {
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

function browserDeviceProfile(quality: PlaybackQuality) {
  return {
    MaxStreamingBitrate: quality.maxStreamingBitrate,
    MaxStaticBitrate: quality.maxStreamingBitrate,
    MusicStreamingTranscodingBitrate: Math.min(quality.maxStreamingBitrate, 1_500_000),
    DirectPlayProfiles: [
      {
        Type: "Video",
        Container: "mp4,m4v,mov",
        VideoCodec: "h264,vp8,vp9,av1",
        AudioCodec: "aac,mp3,opus,flac,ac3,eac3"
      },
      {
        Type: "Video",
        Container: "webm",
        VideoCodec: "vp8,vp9,av1",
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
        MaxWidth: String(quality.maxWidth),
        MaxHeight: String(quality.maxHeight),
        MaxAudioChannels: "2",
        MinSegments: "1",
        SegmentLength: 6,
        BreakOnNonKeyFrames: true,
        CopyTimestamps: true
      },
      {
        Type: "Video",
        Context: "Streaming",
        Protocol: "http",
        Container: "mp4",
        VideoCodec: "h264",
        AudioCodec: "aac",
        MaxWidth: String(quality.maxWidth),
        MaxHeight: String(quality.maxHeight),
        MaxAudioChannels: "2",
        EstimateContentLength: false,
        EnableMpegtsM2TsMode: false,
        TranscodeSeekInfo: "Auto",
        CopyTimestamps: true
      }
    ],
    CodecProfiles: [
      {
        Type: "Video",
        Codec: "h264",
        Conditions: [
          {
            Condition: "NotEquals",
            Property: "IsAnamorphic",
            Value: "true",
            IsRequired: false
          },
          {
            Condition: "EqualsAny",
            Property: "VideoProfile",
            Value: "high|main|baseline|constrained baseline",
            IsRequired: false
          },
          {
            Condition: "LessThanEqual",
            Property: "VideoLevel",
            Value: "51",
            IsRequired: false
          }
        ]
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
