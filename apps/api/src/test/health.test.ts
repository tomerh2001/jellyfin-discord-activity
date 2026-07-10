import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { loadEnv } from "../env.js";

describe("health routes", () => {
  it("returns ok on /health", async () => {
    const app = await buildApp(loadEnv({ NODE_ENV: "test" }));

    const response = await app.inject("/health");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });

    await app.close();
  });

  it("returns ok on /api/health", async () => {
    const app = await buildApp(loadEnv({ NODE_ENV: "test" }));

    const response = await app.inject("/api/health");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });

    await app.close();
  });

  it("returns JSON rate limit errors", async () => {
    const app = await buildApp(loadEnv({
      NODE_ENV: "test",
      RATE_LIMIT_MAX: "1",
      RATE_LIMIT_WINDOW: "1 minute"
    }));

    expect((await app.inject("/api/config")).statusCode).toBe(200);
    const limited = await app.inject("/api/config");

    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({
      error: {
        code: "rate_limit_exceeded"
      }
    });

    await app.close();
  });

  it("does not send headers that block Discord Activity iframe embedding", async () => {
    const app = await buildApp(loadEnv({ NODE_ENV: "test" }));

    const response = await app.inject("/health");

    expect(response.headers["x-frame-options"]).toBeUndefined();
    expect(response.headers["cross-origin-opener-policy"]).toBeUndefined();
    expect(response.headers["cross-origin-resource-policy"]).toBeUndefined();

    await app.close();
  });
});
