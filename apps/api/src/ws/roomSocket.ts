import type { Participant, ServerMessage } from "@app/shared/protocol";
import type { AppSession } from "../services/sessionStore.js";

export type WebSocketLike = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: () => void): void;
};

export type RoomSocket = {
  clientId: string;
  instanceId: string;
  session: AppSession;
  username: string;
  avatar?: string | null;
  connectedAt: string;
  socket: WebSocketLike;
};

export class RoomSocketHub {
  private readonly rooms = new Map<string, Map<string, RoomSocket>>();

  add(client: RoomSocket): void {
    const room = this.rooms.get(client.instanceId) ?? new Map<string, RoomSocket>();
    room.set(client.clientId, client);
    this.rooms.set(client.instanceId, room);
  }

  remove(client: Pick<RoomSocket, "instanceId" | "clientId">): void {
    const room = this.rooms.get(client.instanceId);

    if (!room) {
      return;
    }

    room.delete(client.clientId);

    if (room.size === 0) {
      this.rooms.delete(client.instanceId);
    }
  }

  roomSize(instanceId: string): number {
    return this.rooms.get(instanceId)?.size ?? 0;
  }

  activeInstanceIds(): string[] {
    return Array.from(this.rooms.keys());
  }

  participants(instanceId: string, hostDiscordUserId?: string): Participant[] {
    return Array.from(this.rooms.get(instanceId)?.values() ?? []).map((client) => ({
      discordUserId: client.session.discordUserId,
      username: client.username,
      ...(client.avatar !== undefined ? { avatar: client.avatar } : {}),
      isHost: client.session.discordUserId === hostDiscordUserId,
      connectedAt: client.connectedAt
    }));
  }

  send(client: RoomSocket, message: ServerMessage): void {
    if (client.socket.readyState === 1) {
      client.socket.send(JSON.stringify(message));
    }
  }

  broadcast(instanceId: string, message: ServerMessage): void {
    for (const client of this.rooms.get(instanceId)?.values() ?? []) {
      this.send(client, message);
    }
  }

  clear(): void {
    this.rooms.clear();
  }
}

export const roomSocketHub = new RoomSocketHub();
