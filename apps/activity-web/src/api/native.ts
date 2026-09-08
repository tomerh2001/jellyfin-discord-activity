import { z } from "zod";
import { env } from "../env.js";
import { withRequestTimeout } from "./requestTimeout.js";
import { notifySessionRejected } from "./sessionRecovery.js";

const connectionSchema = z.object({
  id: z.string(), serverUrl: z.string(), serverId: z.string(), serverName: z.string(),
  jellyfinUserId: z.string(), jellyfinUsername: z.string(), kind: z.enum(["personal", "community"]),
  createdAt: z.string(), updatedAt: z.string()
});
export type Connection = z.infer<typeof connectionSchema>;
const connectionsSchema = z.object({
  connections: z.array(connectionSchema), defaultServerUrl: z.string(), communityAvailable: z.boolean(),
  preferredConnectionId: z.string().nullable()
});
export type Connections = z.infer<typeof connectionsSchema>;
const partySchema = z.object({
  id: z.string(), instanceId: z.string(), guildId: z.string().optional(), channelId: z.string().optional(),
  serverId: z.string(), serverUrl: z.string(), groupId: z.string()
});
export type Party = z.infer<typeof partySchema>;
export function matchesPartyServer(connection: Connection, party: Party) {
  return connection.serverId === party.serverId && connection.serverUrl === party.serverUrl;
}
export const nativeLaunchSchema = z.object({
  baseUrl: z.string().regex(/^\/jf\/[a-zA-Z0-9_-]+$/), accessToken: z.string().min(1),
  userId: z.string().min(1), serverId: z.string().min(1), deviceId: z.string().min(1), groupId: z.string().min(1)
});
export type NativeLaunch = z.infer<typeof nativeLaunchSchema>;
const quickConnectSchema = z.object({ id: z.string(), code: z.string(), expiresAt: z.string() });
export type QuickConnect = z.infer<typeof quickConnectSchema>;

async function request(path: string, token: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<unknown> {
  return withRequestTimeout(signal, 40_000, async requestSignal => {
    const response = await fetch(`${env.apiBaseUrl}${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: requestSignal
    });
    const payload: unknown = await response.json().catch((error: unknown) => {
      if (requestSignal.aborted) throw error;
      return undefined;
    });
    if (!response.ok) {
      const error = z.object({ error: z.object({ message: z.string(), code: z.string().optional() }) }).safeParse(payload);
      if (response.status === 401 && error.success && error.data.error.code === "invalid_app_token") notifySessionRejected(token);
      throw new Error(error.success ? error.data.error.message : `Request failed (${response.status}).`);
    }
    return payload;
  });
}

export async function getConnections(token: string, signal?: AbortSignal) {
  return connectionsSchema.parse(await request("/api/connections", token, "GET", undefined, signal));
}
export async function connectAccount(token: string, input: { serverUrl: string; username: string; password: string }) {
  return z.object({ connection: connectionSchema }).parse(await request("/api/connections", token, "POST", input)).connection;
}
export async function connectCommunity(token: string) {
  return z.object({ connection: connectionSchema }).parse(await request("/api/connections/community", token, "POST")).connection;
}
export async function deleteConnection(token: string, id: string) {
  await request(`/api/connections/${encodeURIComponent(id)}`, token, "DELETE");
}
export async function savePreference(token: string, connectionId: string) {
  await request("/api/connections/preference", token, "PUT", { connectionId });
}
export async function getParty(token: string, signal?: AbortSignal) {
  return z.object({ party: partySchema.nullable() }).parse(await request("/api/party", token, "GET", undefined, signal)).party;
}
export async function joinParty(token: string, connectionId: string) {
  return z.object({ party: partySchema }).parse(await request("/api/party", token, "POST", { connectionId })).party;
}
export async function launchNative(token: string, connectionId: string, deviceId: string) {
  return nativeLaunchSchema.parse(await request("/api/native/launch", token, "POST", { connectionId, deviceId }));
}
export async function startQuickConnect(token: string, serverUrl: string) {
  return quickConnectSchema.parse(await request("/api/connections/quick-connect", token, "POST", { serverUrl }));
}
export async function pollQuickConnect(token: string, id: string, signal?: AbortSignal) {
  return z.discriminatedUnion("status", [z.object({ status: z.literal("pending") }), z.object({ status: z.literal("connected"), connection: connectionSchema })])
    .parse(await request(`/api/connections/quick-connect/${encodeURIComponent(id)}/poll`, token, "POST", undefined, signal));
}
