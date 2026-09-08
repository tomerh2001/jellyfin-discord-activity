import {
  apiErrorSchema, discordExchangeResponseSchema, publicEnvSchema,
  type DiscordExchangeRequest, type DiscordExchangeResponse, type PublicEnv
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

export async function logout(appToken: string): Promise<void> {
  const response = await fetch(apiUrl("/api/logout"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appToken}`
    }
  });

  if (!response.ok) {
    throw await parseApiError(response);
  }
}
