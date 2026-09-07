import { loadEnv } from "./env.js";
import { loadSecretFiles } from "./services/secretFiles.js";
import { discordCommands } from "./services/discordCommands.js";

const env = loadEnv(loadSecretFiles());
if (!env.DISCORD_BOT_TOKEN) throw new Error("DISCORD_BOT_TOKEN is required.");
const guildId = process.argv[2];
if (guildId && !/^\d{17,20}$/.test(guildId)) throw new Error("Expected a Discord server ID.");
const base = `https://discord.com/api/v10/applications/${env.DISCORD_CLIENT_ID}`;
const headers = { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" };
const commands: unknown[] = [...discordCommands];
if (!guildId) {
  // Preserve Discord's auto-created Activity launch entry point during bulk replacement.
  const response = await fetch(`${base}/commands`, { headers, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Unable to read existing commands: HTTP ${response.status}`);
  const existing = await response.json() as { type: number; name: string; description: string; handler?: number }[];
  for (const command of existing.filter((command) => command.type === 4)) {
    commands.push({ type: 4, name: command.name, description: command.description, handler: command.handler ?? 2 });
  }
}
const route = guildId ? `${base}/guilds/${guildId}/commands` : `${base}/commands`;
const response = await fetch(route, { method: "PUT", headers, body: JSON.stringify(commands), signal: AbortSignal.timeout(15_000) });
if (!response.ok) throw new Error(`Unable to register commands: HTTP ${response.status}`);
console.log(`Registered ${commands.length} commands ${guildId ? `in server ${guildId}` : "globally"}.`);
