import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { loadEnv } from "../env.js";
import { runControl } from "../routes/discordInteractions.js";
import { getNativePartyService, type NativeParty, type NativeViewer } from "../services/nativeParty.js";

const guildId = "333333333333333333";
const channelId = "444444444444444444";
const memberId = "555555555555555555";
const applicationId = "111111111111111111";
const context = { instanceId: "instance-current", guildId, channelId };
const apps: FastifyInstance[] = [];

function interaction(action: string, seconds?: number) {
  return { id: "interaction", application_id: applicationId, type: 2, guild_id: guildId,
    channel_id: "different-text-channel", data: { name: "jellyfin", options: [
      { name: action, ...(seconds !== undefined ? { options: [{ name: "seconds", value: seconds }] } : {}) }
    ] }
  };
}
async function setup() {
  const app = await buildApp(loadEnv({ NODE_ENV: "test", DEV_AUTH_MOCK: "true", DISCORD_CLIENT_ID: applicationId,
    DISCORD_BOT_TOKEN: "unit-test-bot-token", DISCORD_ALLOWED_GUILD_IDS: guildId, LOG_LEVEL: "silent" }));
  apps.push(app);
  const service = getNativePartyService(app);
  const party = { id: "current-party", context } as NativeParty;
  const viewer = { discordUserId: memberId } as NativeViewer;
  const find = vi.spyOn(service,"getPartyForChannel").mockImplementation((guild,channel) => guild === guildId && channel === channelId ? party : undefined);
  const member = vi.spyOn(service,"getViewerForDiscordUser").mockImplementation((id,user) => id === party.id && user === memberId ? viewer : undefined);
  const command = vi.spyOn(service,"command").mockResolvedValue(null);
  const upstream = vi.fn(async (url: string | URL | Request) => {
    const address = String(url);
    if (address.includes("/voice-states/")) return Response.json({ channel_id: channelId });
    if (address.includes("/activity-instances/")) return Response.json({ application_id: applicationId, instance_id: context.instanceId,
      location: { guild_id: guildId, channel_id: channelId }, users: [memberId] });
    throw new Error("Unexpected external request in command test");
  });
  vi.stubGlobal("fetch",upstream);
  return { app, party, viewer, find, member, command, upstream };
}

afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); await Promise.all(apps.splice(0).map(app => app.close())); });

describe("Discord native SyncPlay controls", () => {
  it("uses current voice and authoritative Activity membership before controlling the caller's own native session", async () => {
    const {app,viewer,find,command,upstream} = await setup();
    expect((await runControl(app,interaction("pause"),memberId)).content).toBe("Party paused.");
    expect(find).toHaveBeenCalledWith(guildId,channelId);
    expect(upstream.mock.calls.map(([url])=>String(url))).toEqual([
      `https://discord.com/api/v10/guilds/${guildId}/voice-states/${memberId}`,
      `https://discord.com/api/v10/applications/${applicationId}/activity-instances/${context.instanceId}`
    ]);
    expect(command).toHaveBeenCalledExactlyOnceWith(viewer,"pause");
  });
  it("refuses a caller outside voice or in a different channel", async () => {
    const {app,command,upstream} = await setup();
    upstream.mockResolvedValueOnce(Response.json({channel_id:null}));
    await expect(runControl(app,interaction("pause"),memberId)).rejects.toThrow("Join a voice channel");
    upstream.mockResolvedValueOnce(Response.json({channel_id:"other"}));
    await expect(runControl(app,interaction("pause"),memberId)).rejects.toThrow("Open /watch");
    expect(command).not.toHaveBeenCalled();
  });
  it("refuses a caller absent from Discord's live Activity response", async () => {
    const {app,command,upstream} = await setup();
    upstream.mockResolvedValueOnce(Response.json({channel_id:channelId}));
    upstream.mockResolvedValueOnce(Response.json({application_id:applicationId,instance_id:context.instanceId,
      location:{guild_id:guildId,channel_id:channelId},users:[]}));
    await expect(runControl(app,interaction("pause"),memberId)).rejects.toThrow("discord_activity_forbidden");
    expect(command).not.toHaveBeenCalled();
  });
  it("requires a connected native viewer even for an Activity member", async () => {
    const {app,member,command} = await setup();
    member.mockReturnValue(undefined);
    await expect(runControl(app,interaction("resume"),memberId)).rejects.toThrow("connect its Jellyfin player");
    expect(command).not.toHaveBeenCalled();
  });
  it("exposes collaborative seek and next-episode commands through the native service", async () => {
    const {app,viewer,command} = await setup();
    await runControl(app,interaction("seek",60),memberId);
    expect(command).toHaveBeenCalledWith(viewer,"seek",{seconds:60});
    await runControl(app,interaction("next"),memberId);
    expect(command).toHaveBeenCalledWith(viewer,"next");
    await expect(runControl(app,interaction("seek",-1),memberId)).rejects.toThrow("between 0 and 86400");
    await expect(runControl(app,interaction("seek",Infinity),memberId)).rejects.toThrow("between 0 and 86400");
  });
  it("does not apply a search dropdown from a previous server/group binding", async () => {
    const {app,command} = await setup();
    const selection = {id:"selection",application_id:applicationId,type:3,guild_id:guildId,
      data:{custom_id:"jellyfin:select:old-party",values:["a".repeat(32)]}};
    await expect(runControl(app,selection,memberId)).rejects.toThrow("earlier watch party");
    expect(command).not.toHaveBeenCalled();
    selection.data.custom_id = "jellyfin:select:current-party";
    await runControl(app,selection,memberId);
    expect(command).toHaveBeenCalledWith(expect.anything(),"select",{itemIds:["a".repeat(32)]});
  });
  it("reports native playback state instead of extrapolating a second timeline", async () => {
    const {app,command} = await setup();
    command.mockResolvedValue({title:"Episode",positionSeconds:87.25,isPaused:false});
    expect((await runControl(app,interaction("now"),memberId)).content).toBe("Episode: playing at 87 seconds.");
  });
});
