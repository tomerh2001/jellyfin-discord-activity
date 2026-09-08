import { describe, expect, it } from "vitest";
import { discordExchangeRequestSchema } from "./index.js";

describe("Discord exchange boundary", () => {
  it("requires an Activity instance before accepting an OAuth exchange", () => {
    expect(discordExchangeRequestSchema.safeParse({ code: "oauth-code" }).success).toBe(false);
    expect(discordExchangeRequestSchema.parse({ code: "oauth-code", instanceId: "instance-1" })).toEqual({
      code: "oauth-code", instanceId: "instance-1"
    });
  });
});
