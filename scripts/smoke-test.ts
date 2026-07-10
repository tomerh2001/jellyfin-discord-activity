type JsonRecord = Record<string, unknown>;

const baseUrl = stripTrailingSlash(process.env.SMOKE_BASE_URL ?? "http://localhost:3000");
const wsUrl = process.env.SMOKE_WS_URL ?? httpToWs(baseUrl, "/ws");
const instanceId = process.env.SMOKE_INSTANCE_ID ?? `smoke-${Date.now()}`;

await checkHealth();
await checkAuthGuard();
const appToken = process.env.SMOKE_APP_TOKEN ?? await createDevMockAppToken();
await checkWebSocket(appToken);

console.log("Smoke test passed.");

async function checkHealth(): Promise<void> {
  const response = await fetch(`${baseUrl}/health`);

  if (!response.ok) {
    throw new Error(`Health check failed with HTTP ${response.status}.`);
  }

  const body = await response.json() as unknown;

  if (!isRecord(body) || body.ok !== true) {
    throw new Error("Health check response did not include { ok: true }.");
  }

  console.log("health: ok");
}

async function checkAuthGuard(): Promise<void> {
  const response = await fetch(`${baseUrl}/api/me`);
  const body = await response.json().catch(() => undefined) as unknown;

  if (response.status !== 401) {
    throw new Error(`/api/me auth guard failed. Expected HTTP 401, got HTTP ${response.status}.`);
  }

  if (!isRecord(body) || !isRecord(body.error) || typeof body.error.code !== "string") {
    throw new Error("/api/me auth guard response did not include an error code.");
  }

  console.log(`auth guard: ${body.error.code}`);
}

async function createDevMockAppToken(): Promise<string> {
  const response = await fetch(`${baseUrl}/api/discord/exchange`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      code: "dev-mock:smoke-user",
      instanceId,
      mockUser: {
        id: "smoke-user",
        username: "SmokeUser",
        globalName: "Smoke User",
        avatar: null
      }
    })
  });

  const body = await response.json().catch(() => undefined) as unknown;

  if (!response.ok) {
    throw new Error([
      `Dev mock exchange failed with HTTP ${response.status}.`,
      "Set DEV_AUTH_MOCK=true on the target app for local smoke tests,",
      "or provide SMOKE_APP_TOKEN for a target where you already authenticated through Discord.",
      `Response: ${JSON.stringify(body)}`
    ].join(" "));
  }

  if (!isRecord(body) || typeof body.appToken !== "string") {
    throw new Error("Dev mock exchange response did not include appToken.");
  }

  console.log("dev mock auth: ok");
  return body.appToken;
}

async function checkWebSocket(appToken: string): Promise<void> {
  if (typeof WebSocket === "undefined") {
    throw new Error("This smoke test requires Node.js with a global WebSocket implementation. Use Node.js 22 or newer.");
  }

  const url = new URL(wsUrl);
  url.searchParams.set("token", appToken);
  url.searchParams.set("instanceId", instanceId);

  const socket = new WebSocket(url);

  try {
    const firstMessage = await waitForMessage(socket);

    if (!isRecord(firstMessage) || firstMessage.type !== "hello_ack") {
      throw new Error(`Expected first WebSocket message type hello_ack, got ${JSON.stringify(firstMessage)}.`);
    }

    socket.send(JSON.stringify({
      type: "ping",
      clientTs: Date.now(),
      ts: Date.now()
    }));

    const pong = await waitForMessageType(socket, "pong");

    if (!isRecord(pong) || pong.type !== "pong") {
      throw new Error("WebSocket did not return pong.");
    }

    console.log("websocket: ok");
  } finally {
    socket.close(1000, "smoke complete");
  }
}

function waitForMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for WebSocket message."));
    }, 5000);

    socket.addEventListener("message", (event) => {
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(String(event.data)) as unknown);
      } catch {
        reject(new Error(`WebSocket message was not JSON: ${String(event.data)}`));
      }
    }, { once: true });

    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("WebSocket connection failed."));
    }, { once: true });

    socket.addEventListener("close", (event) => {
      clearTimeout(timeout);
      reject(new Error(`WebSocket closed before expected message. Code ${event.code}, reason ${event.reason}.`));
    }, { once: true });
  });
}

async function waitForMessageType(socket: WebSocket, type: string): Promise<unknown> {
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    const message = await waitForMessage(socket);

    if (isRecord(message) && message.type === type) {
      return message;
    }
  }

  throw new Error(`Timed out waiting for WebSocket message type ${type}.`);
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function httpToWs(origin: string, path: string): string {
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = path;
  url.search = "";
  return url.toString();
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
