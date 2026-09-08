import type { FastifyPluginAsync } from "fastify";
import { bridgeNativeSocket, prepareNativeSocket, proxyNativeRequest, type PreparedNativeSocket } from "../services/nativeGateway.js";
import { getNativePartyService, NativeError, type NativeViewer } from "../services/nativeParty.js";
import { nativeRouteError } from "./nativeParty.js";

export const nativeJellyfinRoutes: FastifyPluginAsync = async (app) => {
  const service = getNativePartyService(app);
  app.addHook("onRequest", async (_request, reply) => {
    // Remote servers supply data and media only, never executable same-origin documents.
    reply.header("Content-Security-Policy", "sandbox; default-src 'none'; frame-ancestors 'none'");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Cache-Control", "no-store");
  });
  const authorized = new WeakMap<object, { viewer: NativeViewer; upstream: PreparedNativeSocket; release: () => void }>();
  app.get<{ Params: { capability: string } }>("/jf/:capability/socket", {
    websocket: true,
    preValidation: async (request, reply) => {
      let viewer: NativeViewer | undefined;
      let ownsOpening = false;
      let prepared = false;
      const abort = new AbortController();
      const stop = () => abort.abort();
      request.raw.once("aborted", stop);
      try {
        if (request.headers.upgrade?.toLowerCase() !== "websocket") throw new NativeError("native_websocket_required", 400);
        viewer = await service.authorize(request.params.capability);
        if (viewer.sockets > 0 || viewer.socketOpening) throw new NativeError("native_socket_already_connected", 409);
        viewer.socketOpening = true;
        ownsOpening = true;
        await viewer.socketCleanup;
        if (!service.active(viewer)) throw new NativeError("native_session_expired", 401);
        const upstream = await prepareNativeSocket(viewer, abort.signal);
        if (!service.active(viewer) || request.raw.aborted) { upstream.socket.terminate(); throw new NativeError("native_session_expired", 401); }
        const owner = viewer;
        const release = () => {
          clearTimeout(deadline);
          request.raw.off("aborted", cancel);
          reply.raw.off("close", cancel);
          owner.socketOpening = false;
          authorized.delete(request);
        };
        const cancel = () => { release(); upstream.socket.terminate(); };
        const deadline = setTimeout(cancel, 10_000);
        deadline.unref();
        request.raw.once("aborted", cancel);
        reply.raw.once("close", cancel);
        authorized.set(request, { viewer, upstream, release });
        prepared = true;
      }
      catch (error) { return nativeRouteError(error, reply); }
      finally { if (viewer && ownsOpening && !prepared) viewer.socketOpening = false; request.raw.off("aborted", stop); }
    }
  }, (socket, request) => {
    const pending = authorized.get(request);
    if (!pending) { socket.terminate(); return; }
    pending.release();
    bridgeNativeSocket(service, pending.viewer, socket, pending.upstream);
  });
  app.route<{ Params: { capability: string; "*": string } }>({
    method: ["GET", "HEAD", "POST", "DELETE"], url: "/jf/:capability/*",
    handler: async (request, reply) => {
      try {
        const viewer = await service.authorize(request.params.capability);
        const raw = request.raw.url ?? request.url;
        const prefix = `/jf/${request.params.capability}`;
        if (!raw.startsWith(`${prefix}/`)) throw new NativeError("native_path_denied");
        const separator = raw.indexOf("?");
        const path = raw.slice(prefix.length, separator === -1 ? undefined : separator);
        const query = new URLSearchParams(separator === -1 ? "" : raw.slice(separator + 1));
        return await proxyNativeRequest(service, viewer, request, reply, path, query);
      } catch (error) { return nativeRouteError(error, reply); }
    }
  });
};
