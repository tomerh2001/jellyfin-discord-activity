import staticPlugin from "@fastify/static";
import type { FastifyPluginAsync } from "fastify";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const repoRootFromDist = path.resolve(currentDir, "../../../..");
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

export const staticFrontendPlugin: FastifyPluginAsync<{ nativeDirectory?: string }> = async (app, options) => {
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
  if (!(await exists(nativeRoot))) {
    if (app.envConfig.NODE_ENV === "production") throw new Error("The packaged Jellyfin Web client is missing. Build the complete release image.");
    app.log.warn("native client build output not found; static serving disabled");
    return;
  }
  // The native HashRouter runs in the Activity document itself. Every packaged
  // route still passes the Discord ingress hook before serving or revalidation.
  await app.register(staticPlugin, {
    root: nativeRoot,
    // Native vendor chunks contain @ scopes; the wildcard handler decodes
    // browser-encoded %40 paths before looking up the packaged filename.
    wildcard: true,
    preCompressed: true,
    cacheControl: false
  });
};
