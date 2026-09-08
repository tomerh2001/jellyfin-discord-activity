import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { AuthError, requireAppSession, sendAuthError } from "../plugins/auth.js";
import { getNativePartyService, NativeError, publicNativeParty } from "../services/nativeParty.js";

const binding = z.object({ connectionId: z.string().min(1).max(128) }).strict();
const launch = binding.extend({ deviceId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/) });

export const nativePartyRoutes: FastifyPluginAsync = async (app) => {
  const service = getNativePartyService(app);
  app.get("/api/party", async (request, reply) => {
    try { return { party: publicNativeParty(service.get(await requireAppSession(request))) }; }
    catch (error) { return nativeRouteError(error, reply); }
  });
  app.post("/api/party", async (request, reply) => {
    try {
      const session = await requireAppSession(request);
      const parsed = binding.safeParse(request.body);
      if (!parsed.success) throw new NativeError("invalid_request", 400);
      return { party: publicNativeParty(await service.bind(session, parsed.data.connectionId)) };
    } catch (error) { return nativeRouteError(error, reply); }
  });
  app.post("/api/native/launch", async (request, reply) => {
    try {
      const session = await requireAppSession(request);
      const parsed = launch.safeParse(request.body);
      if (!parsed.success) throw new NativeError("invalid_request", 400);
      return await service.launch(session, parsed.data.connectionId, parsed.data.deviceId);
    } catch (error) { return nativeRouteError(error, reply); }
  });
};

export function nativeRouteError(error: unknown, reply: import("fastify").FastifyReply) {
  if (error instanceof AuthError) return reply.code(error.statusCode).send(sendAuthError(error));
  if (error instanceof NativeError) return reply.code(error.statusCode).send({ error: { code: error.code, message: "The native Jellyfin request could not be completed." } });
  // Never log an upstream exception whose request options may contain credentials.
  return reply.code(502).send({ error: { code: "native_upstream_failed", message: "Jellyfin is unavailable or this connection is no longer valid." } });
}
