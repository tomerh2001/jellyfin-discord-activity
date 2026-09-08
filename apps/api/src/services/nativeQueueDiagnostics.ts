import type { FastifyRequest } from "fastify";

export function isNativeQueuePath(path: string): boolean {
  return /\/SyncPlay\/(?:SetNewQueue|Queue)(?:\?|$)/i.test(path);
}

/** Log fixed classifications and counts only, never queue values, URLs or credentials. */
export function nativeQueueShape(request: Pick<FastifyRequest, "body" | "headers">) {
  const body = request.body;
  const value = body !== null && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const queue = value.PlayingQueue ?? value.ItemIds;
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  const mediaType = contentType === undefined ? "missing"
    : ["application/json", "text/plain", "application/x-www-form-urlencoded"].includes(contentType) ? contentType : "other";
  const bodyType = body === null ? "null" : Array.isArray(body) ? "array" : typeof body;
  return {
    mediaType, bodyType,
    queueShape: !Array.isArray(queue) ? (queue === undefined ? "missing" : "not_array")
      : queue.some((id) => typeof id !== "string") ? "non_string_items" : "string_array",
    ...(Array.isArray(queue) ? { itemCount: queue.length } : {})
  };
}
