import type { ServerMessage } from "@app/shared/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEnv } from "../env.js";
import { runControl } from "../routes/discordInteractions.js";
import { createAppSession } from "../services/appSession.js";
import { roomManager } from "../services/roomManager.js";
import { handleClientMessage } from "../ws/handlers.js";
import { roomSocketHub, type RoomSocket } from "../ws/roomSocket.js";

const guildId = "333333333333333333";
const channelId = "444444444444444444";
const hostId = "222222222222222222";
const guestId = "555555555555555555";
const applicationId = "111111111111111111";
const env = loadEnv({ NODE_ENV: "test", DEV_AUTH_MOCK: "true", DISCORD_CLIENT_ID: applicationId,
  DISCORD_BOT_TOKEN: "unit-test-bot-token", DISCORD_ALLOWED_GUILD_IDS: guildId, LOG_LEVEL: "silent" });
let roomCount = 0;

function interaction(action: string, seconds?: number) {
  return { id: `interaction-${roomCount}`, application_id: applicationId, type: 2, guild_id: guildId,
    channel_id: "text-channel-is-not-the-voice-channel", data: { name: "jellyfin", options: [
      { name: action, ...(seconds !== undefined ? { options: [{ name: "seconds", value: seconds }] } : {}) }
    ] }
  };
}

async function setup(input: { hostConnected?: boolean; guestConnected?: boolean } = {}) {
  const instanceId = `commands-${++roomCount}`;
  // Different voice channels per test prevent an old room from winning findByChannel.
  const voiceChannelId = `${channelId}-${roomCount}`;
  const context = { instanceId, guildId, channelId: voiceChannelId };
  const messages = new Map<string, ServerMessage[]>();
  for (const [userId, connected] of [[hostId, input.hostConnected ?? true], [guestId, input.guestConnected ?? true]] as const) {
    if (!connected) continue;
    const { session } = await createAppSession({ env, user: { id: userId, username: userId }, discordContext: context });
    messages.set(userId, []);
    const client: RoomSocket = { clientId: `client-${instanceId}-${userId}`, instanceId, session, username: userId,
      connectedAt: new Date().toISOString(), socket: { readyState: 1,
        send: (data: string) => { messages.get(userId)!.push(JSON.parse(data) as ServerMessage); }, close: () => {}, on: () => {} } };
    roomSocketHub.add(client);
  }
  roomManager.claimHost(context, hostId);
  roomManager.selectMedia({ instanceId, itemId: "movie-1", title: "Test movie", runtimeTicks: 1200 * 10_000_000 }, hostId);
  roomManager.updatePlaybackState({ instanceId, discordUserId: hostId, playState: "playing", positionSeconds: 120 });
  const fetchMock = vi.fn(async (url: string | URL | Request) => {
    const address = String(url);
    if (address.includes("/voice-states/")) return Response.json({ channel_id: voiceChannelId });
    if (address.includes("/activity-instances/")) return Response.json({ application_id: applicationId, instance_id: instanceId,
      location: { guild_id: guildId, channel_id: voiceChannelId }, users: [hostId, guestId] });
    throw new Error(`Unexpected test request: ${address}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { instanceId, voiceChannelId, messages, fetchMock };
}

afterEach(() => { roomSocketHub.clear(); vi.unstubAllGlobals(); });

describe("Discord voice-channel controls", () => {
  it("does not echo a player's own action but delivers Discord commands to that player", async () => {
    const { instanceId, messages } = await setup();
    const host = roomSocketHub.clients(instanceId).find((client) => client.session.discordUserId === hostId)!;
    handleClientMessage(env, host, { type: "player_event", action: "pause", positionSeconds: 90, ts: Date.now() });
    expect(messages.get(hostId)?.filter((message) => message.type === "player_event")).toEqual([]);
    expect(messages.get(guestId)).toContainEqual(expect.objectContaining({ type: "player_event", action: "pause", positionSeconds: 90 }));
    await runControl(env, interaction("resume"), hostId);
    expect(messages.get(hostId)).toContainEqual(expect.objectContaining({ type: "player_event", action: "play", positionSeconds: 90 }));
  });

  it("uses the caller's real voice state and verifies Activity participation before pausing everyone", async () => {
    const { instanceId, voiceChannelId, messages, fetchMock } = await setup();
    const result = await runControl(env, interaction("pause"), hostId);
    expect(result.content).toContain("Paused at 120");
    expect(roomManager.get(instanceId)?.playState).toBe("paused");
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      `https://discord.com/api/v10/guilds/${guildId}/voice-states/${hostId}`,
      `https://discord.com/api/v10/applications/${applicationId}/activity-instances/${instanceId}`
    ]);
    expect(roomManager.get(instanceId)?.channelId).toBe(voiceChannelId);
    for (const userId of [hostId, guestId]) {
      expect(messages.get(userId)).toContainEqual(expect.objectContaining({ type: "player_event", action: "pause", positionSeconds: expect.closeTo(120, 0) }));
    }
  });

  it("rejects a member who is not in a voice channel", async () => {
    const { instanceId, fetchMock } = await setup();
    fetchMock.mockResolvedValueOnce(Response.json({ channel_id: null }));
    await expect(runControl(env, interaction("pause"), hostId)).rejects.toThrow("Join a voice channel");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(roomManager.get(instanceId)?.playState).toBe("playing");
  });

  it("cannot control a room from another voice channel", async () => {
    const { instanceId, fetchMock } = await setup();
    fetchMock.mockResolvedValueOnce(Response.json({ channel_id: "unrelated-voice-channel" }));
    await expect(runControl(env, interaction("pause"), hostId)).rejects.toThrow("Open /watch");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(roomManager.get(instanceId)?.playState).toBe("playing");
  });

  it("rejects a voice member absent from the authoritative Activity participants", async () => {
    const { instanceId, voiceChannelId, fetchMock } = await setup();
    fetchMock.mockResolvedValueOnce(Response.json({ channel_id: voiceChannelId }));
    fetchMock.mockResolvedValueOnce(Response.json({ application_id: applicationId, instance_id: instanceId,
      location: { guild_id: guildId, channel_id: voiceChannelId }, users: [guestId] }));
    await expect(runControl(env, interaction("pause"), hostId)).rejects.toThrow("discord_activity_forbidden");
    expect(roomManager.get(instanceId)?.playState).toBe("playing");
  });

  it("lets participants inspect the title but refuses nonhost playback changes", async () => {
    const { instanceId } = await setup();
    expect((await runControl(env, interaction("now"), guestId)).content).toContain("Test movie");
    await expect(runControl(env, interaction("pause"), guestId)).rejects.toThrow("Only the connected Activity host");
    expect(roomManager.get(instanceId)?.playState).toBe("playing");
  });

  it("refuses control from a stored host with no live Activity socket", async () => {
    const { instanceId } = await setup({ hostConnected: false });
    await expect(runControl(env, interaction("pause"), hostId)).rejects.toThrow("Only the connected Activity host");
    expect(roomManager.get(instanceId)?.playState).toBe("playing");
  });

  it("bounds seek targets to the selected media duration", async () => {
    const { instanceId } = await setup();
    await runControl(env, interaction("seek", 2400), hostId);
    expect(roomManager.get(instanceId)).toMatchObject({ playState: "paused", positionSeconds: 1200 });
    await expect(runControl(env, interaction("seek", -1), hostId)).rejects.toThrow("between 0 and 86400");
  });
});
