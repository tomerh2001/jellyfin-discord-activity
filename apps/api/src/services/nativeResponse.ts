import type { FastifyReply } from "fastify";

/** Compress only complete native JSON or rewritten playlists, after sanitizing. */
export function sendNativeText(reply: FastifyReply, value: unknown): FastifyReply {
  const request = reply.request;
  if (value == null || request.method === "HEAD" || request.headers.range !== undefined
    || reply.statusCode !== 200 || reply.hasHeader("Content-Range") || reply.hasHeader("Content-Encoding")) {
    return reply.send(value);
  }
  // Fastify's serializer retains the normal JSON representation. The plugin
  // negotiates encodings and streams larger compression jobs off the event loop.
  reply.compress(typeof value === "string" ? value : reply.serialize(value));
  return reply;
}
