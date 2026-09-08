import { apiError } from "@app/shared";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { AuthError, requireAppSession, sendAuthError } from "../plugins/auth.js";
import { communityAvailable, connectCommunity, ConnectionError, connectWithPassword, disconnectConnection,
  JellyfinConnectionStore, QuickConnectManager, suggestedServerUrl } from "../services/jellyfinConnections.js";
import { UpstreamPolicyError } from "../services/upstreamPolicy.js";

const loginSchema = z.object({ serverUrl: z.string().min(1).max(2048), username: z.string().trim().min(1).max(200),
  password: z.string().max(4096) }).strict();
const serverSchema = z.object({ serverUrl: z.string().min(1).max(2048) }).strict();
const preferenceSchema = z.object({ connectionId: z.string().regex(/^[a-f0-9]{32}$/) }).strict();

export const connectionRoutes: FastifyPluginAsync = async (app) => {
  const store = new JellyfinConnectionStore(app.envConfig);
  const quickConnect = new QuickConnectManager(app.envConfig);
  app.addHook("onClose", async () => { quickConnect.dispose(); });

  app.get("/api/connections", async (request, reply) => {
    try {
      const session = await requireAppSession(request);
      return reply.send({ connections: store.list(session.discordUserId, session.discordContext?.guildId), defaultServerUrl: suggestedServerUrl(app.envConfig),
        communityAvailable: communityAvailable(app.envConfig, session),
        preferredConnectionId: store.preferred(session.discordUserId, session.discordContext?.guildId) });
    } catch (error) { return sendError(reply, error); }
  });

  app.post("/api/connections", async (request, reply) => {
    try {
      const session = await requireAppSession(request);
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) return invalidInput(reply);
      const connection = await connectWithPassword(app.envConfig, session, parsed.data);
      return reply.code(201).send({ connection });
    } catch (error) { return sendError(reply, error); }
  });

  app.post("/api/connections/community", async (request, reply) => {
    try {
      const session = await requireAppSession(request);
      return reply.code(201).send({ connection: await connectCommunity(app.envConfig, session) });
    } catch (error) { return sendError(reply, error); }
  });

  app.put("/api/connections/preference", async (request, reply) => {
    try {
      const session = await requireAppSession(request);
      const parsed = preferenceSchema.safeParse(request.body);
      if (!parsed.success) return invalidInput(reply);
      store.setPreferred(session.discordUserId, session.discordContext?.guildId, parsed.data.connectionId);
      return reply.send({ ok: true });
    } catch (error) { return sendError(reply, error); }
  });

  app.delete<{ Params: { id: string } }>("/api/connections/:id", async (request, reply) => {
    try {
      const session = await requireAppSession(request);
      return reply.send(await disconnectConnection(app.envConfig, session.discordUserId, request.params.id));
    } catch (error) { return sendError(reply, error); }
  });

  app.post("/api/connections/quick-connect", async (request, reply) => {
    try {
      const session = await requireAppSession(request);
      const parsed = serverSchema.safeParse(request.body);
      if (!parsed.success) return invalidInput(reply);
      return reply.code(201).send(await quickConnect.start(session, parsed.data.serverUrl));
    } catch (error) { return sendError(reply, error); }
  });

  app.post<{ Params: { id: string } }>("/api/connections/quick-connect/:id/poll", async (request, reply) => {
    try {
      const session = await requireAppSession(request);
      return reply.send(await quickConnect.poll(session, request.params.id));
    } catch (error) { return sendError(reply, error); }
  });
};

function invalidInput(reply: FastifyReply) {
  return reply.code(400).send(apiError("invalid_connection_request", "Check the server address and login fields."));
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof AuthError) return reply.code(error.statusCode).send(sendAuthError(error));
  if (error instanceof ConnectionError || error instanceof UpstreamPolicyError) {
    return reply.code(error.statusCode).send(apiError(error.code, error.publicMessage));
  }
  // Credentials and upstream payloads must never become logs or HTTP error details.
  return reply.code(500).send(apiError("connection_failed", "Could not complete the Jellyfin connection request."));
}
