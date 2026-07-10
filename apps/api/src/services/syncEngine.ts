import type { PlayState } from "@app/shared";
import type { ClientMessage } from "../ws/messages.js";

export function calculateDriftSeconds(localSeconds: number, remoteSeconds: number): number {
  return remoteSeconds - localSeconds;
}

export function playStateForAction(action: Extract<ClientMessage, { type: "player_event" }>["action"]): Extract<PlayState, "playing" | "paused" | "buffering" | "ended"> {
  switch (action) {
    case "play":
      return "playing";
    case "pause":
    case "seek":
      return "paused";
    case "buffering":
      return "buffering";
    case "ended":
      return "ended";
  }
}

export function targetServerTimestamp(action: Extract<ClientMessage, { type: "player_event" }>["action"], now = Date.now()): number {
  return now + (action === "play" ? 1000 : 300);
}
