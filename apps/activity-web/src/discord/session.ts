import { exchangeDiscordCode, getPublicConfig, logout, resumeDiscordSession } from "../api/client.js";
import type { DiscordExchangeResponse, PublicEnv } from "../api/types.js";
import { authenticateDiscord, authorizeDiscord, initializeDiscord, type ActivityDiscordContext } from "./sdk.js";

export type ActivitySession = { discord: ActivityDiscordContext; exchange: DiscordExchangeResponse };

export class StartupTimeout extends Error {}

/** A timeout stops waiting, not the SDK command: retry awaits its original reply. */
async function waitForStage<T>(pending: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new StartupTimeout(message)), 20_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

export function createSessionStarter() {
  let config: PublicEnv | undefined;
  let discord: ActivityDiscordContext | undefined;
  let authorization: ReturnType<typeof authorizeDiscord> | undefined;
  let exchange: DiscordExchangeResponse | undefined;
  let authentication: ReturnType<typeof authenticateDiscord> | undefined;
  let pending: Promise<ActivitySession> | undefined;
  let resuming: Promise<ActivitySession> | undefined;
  let disposed = false;

  function resume(): Promise<ActivitySession> {
    if (!discord || !exchange?.discordAccessToken || disposed) return Promise.reject(new Error("No Discord session to restore. Close the Activity and open it again."));
    const context = discord;
    const previous = exchange;
    const accessToken = exchange.discordAccessToken;
    resuming ??= resumeDiscordSession(accessToken, {
      instanceId: context.instanceId, userId: previous.user.id,
      ...(context.guildId ? { guildId: context.guildId } : {}), ...(context.channelId ? { channelId: context.channelId } : {})
    }).then(async restored => {
      if (disposed) {
        await logout(restored.appToken);
        throw new Error("The Activity was closed.");
      }
      exchange = restored;
      return { discord: context, exchange: restored };
    }).finally(() => { resuming = undefined; });
    return resuming;
  }

  async function connect(): Promise<ActivitySession> {
    config ??= await getPublicConfig();
    discord ??= await initializeDiscord(config);
    if (exchange && Date.parse(exchange.expiresAt) <= Date.now()) return resume();
    if (!exchange) {
      authorization ??= authorizeDiscord(discord, config);
      let authorized: Awaited<ReturnType<typeof authorizeDiscord>>;
      try { authorized = await waitForStage(authorization, "Discord authorization is taking longer than expected. Try connecting again."); }
      catch (error) { if (!(error instanceof StartupTimeout)) authorization = undefined; throw error; }
      try {
        exchange = await exchangeDiscordCode({
          code: authorized.code, instanceId: discord.instanceId,
          ...(discord.guildId ? { guildId: discord.guildId } : {}),
          ...(discord.channelId ? { channelId: discord.channelId } : {}),
          ...(discord.isMock && discord.user ? { mockUser: discord.user } : {})
        });
      } catch (error) {
        // OAuth codes are single-use. Request a new code after a failed HTTP
        // exchange; never loop on a code that Discord may already have consumed.
        authorization = undefined;
        throw error;
      }
    }
    authentication ??= authenticateDiscord(discord, exchange.discordAccessToken);
    try { await waitForStage(authentication, "Discord sign-in is taking longer than expected. Try connecting again."); }
    catch (error) { if (!(error instanceof StartupTimeout)) authentication = undefined; throw error; }
    return { discord, exchange };
  }
  const start = () => {
    // React replays and retry clicks share the same operation, including the
    // authenticated SDK/token after a later stage has failed.
    pending ??= connect().finally(() => { pending = undefined; });
    return pending;
  };
  return Object.assign(start, { resume, dispose: () => { disposed = true; } });
}

let current = createSessionStarter();
export function startActivitySession(): Promise<ActivitySession> { return current(); }
export function resumeActivitySession(): Promise<ActivitySession> { return current.resume(); }
export function clearActivitySession(): void { current.dispose(); current = createSessionStarter(); }
