import { z } from "zod";
import { discordCommands } from "./discordCommands.js";

const existingCommandSchema = z.object({
  id: z.string(), type: z.number(), name: z.string(), description: z.string().optional(),
  name_localizations: z.record(z.string(), z.string()).nullable().optional(),
  description_localizations: z.record(z.string(), z.string()).nullable().optional(),
  default_member_permissions: z.string().nullable().optional(),
  contexts: z.array(z.number()).nullable().optional(), integration_types: z.array(z.number()).optional(),
  nsfw: z.boolean().optional()
});

/** Registration changes app configuration only; it never invokes a command or posts a message. */
export async function registerDiscordCommands(applicationId: string, botToken: string, guildId?: string): Promise<number> {
  const base = `https://discord.com/api/v10/applications/${applicationId}`;
  const headers = { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" };
  async function request(url: string, method = "GET", body?: unknown) {
    const response = await fetch(url, {
      method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error(`Unable to configure Discord commands: HTTP ${response.status}`);
    return response;
  }
  const existing = z.array(existingCommandSchema).parse(await (await request(`${base}/commands`)).json());
  const entry = existing.find((command) => command.type === 4);
  const { id: _id, ...settings } = entry ?? { id: "", type: 4, name: "launch", description: "Open Jellyfin Watch in this channel",
    contexts: [0], integration_types: [0] };
  // Discord's default handler=2 also sends a public launch message. APP_HANDLER
  // delegates to our signed webhook, which returns LAUNCH_ACTIVITY without a follow-up.
  // Keep an existing entry point's name, availability and permission restrictions.
  const entryPoint = { ...settings, handler: 1 };
  if (guildId) {
    // Entry points are global even when slash/context commands are guild-scoped.
    // Patch only this entry; never replace unrelated global commands in this mode.
    if (entry) await request(`${base}/commands/${entry.id}`, "PATCH", { handler: 1 });
    else await request(`${base}/commands`, "POST", entryPoint);
    await request(`${base}/guilds/${guildId}/commands`, "PUT", discordCommands);
    return discordCommands.length;
  }
  const commands = [...discordCommands, entryPoint];
  await request(`${base}/commands`, "PUT", commands);
  return commands.length;
}
