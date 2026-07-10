import type { ServerMessage } from "@app/shared/protocol";
import { clientMessageSchema } from "@app/shared/protocol";
import { z } from "zod";
import type { AppEnv } from "../env.js";
import { roomManager, RoomError } from "../services/roomManager.js";
import { playStateForAction, targetServerTimestamp } from "../services/syncEngine.js";
import type { ClientMessage } from "./messages.js";
import { roomSocketHub, type RoomSocket } from "./roomSocket.js";

export function handleRawMessage(env: AppEnv, client: RoomSocket, raw: unknown): void {
  const parsedJson = parseJson(raw);

  if (!parsedJson.ok) {
    sendError(client, "invalid_json", "Invalid WebSocket JSON message.");
    return;
  }

  const parsed = clientMessageSchema.safeParse(parsedJson.value);

  if (!parsed.success) {
    sendError(client, "invalid_message", "Invalid WebSocket message.", z.treeifyError(parsed.error));
    return;
  }

  handleClientMessage(env, client, parsed.data);
}

export function handleClientMessage(env: AppEnv, client: RoomSocket, message: ClientMessage): void {
  try {
    switch (message.type) {
      case "hello": {
        roomManager.getOrCreate(message.instanceId, {
          ...(message.guildId ? { guildId: message.guildId } : {}),
          ...(message.channelId ? { channelId: message.channelId } : {})
        });
        sendRoomSnapshot(client);
        return;
      }
      case "claim_host": {
        const room = roomManager.claimHost({ instanceId: client.instanceId }, client.session.discordUserId);
        broadcastRoomState(client.instanceId);
        roomSocketHub.broadcast(client.instanceId, {
          type: "host_changed",
          hostDiscordUserId: room.hostDiscordUserId ?? client.session.discordUserId,
          serverTs: Date.now()
        });
        broadcastParticipants(client.instanceId);
        return;
      }
      case "select_media": {
        const room = roomManager.selectMedia({
          instanceId: client.instanceId,
          itemId: message.itemId,
          title: message.title,
          ...(message.mediaSourceId ? { mediaSourceId: message.mediaSourceId } : {}),
          ...(message.runtimeTicks ? { runtimeTicks: message.runtimeTicks } : {}),
          ...(message.audioStreamIndex !== undefined ? { audioStreamIndex: message.audioStreamIndex } : {}),
          ...(message.subtitleStreamIndex !== undefined ? { subtitleStreamIndex: message.subtitleStreamIndex } : {})
        }, client.session.discordUserId);
        roomSocketHub.broadcast(client.instanceId, {
          type: "media_selected",
          itemId: room.itemId ?? message.itemId,
          ...(room.mediaSourceId ? { mediaSourceId: room.mediaSourceId } : {}),
          title: room.title ?? message.title,
          ...(room.runtimeTicks ? { runtimeTicks: room.runtimeTicks } : {}),
          ...(room.audioStreamIndex !== undefined ? { audioStreamIndex: room.audioStreamIndex } : {}),
          ...(room.subtitleStreamIndex !== undefined ? { subtitleStreamIndex: room.subtitleStreamIndex } : {}),
          serverTs: Date.now()
        });
        broadcastRoomState(client.instanceId);
        return;
      }
      case "player_event": {
        const now = Date.now();
        const room = roomManager.updatePlaybackState({
          instanceId: client.instanceId,
          discordUserId: client.session.discordUserId,
          playState: playStateForAction(message.action),
          positionSeconds: message.positionSeconds
        });
        roomSocketHub.broadcast(client.instanceId, {
          type: "player_event",
          action: message.action,
          positionSeconds: message.positionSeconds,
          targetServerTs: targetServerTimestamp(message.action, now),
          serverTs: now
        });
        roomSocketHub.broadcast(client.instanceId, {
          type: "room_state",
          room,
          serverTs: Date.now()
        });
        return;
      }
      case "state_update": {
        const room = roomManager.updatePlaybackState({
          instanceId: client.instanceId,
          discordUserId: client.session.discordUserId,
          playState: message.playState,
          positionSeconds: message.positionSeconds
        });
        roomSocketHub.broadcast(client.instanceId, {
          type: "state_update",
          playState: room.playState as "playing" | "paused" | "buffering",
          positionSeconds: room.positionSeconds,
          serverTs: Date.now()
        });
        return;
      }
      case "ping": {
        roomSocketHub.send(client, {
          type: "pong",
          clientTs: message.clientTs,
          serverTs: Date.now()
        });
        return;
      }
      case "ready":
        return;
      case "leave":
        client.socket.close(1000, "leave");
        return;
    }
  } catch (error) {
    if (error instanceof RoomError) {
      sendError(client, error.code, error.publicMessage);
      return;
    }

    throw error;
  }
}

export function sendRoomSnapshot(client: RoomSocket): void {
  const room = roomManager.getOrCreate(client.instanceId);
  roomSocketHub.send(client, {
    type: "hello_ack",
    clientId: client.clientId,
    serverTs: Date.now()
  });
  roomSocketHub.send(client, {
    type: "room_state",
    room,
    serverTs: Date.now()
  });
  broadcastParticipants(client.instanceId);
}

export function broadcastRoomState(instanceId: string): void {
  roomSocketHub.broadcast(instanceId, {
    type: "room_state",
    room: roomManager.getOrCreate(instanceId),
    serverTs: Date.now()
  });
}

export function broadcastParticipants(instanceId: string): void {
  const room = roomManager.getOrCreate(instanceId);
  roomSocketHub.broadcast(instanceId, {
    type: "participants_update",
    participants: roomSocketHub.participants(instanceId, room.hostDiscordUserId),
    serverTs: Date.now()
  });
}

export function sendError(client: RoomSocket, code: string, message: string, details?: unknown): void {
  const payload: ServerMessage = {
    type: "error",
    code,
    message: details ? `${message}` : message,
    serverTs: Date.now()
  };
  roomSocketHub.send(client, payload);
}

function parseJson(raw: unknown): { ok: true; value: unknown } | { ok: false } {
  try {
    const text = typeof raw === "string"
      ? raw
      : raw instanceof Buffer
        ? raw.toString("utf8")
        : String(raw);

    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}
