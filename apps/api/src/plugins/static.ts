import staticPlugin from "@fastify/static";
import type { FastifyPluginAsync } from "fastify";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const repoRootFromDist = path.resolve(currentDir, "../../../..");
const frontendDist = path.join(repoRootFromDist, "apps/activity-web/dist");

async function exists(directory: string): Promise<boolean> {
  try {
    await access(directory);
    return true;
  } catch {
    return false;
  }
}

export const staticFrontendPlugin: FastifyPluginAsync = async (app) => {
  if (!(await exists(frontendDist))) {
    app.log.warn({ frontendDist }, "frontend build output not found; static serving disabled");
    return;
  }

  await app.register(staticPlugin, {
    root: frontendDist,
    wildcard: false
  });

  app.setNotFoundHandler(async (request, reply) => {
    if (request.method === "GET" && !request.url.startsWith("/api") && !request.url.startsWith("/ws") && !request.url.startsWith("/media")) {
      return reply.sendFile("index.html");
    }

    return reply.code(404).send({
      error: {
        code: "not_found",
        message: "Route not found"
      }
    });
  });
};
