import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { loadEnv } from "../env.js";

const encryptionKey = Buffer.alloc(32, 7).toString("base64");

describe.sequential("Jellyfin auth routes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("links, stores an encrypted token, lists libraries, and unlinks", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "djf-jellyfin-"));
    const app = await buildApp(loadEnv({
      NODE_ENV: "test",
      DEV_AUTH_MOCK: "true",
      APP_SESSION_SECRET: "test-session-secret-that-is-long-enough",
      TOKEN_ENCRYPTION_KEY: encryptionKey,
      DATABASE_URL: `file:${path.join(dataDir, "app.db")}`,
      JELLYFIN_DEFAULT_SERVER_URL: "https://jellyfin.example.com"
    }));

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();

      if (url === "https://jellyfin.example.com/Users/AuthenticateByName") {
        expect(init?.headers).toMatchObject({
          "Content-Type": "application/json"
        });
        expect(JSON.parse(init?.body?.toString() ?? "{}")).toMatchObject({
          Username: "demo",
          Pw: "password"
        });

        return jsonResponse({
          User: {
            Id: "jellyfin-user-1",
            Name: "demo"
          },
          AccessToken: "secret-jellyfin-token",
          ServerId: "server-1"
        });
      }

      if (url === "https://jellyfin.example.com/Users/jellyfin-user-1/Views") {
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toContain("Token=\"secret-jellyfin-token\"");

        return jsonResponse({
          Items: [{
            Id: "movies",
            Name: "Movies",
            CollectionType: "movies"
          }]
        });
      }

      if (url.startsWith("https://jellyfin.example.com/Users/jellyfin-user-1/Items?")) {
        const parsed = new URL(url);
        expect(parsed.searchParams.get("Recursive")).toBe(parsed.searchParams.get("ParentId") === "tv" ? "false" : "true");

        if (parsed.searchParams.get("ParentId") === "tv") {
          expect(parsed.searchParams.get("IncludeItemTypes")).toBe("Series");

          return jsonResponse({
            Items: [{
            Id: "series-1",
            Name: "Example Series",
            Type: "Series",
            RunTimeTicks: 0,
            ImageTags: {
              Primary: "series-image-tag"
            }
            }],
            TotalRecordCount: 1
          });
        }

        expect(parsed.searchParams.get("ParentId")).toBe("movies");
        expect(parsed.searchParams.get("IncludeItemTypes")).toBe("Movie,Episode");

        return jsonResponse({
          Items: [{
            Id: "movie-1",
            Name: "Example Movie",
            Type: "Movie",
            ProductionYear: 2026,
            RunTimeTicks: 72000000000,
            ImageTags: {
              Primary: "image-tag"
            }
          }],
          TotalRecordCount: 1
        });
      }

      if (url.startsWith("https://jellyfin.example.com/Users/jellyfin-user-1/Items/movie-1")) {
        return jsonResponse({
          Id: "movie-1",
          Name: "Example Movie",
          Type: "Movie",
          Overview: "A movie used by tests.",
          ProductionYear: 2026,
          RunTimeTicks: 72000000000
        });
      }

      if (url.startsWith("https://jellyfin.example.com/Items/movie-1/Images/Primary")) {
        const headers = new Headers(init?.headers);
        const parsed = new URL(url);

        expect(headers.get("authorization")).toContain("Token=\"secret-jellyfin-token\"");
        expect(parsed.searchParams.get("fillWidth")).toBe("320");
        expect(parsed.searchParams.get("tag")).toBe("image-tag");

        return new Response("image-bytes", {
          status: 200,
          headers: {
            "Content-Type": "image/jpeg",
            ETag: "\"image-tag\""
          }
        });
      }

      return jsonResponse({}, 404);
    }));

    const appToken = await createAppToken(app);

    const link = await app.inject({
      method: "POST",
      url: "/api/jellyfin/link",
      headers: {
        authorization: `Bearer ${appToken}`
      },
      payload: {
        username: "demo",
        password: "password"
      }
    });

    expect(link.statusCode).toBe(200);
    expect(link.body).not.toContain("secret-jellyfin-token");
    expect(link.json()).toMatchObject({
      linked: true,
      jellyfinUser: {
        id: "jellyfin-user-1",
        name: "demo"
      },
      serverUrl: "https://jellyfin.example.com"
    });

    const storeFile = await readFile(path.join(dataDir, "jellyfin-accounts.json"), "utf8");
    expect(storeFile).not.toContain("secret-jellyfin-token");
    expect(storeFile).toContain("\"encryptedAccessToken\": \"v1.");

    const status = await app.inject({
      method: "GET",
      url: "/api/jellyfin/status",
      headers: {
        authorization: `Bearer ${appToken}`
      }
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      linked: true,
      username: "demo"
    });

    const libraries = await app.inject({
      method: "GET",
      url: "/api/jellyfin/libraries",
      headers: {
        authorization: `Bearer ${appToken}`
      }
    });
    expect(libraries.statusCode, JSON.stringify(libraries.json())).toBe(200);
    expect(libraries.json()).toEqual({
      libraries: [{
        id: "movies",
        name: "Movies",
        collectionType: "movies"
      }]
    });

    const items = await app.inject({
      method: "GET",
      url: "/api/jellyfin/items?parentId=movies&type=Movie,Episode&limit=50",
      headers: {
        authorization: `Bearer ${appToken}`
      }
    });
    expect(items.statusCode).toBe(200);
    expect(items.json()).toEqual({
      items: [{
        id: "movie-1",
        name: "Example Movie",
        type: "Movie",
        productionYear: 2026,
        runtimeTicks: 72000000000,
        imageItemId: "movie-1",
        imageTag: "image-tag"
      }],
      totalRecordCount: 1
    });

    const series = await app.inject({
      method: "GET",
      url: "/api/jellyfin/items?parentId=tv&type=Series&recursive=false&limit=100",
      headers: {
        authorization: `Bearer ${appToken}`
      }
    });
    expect(series.statusCode).toBe(200);
    expect(series.json()).toEqual({
      items: [{
        id: "series-1",
        name: "Example Series",
        type: "Series",
        imageItemId: "series-1",
        imageTag: "series-image-tag"
      }],
      totalRecordCount: 1
    });

    const image = await app.inject({
      method: "GET",
      url: "/api/jellyfin/items/movie-1/image?width=320&tag=image-tag",
      headers: {
        authorization: `Bearer ${appToken}`
      }
    });
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toBe("image/jpeg");
    expect(image.body).toBe("image-bytes");

    const details = await app.inject({
      method: "GET",
      url: "/api/jellyfin/items/movie-1",
      headers: {
        authorization: `Bearer ${appToken}`
      }
    });
    expect(details.statusCode).toBe(200);
    expect(details.json()).toMatchObject({
      item: {
        id: "movie-1",
        name: "Example Movie",
        overview: "A movie used by tests."
      }
    });

    const unlink = await app.inject({
      method: "DELETE",
      url: "/api/jellyfin/link",
      headers: {
        authorization: `Bearer ${appToken}`
      }
    });
    expect(unlink.statusCode).toBe(200);
    expect(unlink.json()).toEqual({ linked: false });

    await app.close();
  });

  it("returns a friendly error for wrong Jellyfin credentials", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "djf-jellyfin-"));
    const app = await buildApp(loadEnv({
      NODE_ENV: "test",
      DEV_AUTH_MOCK: "true",
      APP_SESSION_SECRET: "test-session-secret-that-is-long-enough",
      TOKEN_ENCRYPTION_KEY: encryptionKey,
      DATABASE_URL: `file:${path.join(dataDir, "app.db")}`,
      JELLYFIN_DEFAULT_SERVER_URL: "https://jellyfin.example.com"
    }));

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      error: "Unauthorized"
    }, 401)));

    const appToken = await createAppToken(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/jellyfin/link",
      headers: {
        authorization: `Bearer ${appToken}`
      },
      payload: {
        username: "demo",
        password: "wrong"
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: {
        code: "invalid_jellyfin_credentials",
        message: "Invalid Jellyfin username or password."
      }
    });

    await app.close();
  });

  it("uses a configured shared Jellyfin account without per-user linking", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "djf-jellyfin-shared-"));
    const app = await buildApp(loadEnv({
      NODE_ENV: "test",
      DEV_AUTH_MOCK: "true",
      APP_SESSION_SECRET: "test-session-secret-that-is-long-enough",
      TOKEN_ENCRYPTION_KEY: encryptionKey,
      DATABASE_URL: `file:${path.join(dataDir, "app.db")}`,
      JELLYFIN_DEFAULT_SERVER_URL: "https://jellyfin.example.com",
      JELLYFIN_AUTH_MODE: "shared",
      JELLYFIN_SHARED_USERNAME: "discord-watch",
      JELLYFIN_SHARED_PASSWORD: "shared-password"
    }));

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();

      if (url === "https://jellyfin.example.com/Users/AuthenticateByName") {
        expect(JSON.parse(init?.body?.toString() ?? "{}")).toMatchObject({
          Username: "discord-watch",
          Pw: "shared-password"
        });

        return jsonResponse({
          User: {
            Id: "shared-jellyfin-user",
            Name: "discord-watch"
          },
          AccessToken: "shared-secret-token"
        });
      }

      if (url === "https://jellyfin.example.com/Users/shared-jellyfin-user/Views") {
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toContain("Token=\"shared-secret-token\"");

        return jsonResponse({
          Items: [{
            Id: "movies",
            Name: "Shared Movies",
            CollectionType: "movies"
          }]
        });
      }

      if (url.startsWith("https://jellyfin.example.com/Users/shared-jellyfin-user/Items?")) {
        return jsonResponse({
          Items: [{
            Id: "movie-1",
            Name: "Shared Movie",
            Type: "Movie"
          }],
          TotalRecordCount: 1
        });
      }

      if (url.startsWith("https://jellyfin.example.com/Users/shared-jellyfin-user/Items/movie-1")) {
        return jsonResponse({
          Id: "movie-1",
          Name: "Shared Movie",
          Type: "Movie"
        });
      }

      return jsonResponse({}, 404);
    }));

    const appToken = await createAppToken(app);
    const status = await app.inject({
      method: "GET",
      url: "/api/jellyfin/status",
      headers: {
        authorization: `Bearer ${appToken}`
      }
    });

    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      linked: true,
      authMode: "shared",
      username: "discord-watch",
      serverUrl: "https://jellyfin.example.com"
    });

    const link = await app.inject({
      method: "POST",
      url: "/api/jellyfin/link",
      headers: {
        authorization: `Bearer ${appToken}`
      },
      payload: {
        username: "demo",
        password: "password"
      }
    });
    expect(link.statusCode).toBe(409);
    expect(link.json()).toMatchObject({
      error: {
        code: "jellyfin_shared_mode_enabled"
      }
    });

    const libraries = await app.inject({
      method: "GET",
      url: "/api/jellyfin/libraries",
      headers: {
        authorization: `Bearer ${appToken}`
      }
    });
    expect(libraries.statusCode, JSON.stringify(libraries.json())).toBe(200);
    expect(libraries.json()).toEqual({
      libraries: [{
        id: "movies",
        name: "Shared Movies",
        collectionType: "movies"
      }]
    });

    const items = await app.inject({
      method: "GET",
      url: "/api/jellyfin/items?parentId=movies&type=Movie,Episode&limit=50",
      headers: {
        authorization: `Bearer ${appToken}`
      }
    });
    expect(items.statusCode).toBe(200);
    expect(items.json()).toMatchObject({
      items: [{
        id: "movie-1",
        name: "Shared Movie"
      }]
    });

    const details = await app.inject({
      method: "GET",
      url: "/api/jellyfin/items/movie-1",
      headers: {
        authorization: `Bearer ${appToken}`
      }
    });
    expect(details.statusCode).toBe(200);
    expect(details.json()).toMatchObject({
      item: {
        id: "movie-1",
        name: "Shared Movie"
      }
    });

    const unlink = await app.inject({
      method: "DELETE",
      url: "/api/jellyfin/link",
      headers: {
        authorization: `Bearer ${appToken}`
      }
    });
    expect(unlink.statusCode).toBe(409);

    const storeFile = await readFile(path.join(dataDir, "jellyfin-accounts.json"), "utf8");
    expect(storeFile).not.toContain("shared-secret-token");
    expect(storeFile).not.toContain("shared-password");
    expect(storeFile).toContain("__shared_jellyfin_account__");

    await app.close();
  });

  it("returns a clear error when shared Jellyfin credentials are missing", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "djf-jellyfin-shared-missing-"));
    const app = await buildApp(loadEnv({
      NODE_ENV: "test",
      DEV_AUTH_MOCK: "true",
      APP_SESSION_SECRET: "test-session-secret-that-is-long-enough",
      TOKEN_ENCRYPTION_KEY: encryptionKey,
      DATABASE_URL: `file:${path.join(dataDir, "app.db")}`,
      JELLYFIN_DEFAULT_SERVER_URL: "https://refresh-jellyfin.example.com",
      JELLYFIN_AUTH_MODE: "shared"
    }));

    const appToken = await createAppToken(app);
    const status = await app.inject({
      method: "GET",
      url: "/api/jellyfin/status",
      headers: {
        authorization: `Bearer ${appToken}`
      }
    });

    expect(status.statusCode).toBe(500);
    expect(status.json()).toMatchObject({
      error: {
        code: "jellyfin_shared_not_configured"
      }
    });

    await app.close();
  });

  it("reauthenticates the shared account once when its token is rejected", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "djf-jellyfin-shared-refresh-"));
    const app = await buildApp(loadEnv({
      NODE_ENV: "test",
      DEV_AUTH_MOCK: "true",
      APP_SESSION_SECRET: "test-session-secret-that-is-long-enough",
      TOKEN_ENCRYPTION_KEY: encryptionKey,
      DATABASE_URL: `file:${path.join(dataDir, "app.db")}`,
      JELLYFIN_DEFAULT_SERVER_URL: "https://refresh-jellyfin.example.com",
      JELLYFIN_AUTH_MODE: "shared",
      JELLYFIN_SHARED_USERNAME: "discord-watch",
      JELLYFIN_SHARED_PASSWORD: "shared-password"
    }));
    let authCount = 0;
    let viewsCount = 0;

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();

      if (url === "https://refresh-jellyfin.example.com/Users/AuthenticateByName") {
        authCount += 1;
        return jsonResponse({
          User: {
            Id: "shared-jellyfin-user",
            Name: "discord-watch"
          },
          AccessToken: authCount === 1 ? "expired-shared-token" : "fresh-shared-token"
        });
      }

      if (url === "https://refresh-jellyfin.example.com/Users/shared-jellyfin-user/Views") {
        viewsCount += 1;
        const headers = new Headers(init?.headers);

        if (viewsCount === 1) {
          expect(headers.get("authorization")).toContain("Token=\"expired-shared-token\"");
          return jsonResponse({ error: "Unauthorized" }, 401);
        }

        expect(headers.get("authorization")).toContain("Token=\"fresh-shared-token\"");
        return jsonResponse({
          Items: [{
            Id: "movies",
            Name: "Movies",
            CollectionType: "movies"
          }]
        });
      }

      return jsonResponse({}, 404);
    }));

    const appToken = await createAppToken(app);
    const libraries = await app.inject({
      method: "GET",
      url: "/api/jellyfin/libraries",
      headers: {
        authorization: `Bearer ${appToken}`
      }
    });

    expect(libraries.statusCode, JSON.stringify(libraries.json())).toBe(200);
    expect(libraries.json()).toMatchObject({
      libraries: [{
        id: "movies"
      }]
    });
    expect(authCount).toBe(2);
    expect(viewsCount).toBe(2);

    await app.close();
  });
});

async function createAppToken(app: Awaited<ReturnType<typeof buildApp>>): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/discord/exchange",
    payload: {
      code: "dev-mock:dev-user-host",
      instanceId: "instance-1",
      mockUser: {
        id: "dev-user-host",
        username: "DevHost",
        avatar: null
      }
    }
  });

  return response.json().appToken as string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
