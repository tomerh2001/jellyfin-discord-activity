import {
  apiErrorSchema,
  discordExchangeResponseSchema,
  healthSchema,
  jellyfinItemDetailsResponseSchema,
  jellyfinItemsResponseSchema,
  jellyfinLibrariesResponseSchema,
  jellyfinLinkResponseSchema,
  playbackPrepareResponseSchema,
  jellyfinStatusSchema,
  jellyfinUnlinkResponseSchema,
  meResponseSchema,
  publicEnvSchema,
  roomResponseSchema,
  type ClaimHostRequest,
  type DiscordExchangeRequest,
  type DiscordExchangeResponse,
  type HealthResponse,
  type JellyfinItemDetailsResponse,
  type JellyfinItemsResponse,
  type JellyfinLibrariesResponse,
  type JellyfinLinkRequest,
  type JellyfinLinkResponse,
  type JellyfinStatus,
  type JellyfinUnlinkResponse,
  type MeResponse,
  type PlaybackPrepareRequest,
  type PlaybackPrepareResponse,
  type PublicEnv,
  type RoomResponse,
  type SelectMediaRequest
} from "@app/shared";
import { env } from "../env.js";

function apiUrl(path: string): string {
  return `${env.apiBaseUrl}${path}`;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type");

  if (!contentType?.includes("application/json")) {
    return undefined;
  }

  return response.json() as Promise<unknown>;
}

async function parseApiError(response: Response): Promise<Error> {
  const payload = await parseJsonResponse(response);
  const parsed = apiErrorSchema.safeParse(payload);

  if (parsed.success) {
    return new Error(parsed.data.error.message);
  }

  return new Error(`Request failed with ${response.status}`);
}

export async function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const response = await fetch(apiUrl("/health"), signal ? { signal } : undefined);

  if (!response.ok) {
    throw await parseApiError(response);
  }

  return healthSchema.parse(await response.json());
}

export async function getPublicConfig(signal?: AbortSignal): Promise<PublicEnv> {
  const response = await fetch(apiUrl("/api/config"), signal ? { signal } : undefined);

  if (!response.ok) {
    throw await parseApiError(response);
  }

  const config = publicEnvSchema.parse(await response.json());

  return {
    ...config,
    publicDiscordClientId: env.publicDiscordClientId || config.publicDiscordClientId
  };
}

export async function exchangeDiscordCode(input: DiscordExchangeRequest, signal?: AbortSignal): Promise<DiscordExchangeResponse> {
  const response = await fetch(apiUrl("/api/discord/exchange"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input),
    ...(signal ? { signal } : {})
  });

  if (!response.ok) {
    throw await parseApiError(response);
  }

  return discordExchangeResponseSchema.parse(await response.json());
}

export async function getMe(appToken: string, signal?: AbortSignal): Promise<MeResponse> {
  const response = await fetch(apiUrl("/api/me"), {
    headers: {
      Authorization: `Bearer ${appToken}`
    },
    ...(signal ? { signal } : {})
  });

  if (!response.ok) {
    throw await parseApiError(response);
  }

  return meResponseSchema.parse(await response.json());
}

export async function logout(appToken: string): Promise<void> {
  await fetch(apiUrl("/api/logout"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appToken}`
    }
  });
}

export async function getJellyfinStatus(appToken: string, signal?: AbortSignal): Promise<JellyfinStatus> {
  const response = await fetch(apiUrl("/api/jellyfin/status"), {
    headers: {
      Authorization: `Bearer ${appToken}`
    },
    ...(signal ? { signal } : {})
  });

  if (!response.ok) {
    throw await parseApiError(response);
  }

  return jellyfinStatusSchema.parse(await response.json());
}

export async function linkJellyfinAccount(appToken: string, input: JellyfinLinkRequest): Promise<JellyfinLinkResponse> {
  const response = await fetch(apiUrl("/api/jellyfin/link"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });

  if (!response.ok) {
    throw await parseApiError(response);
  }

  return jellyfinLinkResponseSchema.parse(await response.json());
}

export async function unlinkJellyfinAccount(appToken: string): Promise<JellyfinUnlinkResponse> {
  const response = await fetch(apiUrl("/api/jellyfin/link"), {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${appToken}`
    }
  });

  if (!response.ok) {
    throw await parseApiError(response);
  }

  return jellyfinUnlinkResponseSchema.parse(await response.json());
}

export async function getJellyfinLibraries(appToken: string, signal?: AbortSignal): Promise<JellyfinLibrariesResponse> {
  const response = await fetch(apiUrl("/api/jellyfin/libraries"), {
    headers: {
      Authorization: `Bearer ${appToken}`
    },
    ...(signal ? { signal } : {})
  });

  if (!response.ok) {
    throw await parseApiError(response);
  }

  return jellyfinLibrariesResponseSchema.parse(await response.json());
}

export async function getJellyfinItems(appToken: string, input: {
  parentId?: string;
  query?: string;
  type?: string;
  recursive?: boolean;
  parentIndexNumber?: number;
  startIndex?: number;
  limit?: number;
}, signal?: AbortSignal): Promise<JellyfinItemsResponse> {
  const params = new URLSearchParams();

  if (input.parentId) {
    params.set("parentId", input.parentId);
  }

  if (input.query) {
    params.set("query", input.query);
  }

  if (input.type) {
    params.set("type", input.type);
  }

  if (input.recursive !== undefined) {
    params.set("recursive", String(input.recursive));
  }

  if (input.parentIndexNumber !== undefined) {
    params.set("parentIndexNumber", String(input.parentIndexNumber));
  }

  if (input.startIndex !== undefined) {
    params.set("startIndex", String(input.startIndex));
  }

  if (input.limit) {
    params.set("limit", String(input.limit));
  }

  const response = await fetch(apiUrl(`/api/jellyfin/items?${params.toString()}`), {
    headers: {
      Authorization: `Bearer ${appToken}`
    },
    ...(signal ? { signal } : {})
  });

  if (!response.ok) {
    throw await parseApiError(response);
  }

  return jellyfinItemsResponseSchema.parse(await response.json());
}

export async function getJellyfinItem(appToken: string, itemId: string, signal?: AbortSignal): Promise<JellyfinItemDetailsResponse> {
  const response = await fetch(apiUrl(`/api/jellyfin/items/${encodeURIComponent(itemId)}`), {
    headers: {
      Authorization: `Bearer ${appToken}`
    },
    ...(signal ? { signal } : {})
  });

  if (!response.ok) {
    throw await parseApiError(response);
  }

  return jellyfinItemDetailsResponseSchema.parse(await response.json());
}

export async function getJellyfinItemImage(appToken: string, itemId: string, input: {
  width?: number;
  height?: number;
  tag?: string | null;
}, signal?: AbortSignal): Promise<Blob> {
  const params = new URLSearchParams();

  if (input.width) {
    params.set("width", String(input.width));
  }

  if (input.height) {
    params.set("height", String(input.height));
  }

  if (input.tag) {
    params.set("tag", input.tag);
  }

  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  const response = await fetch(apiUrl(`/api/jellyfin/items/${encodeURIComponent(itemId)}/image${suffix}`), {
    headers: {
      Authorization: `Bearer ${appToken}`
    },
    ...(signal ? { signal } : {})
  });

  if (!response.ok) {
    throw await parseApiError(response);
  }

  return response.blob();
}

export async function getCurrentRoom(appToken: string, instanceId: string, signal?: AbortSignal): Promise<RoomResponse> {
  const response = await fetch(apiUrl(`/api/rooms/current?instanceId=${encodeURIComponent(instanceId)}`), {
    headers: { Authorization: `Bearer ${appToken}` }, ...(signal ? { signal } : {})
  });

  if (!response.ok) {
    throw await parseApiError(response);
  }

  return roomResponseSchema.parse(await response.json());
}

export async function claimRoomHost(appToken: string, input: ClaimHostRequest): Promise<RoomResponse> {
  const response = await fetch(apiUrl("/api/rooms/current/claim-host"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });

  if (!response.ok) {
    throw await parseApiError(response);
  }

  return roomResponseSchema.parse(await response.json());
}

export async function selectRoomMedia(appToken: string, input: SelectMediaRequest): Promise<RoomResponse> {
  const response = await fetch(apiUrl("/api/rooms/current/select-media"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });

  if (!response.ok) {
    throw await parseApiError(response);
  }

  return roomResponseSchema.parse(await response.json());
}

export async function preparePlayback(appToken: string, input: PlaybackPrepareRequest): Promise<PlaybackPrepareResponse> {
  const response = await fetch(apiUrl("/api/playback/prepare"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });

  if (!response.ok) {
    throw await parseApiError(response);
  }

  return playbackPrepareResponseSchema.parse(await response.json());
}
