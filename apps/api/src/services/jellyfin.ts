import { z } from "zod";
import type { AppEnv } from "../env.js";
import { decryptString } from "./crypto.js";
import type { StoredJellyfinAccount } from "./jellyfinAccountStore.js";

const authenticationResultSchema = z.object({
  User: z.object({
    Id: z.string().min(1),
    Name: z.string().min(1)
  }),
  AccessToken: z.string().min(1),
  ServerId: z.string().optional()
});

const librariesResponseSchema = z.object({
  Items: z.array(z.object({
    Id: z.string().min(1),
    Name: z.string().min(1),
    CollectionType: z.string().nullable().optional()
  })).default([])
});

const itemDtoSchema = z.object({
  Id: z.string().min(1),
  Name: z.string().min(1),
  Type: z.string().min(1),
  Overview: z.string().nullable().optional(),
  ParentId: z.string().nullable().optional(),
  SeriesId: z.string().nullable().optional(),
  SeriesName: z.string().nullable().optional(),
  SeasonName: z.string().nullable().optional(),
  SeriesPrimaryImageTag: z.string().nullable().optional(),
  ProductionYear: z.number().int().nullable().optional(),
  IndexNumber: z.number().int().nullable().optional(),
  ParentIndexNumber: z.number().int().nullable().optional(),
  RunTimeTicks: z.number().int().nonnegative().nullable().optional(),
  ImageTags: z.object({
    Primary: z.string().nullable().optional()
  }).optional()
});

const itemsResponseSchema = z.object({
  Items: z.array(itemDtoSchema).default([]),
  TotalRecordCount: z.number().int().nonnegative().default(0)
});

export type JellyfinAuthResult = {
  userId: string;
  username: string;
  accessToken: string;
};

export type JellyfinAccount = StoredJellyfinAccount;

export type JellyfinLibrary = {
  id: string;
  name: string;
  collectionType?: string | null;
};

export type JellyfinItem = {
  id: string;
  name: string;
  type: string;
  overview?: string | null;
  parentId?: string | null;
  seriesName?: string | null;
  seasonName?: string | null;
  productionYear?: number | null;
  indexNumber?: number | null;
  parentIndexNumber?: number | null;
  runtimeTicks?: number | null;
  imageItemId?: string | null;
  imageTag?: string | null;
};

export type SearchItemsInput = {
  parentId?: string | undefined;
  query?: string | undefined;
  type?: string | undefined;
  recursive: boolean;
  parentIndexNumber?: number | undefined;
  startIndex: number;
  limit: number;
};

export function resolveJellyfinServerUrl(env: AppEnv, serverUrl?: string): string {
  const resolved = env.JELLYFIN_ALLOW_CUSTOM_SERVERS && serverUrl
    ? serverUrl
    : env.JELLYFIN_DEFAULT_SERVER_URL;

  return normalizeServerUrl(resolved);
}

export async function authenticateByName(input: {
  env: AppEnv;
  serverUrl: string;
  username: string;
  password: string;
}): Promise<JellyfinAuthResult> {
  const response = await fetch(`${input.serverUrl}/Users/AuthenticateByName`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Emby-Authorization": jellyfinAuthorizationHeader()
    },
    body: JSON.stringify({
      Username: input.username,
      Pw: input.password
    })
  });

  const payload: unknown = await response.json().catch(() => ({}));

  if (response.status === 401) {
    throw new JellyfinError("invalid_jellyfin_credentials", "Invalid Jellyfin username or password.", response.status, payload);
  }

  if (!response.ok) {
    throw new JellyfinError("jellyfin_auth_failed", "Jellyfin authentication failed.", response.status, payload);
  }

  const result = authenticationResultSchema.parse(payload);

  return {
    userId: result.User.Id,
    username: result.User.Name,
    accessToken: result.AccessToken
  };
}

export async function getLibraries(env: AppEnv, account: JellyfinAccount): Promise<JellyfinLibrary[]> {
  const token = decryptString(env, account.encryptedAccessToken);
  const response = await fetch(`${account.serverUrl}/Users/${encodeURIComponent(account.jellyfinUserId)}/Views`, {
    headers: {
      Authorization: jellyfinAuthorizationHeader(token)
    }
  });

  const payload: unknown = await response.json().catch(() => ({}));

  if (response.status === 401) {
    throw new JellyfinError("jellyfin_token_invalid", "Jellyfin account needs to be linked again.", response.status, payload);
  }

  if (response.status === 403) {
    throw new JellyfinError("jellyfin_access_denied", "Jellyfin denied access to libraries.", response.status, payload);
  }

  if (!response.ok) {
    throw new JellyfinError("jellyfin_libraries_failed", "Could not load Jellyfin libraries.", response.status, payload);
  }

  const result = librariesResponseSchema.parse(payload);

  return result.Items.map((item) => ({
    id: item.Id,
    name: item.Name,
    ...(item.CollectionType !== undefined ? { collectionType: item.CollectionType } : {})
  }));
}

export async function searchItems(env: AppEnv, account: JellyfinAccount, input: SearchItemsInput): Promise<{
  items: JellyfinItem[];
  totalRecordCount: number;
}> {
  const token = decryptString(env, account.encryptedAccessToken);
  const url = new URL(`${account.serverUrl}/Users/${encodeURIComponent(account.jellyfinUserId)}/Items`);

  if (input.parentId) {
    url.searchParams.set("ParentId", input.parentId);
  }

  if (input.query?.trim()) {
    url.searchParams.set("SearchTerm", input.query.trim());
  }

  if (input.parentIndexNumber !== undefined) {
    url.searchParams.set("ParentIndexNumber", String(input.parentIndexNumber));
  }

  url.searchParams.set("IncludeItemTypes", input.type?.trim() || "Movie,Episode");
  url.searchParams.set("Recursive", String(input.recursive));
  url.searchParams.set("StartIndex", String(input.startIndex));
  url.searchParams.set("Limit", String(input.limit));
  url.searchParams.set("SortBy", input.type?.includes("Episode") && input.recursive === false ? "ParentIndexNumber,IndexNumber,SortName" : "SortName");
  url.searchParams.set("SortOrder", "Ascending");
  url.searchParams.set("Fields", "Overview,PrimaryImageAspectRatio,ProductionYear,IndexNumber,ParentIndexNumber,RunTimeTicks,ParentId,SeriesId,SeriesPrimaryImageTag");
  url.searchParams.set("ImageTypeLimit", "1");
  url.searchParams.set("EnableImageTypes", "Primary");

  const response = await fetch(url, {
    headers: {
      Authorization: jellyfinAuthorizationHeader(token)
    }
  });

  const payload: unknown = await response.json().catch(() => ({}));
  assertJellyfinResponse(response, payload, "jellyfin_items_failed", "Could not load Jellyfin items.");

  const result = itemsResponseSchema.parse(payload);

  return {
    items: result.Items.map(mapItem),
    totalRecordCount: result.TotalRecordCount
  };
}

export async function getItem(env: AppEnv, account: JellyfinAccount, itemId: string): Promise<JellyfinItem> {
  const token = decryptString(env, account.encryptedAccessToken);
  const url = new URL(`${account.serverUrl}/Users/${encodeURIComponent(account.jellyfinUserId)}/Items/${encodeURIComponent(itemId)}`);
  url.searchParams.set("Fields", "Overview,PrimaryImageAspectRatio,ProductionYear,IndexNumber,ParentIndexNumber,RunTimeTicks,ParentId,SeriesId,SeriesPrimaryImageTag");

  const response = await fetch(url, {
    headers: {
      Authorization: jellyfinAuthorizationHeader(token)
    }
  });

  const payload: unknown = await response.json().catch(() => ({}));

  if (response.status === 404) {
    throw new JellyfinError("jellyfin_item_not_found", "Jellyfin item not found.", response.status, payload);
  }

  assertJellyfinResponse(response, payload, "jellyfin_item_failed", "Could not load Jellyfin item.");

  return mapItem(itemDtoSchema.parse(payload));
}

export async function getItemImage(env: AppEnv, account: JellyfinAccount, itemId: string, input: {
  width?: number | undefined;
  height?: number | undefined;
  tag?: string | undefined;
}): Promise<{
  body: Buffer;
  contentType: string;
  cacheControl?: string | undefined;
  etag?: string | undefined;
}> {
  const token = decryptString(env, account.encryptedAccessToken);
  const url = new URL(`${account.serverUrl}/Items/${encodeURIComponent(itemId)}/Images/Primary`);
  const width = clampImageDimension(input.width, 80, 1000) ?? 320;
  const height = clampImageDimension(input.height, 80, 1500);

  url.searchParams.set("fillWidth", String(width));
  url.searchParams.set("quality", "86");

  if (height) {
    url.searchParams.set("fillHeight", String(height));
  }

  if (input.tag) {
    url.searchParams.set("tag", input.tag);
  }

  const response = await fetch(url, {
    headers: {
      Authorization: jellyfinAuthorizationHeader(token)
    }
  });

  if (response.status === 401) {
    const payload: unknown = await response.json().catch(() => ({}));
    throw new JellyfinError("jellyfin_token_invalid", "Jellyfin account needs to be linked again.", response.status, payload);
  }

  if (response.status === 403) {
    throw new JellyfinError("jellyfin_access_denied", "Jellyfin denied image access.", response.status, {});
  }

  if (response.status === 404) {
    throw new JellyfinError("jellyfin_image_not_found", "Jellyfin image not found.", response.status, {});
  }

  if (!response.ok) {
    throw new JellyfinError("jellyfin_image_failed", "Could not load Jellyfin image.", response.status, {});
  }

  return {
    body: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get("content-type") ?? "image/jpeg",
    cacheControl: response.headers.get("cache-control") ?? undefined,
    etag: response.headers.get("etag") ?? undefined
  };
}

export class JellyfinError extends Error {
  constructor(
    readonly code: string,
    readonly publicMessage: string,
    readonly statusCode: number,
    readonly details: unknown
  ) {
    super(code);
  }
}

function assertJellyfinResponse(response: Response, payload: unknown, code: string, message: string): void {
  if (response.status === 401) {
    throw new JellyfinError("jellyfin_token_invalid", "Jellyfin account needs to be linked again.", response.status, payload);
  }

  if (response.status === 403) {
    throw new JellyfinError("jellyfin_access_denied", "Jellyfin denied access.", response.status, payload);
  }

  if (!response.ok) {
    throw new JellyfinError(code, message, response.status, payload);
  }
}

function mapItem(item: z.infer<typeof itemDtoSchema>): JellyfinItem {
  const primaryImageTag = item.ImageTags?.Primary ?? item.SeriesPrimaryImageTag;
  const imageItemId = item.ImageTags?.Primary ? item.Id : item.SeriesPrimaryImageTag && item.SeriesId ? item.SeriesId : undefined;

  return {
    id: item.Id,
    name: item.Name,
    type: item.Type,
    ...(item.Overview !== undefined ? { overview: item.Overview } : {}),
    ...(item.ParentId !== undefined ? { parentId: item.ParentId } : {}),
    ...(item.SeriesName !== undefined ? { seriesName: item.SeriesName } : {}),
    ...(item.SeasonName !== undefined ? { seasonName: item.SeasonName } : {}),
    ...(item.ProductionYear !== undefined ? { productionYear: item.ProductionYear } : {}),
    ...(item.IndexNumber !== undefined ? { indexNumber: item.IndexNumber } : {}),
    ...(item.ParentIndexNumber !== undefined ? { parentIndexNumber: item.ParentIndexNumber } : {}),
    ...(item.RunTimeTicks !== undefined && item.RunTimeTicks !== null && item.RunTimeTicks > 0 ? { runtimeTicks: item.RunTimeTicks } : {}),
    ...(imageItemId !== undefined ? { imageItemId } : {}),
    ...(primaryImageTag !== undefined ? { imageTag: primaryImageTag } : {})
  };
}

function clampImageDimension(value: number | undefined, min: number, max: number): number | undefined {
  if (!value || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.min(max, Math.max(min, Math.round(value)));
}

function jellyfinAuthorizationHeader(token?: string): string {
  const parts = [
    `Client="${escapeHeaderValue("Jellyfin Discord Activity")}"`,
    `Device="${escapeHeaderValue("Discord Activity Backend")}"`,
    `DeviceId="${escapeHeaderValue("jellyfin-discord-activity-backend")}"`,
    `Version="${escapeHeaderValue("0.1.0")}"`
  ];

  if (token) {
    parts.push(`Token="${escapeHeaderValue(token)}"`);
  }

  return `MediaBrowser ${parts.join(", ")}`;
}

function escapeHeaderValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

function normalizeServerUrl(serverUrl: string): string {
  const parsed = new URL(serverUrl);
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";

  return parsed.toString().replace(/\/+$/, "");
}
