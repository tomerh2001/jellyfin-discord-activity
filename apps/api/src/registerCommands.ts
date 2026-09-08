import { loadEnv } from "./env.js";
import { loadSecretFiles } from "./services/secretFiles.js";
import { registerDiscordCommands } from "./services/registerDiscordCommands.js";

const env = loadEnv(loadSecretFiles());
if (!env.DISCORD_BOT_TOKEN) throw new Error("DISCORD_BOT_TOKEN is required.");
const guildId = process.argv[2];
if (guildId && !/^\d{17,20}$/.test(guildId)) throw new Error("Expected a Discord server ID.");
const count = await registerDiscordCommands(env.DISCORD_CLIENT_ID, env.DISCORD_BOT_TOKEN, guildId);
console.log(`Registered ${count} commands ${guildId ? `in server ${guildId}` : "globally"}; Activity entry point uses the app handler.`);
