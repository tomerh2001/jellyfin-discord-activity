import type { FastifyPluginAsync } from "fastify";
import type { AppEnv } from "../env.js";
import { roomManager } from "../services/roomManager.js";
import { roomSocketHub } from "../ws/roomSocket.js";

export function roomCleanupPlugin(env: AppEnv): FastifyPluginAsync {
  return async (app) => {
    const interval = setInterval(() => {
      const removed = roomManager.cleanupIdle({
        idleTtlSeconds: env.ROOM_IDLE_TTL_SECONDS,
        activeInstanceIds: roomSocketHub.activeInstanceIds()
      });

      if (removed.length > 0) {
        app.log.info({ removedRooms: removed.length }, "removed idle rooms");
      }
    }, Math.min(env.ROOM_IDLE_TTL_SECONDS * 1000, 60_000));

    interval.unref();

    app.addHook("onClose", async () => {
      clearInterval(interval);
    });
  };
}
