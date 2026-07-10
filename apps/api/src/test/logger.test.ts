import { describe, expect, it } from "vitest";
import { redactUrl } from "../logger.js";

describe("logger redaction", () => {
  it("redacts sensitive query parameters", () => {
    expect(redactUrl("/ws?token=secret-token&instanceId=room-1")).toBe("/ws?token=%5Bredacted%5D&instanceId=room-1");
    expect(redactUrl("/api/discord/callback?code=oauth-code")).toBe("/api/discord/callback?code=%5Bredacted%5D");
  });
});
