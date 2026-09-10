import { expect, it, vi } from "vitest";
import { authenticateDiscord, type ActivityDiscordContext } from "./sdk.js";
import { mapActivityParticipants } from "./participants.js";

it("retains the authenticated SDK user on the context so a real Activity can identify You", async () => {
  const user = { id: "1234567890", username: "viewer", global_name: "Display viewer", avatar: null };
  const authenticate = vi.fn(async () => ({ user, scopes: ["identify"], application: { id: "app", icon: null } }));
  // initializeDiscord returns a real SDK context before it knows the user.
  const context = { instanceId: "instance", isMock: false, sdk: { commands: { authenticate } } } as unknown as ActivityDiscordContext;
  expect(context.user).toBeUndefined();
  const authenticated = await authenticateDiscord(context, "synthetic-access-token");
  expect(context.user).toEqual({ id: user.id, username: user.username, globalName: user.global_name, avatar: null });
  expect(authenticated).toBe(context.user);
  expect(mapActivityParticipants(context, [user])).toEqual([{ id: user.id, displayName: user.global_name, isSelf: true }]);
  expect(authenticate).toHaveBeenCalledExactlyOnceWith({ access_token: "synthetic-access-token" });
});
