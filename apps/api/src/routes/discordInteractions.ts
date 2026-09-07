import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AppEnv } from "../env.js";
import { allowedDiscordActor, verifyDiscordActivityContext } from "../services/discord.js";
import { verifyInteractionSignature } from "../services/interactionSignature.js";
import { getItem, searchItems } from "../services/jellyfin.js";
import { withResolvedJellyfinAccount } from "../services/jellyfinAccountResolver.js";
import { roomManager, RoomError } from "../services/roomManager.js";
import { targetServerTimestamp } from "../services/syncEngine.js";
import { broadcastRoomState } from "../ws/handlers.js";
import { roomSocketHub } from "../ws/roomSocket.js";

const optionSchema = z.object({ name: z.string(), value: z.union([z.string(), z.number(), z.boolean()]).optional() });
const interactionSchema = z.object({
  id: z.string().min(1), application_id: z.string(), type: z.number(), token: z.string().optional(),
  guild_id: z.string().optional(), channel_id: z.string().optional(),
  member: z.object({ user: z.object({ id: z.string() }) }).optional(),
  data: z.object({ name: z.string().optional(), custom_id: z.string().optional(), values: z.array(z.string()).optional(),
    options: z.array(z.object({ name: z.string(), options: z.array(optionSchema).optional() })).optional()
  }).optional()
});
type Interaction = z.infer<typeof interactionSchema>;
type Message = { content: string; components?: unknown[] };
const ephemeral = (content: string) => ({ type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } });

export const discordInteractionRoutes: FastifyPluginAsync = async (app) => {
  // Encapsulated parser preserves the exact signed bytes without changing other API routes.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 65536 }, (_request, body, done) => done(null, body));
  const handled = new Map<string, { expiresAt: number; response: unknown }>();
  app.post("/api/discord/interactions", async (request, reply) => {
    const signature = request.headers["x-signature-ed25519"];
    const timestamp = request.headers["x-signature-timestamp"];
    if (!Buffer.isBuffer(request.body) || typeof signature !== "string" || typeof timestamp !== "string"
      || !verifyInteractionSignature(app.envConfig.DISCORD_PUBLIC_KEY, signature, timestamp, request.body)) {
      return reply.code(401).send({ error: "Invalid Discord signature" });
    }
    let json: unknown;
    try { json = JSON.parse(request.body.toString("utf8")); } catch { return reply.code(400).send({ error: "Invalid JSON" }); }
    const parsed = interactionSchema.safeParse(json);
    if (!parsed.success || parsed.data.application_id !== app.envConfig.DISCORD_CLIENT_ID) {
      return reply.code(400).send({ error: "Invalid interaction" });
    }
    const interaction = parsed.data;
    if (interaction.type === 1) return { type: 1 };
    const userId = interaction.member?.user.id;
    if (!interaction.guild_id || !userId || !allowedDiscordActor(app.envConfig, userId, interaction.guild_id)) {
      return ephemeral("This watch party is limited to the configured server and users.");
    }
    const now = Date.now();
    for (const [id, cached] of handled) if (cached.expiresAt < now) handled.delete(id);
    const cached = handled.get(interaction.id);
    if (cached) return cached.response;
    if (handled.size >= 10000) return reply.code(429).send({ error: "Too many interactions" });
    const launch = interaction.type === 2 && ["watch", "Watch Jellyfin"].includes(interaction.data?.name ?? "");
    if (launch) {
      const response = { type: 12 };
      handled.set(interaction.id, { expiresAt: now + 300_000, response });
      return response;
    }
    const control = interaction.type === 2 && interaction.data?.name === "jellyfin";
    const select = interaction.type === 3 && interaction.data?.custom_id === "jellyfin:select";
    if ((!control && !select) || !interaction.token) return ephemeral("Unknown command. Use /watch or /jellyfin.");
    const response = { type: 5, data: { flags: 64 } };
    handled.set(interaction.id, { expiresAt: now + 300_000, response });
    void runControl(app.envConfig, interaction, userId)
      .catch((error: unknown): Message => ({ content: error instanceof CommandError || error instanceof RoomError
        ? error.message : "The command could not complete. Check the Activity connection and try again." }))
      .then(async (message) => {
        const result = await fetch(`https://discord.com/api/v10/webhooks/${app.envConfig.DISCORD_CLIENT_ID}/${encodeURIComponent(interaction.token!)}/messages/@original`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...message, allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(10_000)
        });
        if (!result.ok) app.log.warn({ status: result.status }, "Discord command response failed");
      }).catch(() => app.log.warn("Discord command response unavailable"));
    return response;
  });
};

class CommandError extends Error {}

export async function runControl(env: AppEnv, interaction: Interaction, userId: string): Promise<Message> {
  const guildId = interaction.guild_id!;
  const voice = await fetch(`https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/voice-states/${encodeURIComponent(userId)}`, {
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` }, signal: AbortSignal.timeout(10_000)
  });
  if (!voice.ok) throw new CommandError("Join a voice channel and open /watch first.");
  const state = z.object({ channel_id: z.string().nullable() }).parse(await voice.json());
  if (!state.channel_id) throw new CommandError("Join a voice channel first.");
  const room = roomManager.findByChannel(guildId, state.channel_id);
  if (!room) throw new CommandError("Open /watch in your voice channel and connect to the Activity first.");
  await verifyDiscordActivityContext(env, { instanceId: room.instanceId, guildId, channelId: state.channel_id }, userId);
  const subcommand = interaction.data?.options?.[0];
  const action = interaction.type === 3 ? "select" : subcommand?.name;
  if (action === "now") return { content: room.itemId ? `${room.title ?? "Current video"} — ${room.playState}, ${Math.floor(currentPosition(room))} seconds.` : "No video selected yet." };
  if (room.hostDiscordUserId !== userId || !roomSocketHub.connectedUserIds(room.instanceId).includes(userId)) {
    throw new CommandError("Only the connected Activity host can control playback.");
  }
  if (action === "play" || action === "select") {
    const query = subcommand?.options?.find((option) => option.name === "query")?.value;
    const selectedId = interaction.data?.values?.[0];
    const result = await withResolvedJellyfinAccount(env, userId, async (account) => {
      if (action === "select") {
        if (!selectedId || !/^[a-f0-9-]{32,36}$/i.test(selectedId)) throw new CommandError("Invalid selection. Search again with /jellyfin play.");
        return { items: [await getItem(env, account, selectedId)] };
      }
      if (typeof query !== "string" || !query.trim() || query.length > 200) throw new CommandError("Enter a movie or episode title.");
      return searchItems(env, account, { query, type: "Movie,Episode", recursive: true, startIndex: 0, limit: 25 });
    });
    const items = result.items.filter((item) => item.type === "Movie" || item.type === "Episode");
    if (!items.length) return { content: "No matching movies or episodes. Try a different title or browse the Activity library." };
    if (items.length > 1) return { content: "Choose what to watch (first 25 matches):", components: [{ type: 1, components: [{
      type: 3, custom_id: "jellyfin:select", placeholder: "Select a movie or episode", options: items.map((item) => ({
        label: `${item.seriesName ? `${item.seriesName} · S${item.parentIndexNumber ?? "?"}E${item.indexNumber ?? "?"} · ` : ""}${item.name}`.slice(0, 100),
        value: item.id, description: `${item.type}${item.productionYear ? ` · ${item.productionYear}` : ""}`
      }))
    }] }] };
    const item = items[0]!;
    const selected = roomManager.selectMedia({ instanceId: room.instanceId, itemId: item.id, title: item.name,
      ...(item.runtimeTicks ? { runtimeTicks: item.runtimeTicks } : {}) }, userId);
    roomSocketHub.broadcast(room.instanceId, { type: "media_selected", itemId: item.id, title: item.name,
      ...(selected.runtimeTicks ? { runtimeTicks: selected.runtimeTicks } : {}), serverTs: Date.now() });
    broadcastRoomState(room.instanceId);
    return { content: `Selected ${item.name}. Press Play in the Activity when everyone is ready.` };
  }
  if (!room.itemId) throw new CommandError("Select a movie or episode first.");
  const seconds = subcommand?.options?.find((option) => option.name === "seconds")?.value;
  if (action === "seek" && (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0 || seconds > 86400)) {
    throw new CommandError("Choose a position between 0 and 86400 seconds.");
  }
  if (!["pause", "resume", "seek", "stop"].includes(action ?? "")) throw new CommandError("Unknown playback command.");
  const position = action === "stop" ? 0 : action === "seek" ? seconds as number : currentPosition(room);
  const duration = room.runtimeTicks ? room.runtimeTicks / 10_000_000 : Number.POSITIVE_INFINITY;
  const positionSeconds = Math.min(position, duration);
  const playerAction = action === "resume" ? "play" : action === "seek" || action === "stop" ? "seek" : "pause";
  roomManager.updatePlaybackState({ instanceId: room.instanceId, discordUserId: userId, playState: action === "resume" ? "playing" : "paused", positionSeconds });
  const now = Date.now();
  roomSocketHub.broadcast(room.instanceId, { type: "player_event", action: playerAction, positionSeconds, targetServerTs: targetServerTimestamp(playerAction, now), serverTs: now });
  broadcastRoomState(room.instanceId);
  return { content: `${action === "resume" ? "Playing" : "Paused"} at ${Math.floor(positionSeconds)} seconds.` };
}

function currentPosition(room: NonNullable<ReturnType<typeof roomManager.get>>): number {
  return room.positionSeconds + (room.playState === "playing" ? Math.max(0, (Date.now() - Date.parse(room.updatedAt)) / 1000) : 0);
}
