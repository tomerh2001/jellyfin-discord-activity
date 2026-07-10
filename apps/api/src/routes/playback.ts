import {
  apiError,
  playbackPrepareRequestSchema,
  playbackPrepareResponseSchema
} from "@app/shared";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AuthError, requireAppSession, sendAuthError } from "../plugins/auth.js";
import { JellyfinError } from "../services/jellyfin.js";
import { JellyfinAccountResolutionError, withResolvedJellyfinAccount } from "../services/jellyfinAccountResolver.js";
import { getPlaybackInfo } from "../services/jellyfinPlayback.js";
import {
  proxyDirectStream,
  proxyHlsAsset,
  proxyHlsPlaylist,
  StreamProxyError
} from "../services/streamProxy.js";
import { streamTicketStore } from "../services/tickets.js";

export const playbackRoutes: FastifyPluginAsync = async (app) => {
  app.post("/api/playback/prepare", async (request, reply) => {
    try {
      const session = await requireAppSession(request);
      const parsed = playbackPrepareRequestSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send(apiError("invalid_request", "Invalid playback prepare request.", z.treeifyError(parsed.error)));
      }

      const { account, prepared } = await withResolvedJellyfinAccount(app.envConfig, session.discordUserId, async (account) => ({
        account,
        prepared: await getPlaybackInfo(app.envConfig, account, parsed.data)
      }));
      const { token, ticket } = streamTicketStore.create({
        serverUrl: account.serverUrl,
        jellyfinUserId: account.jellyfinUserId,
        encryptedAccessToken: account.encryptedAccessToken,
        itemId: prepared.itemId,
        mediaSourceId: prepared.mediaSourceId,
        sessionExpiresAt: session.expiresAt,
        ...(prepared.playMethod === "hls" ? { hlsPath: prepared.upstreamPath } : { directPath: prepared.upstreamPath })
      }, app.envConfig.STREAM_TICKET_TTL_SECONDS);

      const directExtension = prepared.container === "webm" ? "webm" : "mp4";
      const streamUrl = prepared.playMethod === "hls"
        ? `/media/hls/${encodeURIComponent(token)}/master.m3u8`
        : `/media/direct/${encodeURIComponent(token)}/stream.${directExtension}`;

      return reply.send(playbackPrepareResponseSchema.parse({
        playback: {
          itemId: prepared.itemId,
          mediaSourceId: prepared.mediaSourceId,
          playMethod: prepared.playMethod,
          streamUrl,
          expiresAt: ticket.expiresAt.toISOString(),
          ...(prepared.container ? { container: prepared.container } : {}),
          ...(prepared.videoCodec ? { videoCodec: prepared.videoCodec } : {}),
          ...(prepared.audioCodec ? { audioCodec: prepared.audioCodec } : {}),
          ...(prepared.selectedAudioStreamIndex !== undefined ? { selectedAudioStreamIndex: prepared.selectedAudioStreamIndex } : {}),
          selectedSubtitleStreamIndex: prepared.selectedSubtitleStreamIndex,
          audioTracks: prepared.audioTracks,
          subtitleTracks: prepared.subtitleTracks
        }
      }));
    } catch (error) {
      if (error instanceof AuthError) {
        return reply.code(401).send(sendAuthError(error));
      }

      if (error instanceof JellyfinAccountResolutionError) {
        return reply.code(error.statusCode).send(apiError(error.code, error.publicMessage));
      }

      if (error instanceof JellyfinError) {
        const statusCode = error.code === "jellyfin_token_invalid"
          ? 401
          : error.code === "jellyfin_access_denied"
            ? 403
            : 502;
        return reply.code(statusCode).send(apiError(error.code, error.publicMessage));
      }

      request.log.warn({ err: error }, "Playback prepare failed");
      return reply.code(500).send(apiError("playback_prepare_failed", "Could not prepare playback."));
    }
  });

  app.get<{ Params: { token: string } }>("/media/hls/:token/master.m3u8", async (request, reply) => {
    const token = request.params.token;
    const ticket = streamTicketStore.get(token);

    if (!ticket?.hlsPath) {
      return reply.code(403).send(apiError("stream_ticket_invalid", "Stream ticket is invalid or expired."));
    }

    try {
      return await proxyHlsPlaylist(app.envConfig, ticket, token, reply, ticket.hlsPath);
    } catch (error) {
      if (error instanceof StreamProxyError) {
        return reply.code(400).send(apiError(error.code, error.publicMessage));
      }

      request.log.warn({ err: error }, "HLS playlist proxy failed");
      return reply.code(502).send(apiError("hls_playlist_failed", "Could not load HLS playlist."));
    }
  });

  app.get<{ Params: { token: string }; Querystring: { u?: string } }>("/media/hls/:token/asset", async (request, reply) => {
    const token = request.params.token;
    const ticket = streamTicketStore.get(token);

    if (!ticket?.hlsPath) {
      return reply.code(403).send(apiError("stream_ticket_invalid", "Stream ticket is invalid or expired."));
    }

    if (!request.query.u) {
      return reply.code(400).send(apiError("invalid_request", "Missing HLS asset target."));
    }

    try {
      return await proxyHlsAsset(app.envConfig, ticket, token, request, reply, request.query.u);
    } catch (error) {
      if (error instanceof StreamProxyError) {
        return reply.code(400).send(apiError(error.code, error.publicMessage));
      }

      request.log.warn({ err: error }, "HLS asset proxy failed");
      return reply.code(502).send(apiError("hls_asset_failed", "Could not load HLS asset."));
    }
  });

  app.get<{ Params: { token: string } }>("/media/direct/:token/stream", async (request, reply) => {
    return proxyDirectTicket(request.params.token, request, reply);
  });

  app.get<{ Params: { token: string } }>("/media/direct/:token/stream.mp4", async (request, reply) => {
    return proxyDirectTicket(request.params.token, request, reply);
  });

  app.get<{ Params: { token: string } }>("/media/direct/:token/stream.webm", async (request, reply) => {
    return proxyDirectTicket(request.params.token, request, reply);
  });

  async function proxyDirectTicket(token: string, request: FastifyRequest, reply: FastifyReply) {
    const ticket = streamTicketStore.get(token);

    if (!ticket?.directPath) {
      return reply.code(403).send(apiError("stream_ticket_invalid", "Stream ticket is invalid or expired."));
    }

    try {
      return await proxyDirectStream(app.envConfig, ticket, request, reply);
    } catch (error) {
      if (error instanceof StreamProxyError) {
        return reply.code(400).send(apiError(error.code, error.publicMessage));
      }

      request.log.warn({ err: error }, "Direct stream proxy failed");
      return reply.code(502).send(apiError("direct_stream_failed", "Could not load direct stream."));
    }
  }
};
