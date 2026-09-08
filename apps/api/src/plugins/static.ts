import staticPlugin from "@fastify/static";
import type { FastifyPluginAsync } from "fastify";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const repoRootFromDist = path.resolve(currentDir, "../../../..");
const frontendDist = path.join(repoRootFromDist, "apps/activity-web/dist");
const nativeDist = path.join(repoRootFromDist, "native-client/dist");

declare module "fastify" {
  interface FastifyContextConfig { jellyfinStatic?: boolean; }
}

async function exists(directory: string): Promise<boolean> {
  try {
    await access(directory);
    return true;
  } catch {
    return false;
  }
}

export const staticFrontendPlugin: FastifyPluginAsync<{ frontendDirectory?: string; nativeDirectory?: string }> = async (app, options) => {
  const frontendRoot = options.frontendDirectory ?? frontendDist;
  const nativeRoot = options.nativeDirectory ?? nativeDist;
  app.addHook("onRoute", (route) => { route.config = { ...route.config, jellyfinStatic: true }; });
  app.addHook("onSend", async (request, reply, payload) => {
    // Browser copies must revalidate through the ingress gate on every use.
    // Only packaged assets qualify; no HTML, API, media or credential response.
    if (request.routeOptions.config.jellyfinStatic && ["GET", "HEAD"].includes(request.method)
      && [200, 304].includes(reply.statusCode)
      && /\.(?:js|mjs|css|json|svg|png|jpe?g|webp|avif|ico|woff2?|ttf|wasm)$/i.test(request.url.split("?", 1)[0] ?? "")) {
      reply.header("Cache-Control", "private, no-cache, max-age=0, must-revalidate");
      reply.header("CDN-Cache-Control", "no-store");
      reply.header("Cloudflare-CDN-Cache-Control", "no-store");
      const vary = String(reply.getHeader("Vary") ?? "").split(",").map(value => value.trim()).filter(Boolean);
      if (!vary.some(value => value.toLowerCase() === "accept-encoding")) vary.push("Accept-Encoding");
      reply.header("Vary", vary.join(", "));
    }
    return payload;
  });
  if (await exists(nativeRoot)) {
    await app.register(staticPlugin, {
      root: nativeRoot,
      prefix: "/jellyfin-web/",
      decorateReply: false,
      cacheControl: false,
      preCompressed: true
    });
  } else if (app.envConfig.NODE_ENV === "production") {
    throw new Error("The packaged Jellyfin Web client is missing. Build the complete release image.");
  }
  if (!(await exists(frontendRoot))) {
    app.log.warn({ frontendDist: frontendRoot }, "frontend build output not found; static serving disabled");
    return;
  }

  await app.register(staticPlugin, {
    root: frontendRoot,
    wildcard: false,
    preCompressed: true,
    cacheControl: false
  });

  app.setNotFoundHandler(async (request, reply) => {
    if (request.method === "GET" && !["/api", "/ws", "/media", "/jf/", "/jellyfin-web/"].some((prefix) => request.url.startsWith(prefix))) {
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
