import Fastify from "fastify";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { brotliCompressSync, gzipSync, gunzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { loadEnv } from "../env.js";
import { discordProxyPlugin } from "../plugins/discordProxy.js";
import { staticFrontendPlugin } from "../plugins/static.js";

it("compresses packaged assets and revalidates browser copies behind ingress without caching private data", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "activity-static-"));
  const frontend = path.join(directory, "frontend");
  const native = path.join(directory, "native");
  const secret = randomBytes(32).toString("hex");
  const headers = { "x-jellyfin-discord-edge": secret };
  const javascript = "console.log('packaged code');".repeat(100);
  await mkdir(frontend); await mkdir(native);
  await writeFile(path.join(frontend, "index.html"), "<!doctype html><title>Activity</title>");
  await writeFile(path.join(native, "index.html"), "<!doctype html><title>Native</title>");
  await writeFile(path.join(native, "player.js"), javascript);
  await writeFile(path.join(native, "player.js.gz"), gzipSync(javascript));
  await writeFile(path.join(native, "player.js.br"), brotliCompressSync(javascript));
  const app = Fastify();
  app.decorate("envConfig", loadEnv({ NODE_ENV: "test", DISCORD_REQUIRE_PROXY_AUTH: "true", DISCORD_PROXY_AUTH_MODE: "cloudflare-worker", DISCORD_PROXY_EDGE_SECRET: secret }));
  await app.register(discordProxyPlugin(app.envConfig));
  app.get("/api/example.js", async () => ({ secret: "must-not-cache" }));
  await app.register(staticFrontendPlugin, { frontendDirectory: frontend, nativeDirectory: native });
  try {
    const compressed = await app.inject({ url: "/jellyfin-web/player.js", headers: { ...headers, "accept-encoding": "gzip" } });
    expect(compressed.statusCode).toBe(200);
    expect(compressed.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(compressed.rawPayload).toString()).toBe(javascript);
    expect(compressed.headers["cache-control"]).toBe("private, no-cache, max-age=0, must-revalidate");
    expect(compressed.headers["cloudflare-cdn-cache-control"]).toBe("no-store");
    expect(compressed.headers.vary).toContain("Accept-Encoding");
    const conditional = { ...headers, "accept-encoding": "gzip", "if-none-match": String(compressed.headers.etag) };
    const revalidated = await app.inject({ url: "/jellyfin-web/player.js", headers: conditional });
    expect(revalidated.statusCode).toBe(304);
    expect(revalidated.headers["cache-control"]).toContain("must-revalidate");
    const rejected = await app.inject({ url: "/jellyfin-web/player.js", headers: { "if-none-match": String(compressed.headers.etag) } });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.headers["cache-control"]).toBe("private, no-store");
    for (const url of ["/", "/missing.js", "/missing.css", "/jellyfin-web/index.html", "/api/example.js", "/jellyfin-web/missing.js"]) {
      const response = await app.inject({ url, headers });
      expect(response.headers["cache-control"], url).toBe("private, no-store");
    }
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
