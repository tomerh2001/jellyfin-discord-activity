// Read-only diagnostics. A live app token is optional and is never printed.
const base = (process.env.SMOKE_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const health = await fetch(`${base}/health`);
if (!health.ok || (await health.json() as { ok?: boolean }).ok !== true) throw new Error("Local health check failed.");
const proof: Record<string, string> = {};
if (process.env.SMOKE_EDGE_SECRET) proof["x-jellyfin-discord-edge"] = process.env.SMOKE_EDGE_SECRET;
for (const endpoint of ["/api/me", "/api/connections", "/jf/invalid/System/Info/Public"]) {
  const response = await fetch(base + endpoint, { headers: proof });
  if (response.status !== 401) throw new Error(`Authorization check failed (${response.status}).`);
  await response.body?.cancel();
}
if (process.env.SMOKE_APP_TOKEN) {
  const headers = { ...proof, authorization: `Bearer ${process.env.SMOKE_APP_TOKEN}` };
  for (const endpoint of ["/api/me", "/api/connections", "/api/party"]) {
    const response = await fetch(base + endpoint, { headers });
    if (!response.ok) throw new Error(`Authenticated read failed (${response.status}).`);
    await response.body?.cancel();
  }
}
console.log("Health and authorization checks passed. Playback requires a live native-client test.");
