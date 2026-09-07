import { DiscordSDK } from "@discord/embedded-app-sdk";
import { env } from "../env.js";
import type { PublicEnv } from "../api/types.js";
import type { ActivityParticipant } from "./participants.js";

export type ActivityDiscordContext = {
  instanceId: string;
  guildId?: string;
  channelId?: string;
  user?: {
    id: string;
    username: string;
    globalName?: string | null;
    avatar?: string | null;
  };
  isMock: boolean;
  isStandalone?: boolean;
  sdk?: DiscordSDK;
};

function queryParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

export function mockContext(): ActivityDiscordContext {
  const mockUser = queryParam("mockUser") ?? "host";
  const mockInstance = queryParam("mockInstance") ?? "dev-instance-1";

  return {
    instanceId: mockInstance,
    guildId: "dev-guild-1",
    channelId: "dev-channel-1",
    user: {
      id: `dev-user-${mockUser}`,
      username: mockUser === "host" ? "DevHost" : `Dev${mockUser}`,
      globalName: mockUser === "host" ? "Dev Host" : `Dev ${mockUser}`,
      avatar: null
    },
    isMock: true
  };
}

function standaloneContext(): ActivityDiscordContext {
  const guildId = queryParam("guild_id");
  const channelId = queryParam("channel_id");

  return {
    instanceId: queryParam("instance_id") ?? queryParam("mockInstance") ?? "standalone-browser",
    ...(guildId ? { guildId } : {}),
    ...(channelId ? { channelId } : {}),
    isMock: false,
    isStandalone: true
  };
}

export async function initializeDiscord(config: PublicEnv): Promise<ActivityDiscordContext> {
  const hasDiscordFrame = new URLSearchParams(window.location.search).has("frame_id");

  if (env.devDiscordMock || (env.devMode && !hasDiscordFrame)) {
    return mockContext();
  }

  if (!hasDiscordFrame) {
    return standaloneContext();
  }

  const sdk = new DiscordSDK(config.publicDiscordClientId, {
    disableConsoleLogOverride: true
  });
  const instanceId = sdk.instanceId;
  await withTimeout(sdk.ready(), 15_000, `Discord SDK did not become ready for application ${config.publicDiscordClientId}. Confirm the Activity is launched from Discord, the Developer Portal Application ID matches PUBLIC_DISCORD_CLIENT_ID, and the Activity URL Mapping points to this HTTPS origin.`);

  return {
    instanceId,
    ...(sdk.guildId ? { guildId: sdk.guildId } : {}),
    ...(sdk.channelId ? { channelId: sdk.channelId } : {}),
    isMock: false,
    sdk
  };
}

export async function authorizeDiscord(context: ActivityDiscordContext, config: PublicEnv): Promise<{ code: string; discordAccessToken?: string }> {
  if (context.isMock || !context.sdk) {
    if (context.isStandalone) {
      throw new Error("Open this app from Discord to authenticate. Browser tabs cannot create a Discord Activity OAuth code.");
    }

    return {
      code: `dev-mock:${context.user?.id ?? "dev-user-host"}`,
      discordAccessToken: `dev-discord-token:${context.user?.id ?? "dev-user-host"}`
    };
  }

  const { code } = await context.sdk.commands.authorize({
    client_id: config.publicDiscordClientId,
    response_type: "code",
    state: context.instanceId,
    prompt: "none",
    scope: ["identify"]
  });

  return { code };
}

export async function authenticateDiscord(context: ActivityDiscordContext, discordAccessToken?: string) {
  if (context.isMock || !context.sdk) {
    return context.user;
  }

  const auth = await context.sdk.commands.authenticate({
    access_token: discordAccessToken
  });

  if (!auth) {
    throw new Error("Discord authenticate command failed.");
  }

  return {
    id: auth.user.id,
    username: auth.user.username,
    ...(auth.user.global_name !== undefined ? { globalName: auth.user.global_name } : {}),
    ...(auth.user.avatar !== undefined ? { avatar: auth.user.avatar } : {})
  };
}

export async function getConnectedParticipants(context: ActivityDiscordContext): Promise<ActivityParticipant[]> {
  if (context.isMock || !context.sdk) {
    return context.user
      ? [{
          id: context.user.id,
          username: context.user.username,
          ...(context.user.globalName !== undefined ? { globalName: context.user.globalName } : {}),
          ...(context.user.avatar !== undefined ? { avatar: context.user.avatar } : {})
        }]
      : [];
  }

  const response = await context.sdk.commands.getActivityInstanceConnectedParticipants();

  return response.participants.map((participant) => ({
    id: participant.id,
    username: participant.global_name ?? participant.nickname ?? participant.username,
    ...(participant.global_name !== undefined ? { globalName: participant.global_name } : {}),
    ...(participant.avatar !== undefined ? { avatar: participant.avatar } : {})
  }));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
