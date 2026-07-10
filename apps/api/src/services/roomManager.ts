import type { ClaimHostRequest, PlayState, RoomResponse, SelectMediaRequest } from "@app/shared";

export type ManagedRoom = RoomResponse["room"];

export class RoomManager {
  private readonly rooms = new Map<string, ManagedRoom>();

  get size(): number {
    return this.rooms.size;
  }

  has(instanceId: string): boolean {
    return this.rooms.has(instanceId);
  }

  getOrCreate(instanceId: string, input?: Partial<Pick<ManagedRoom, "guildId" | "channelId">>): ManagedRoom {
    const existing = this.rooms.get(instanceId);

    if (existing) {
      return existing;
    }

    const room: ManagedRoom = {
      instanceId,
      ...(input?.guildId ? { guildId: input.guildId } : {}),
      ...(input?.channelId ? { channelId: input.channelId } : {}),
      playState: "idle",
      positionSeconds: 0,
      updatedAt: new Date().toISOString()
    };

    this.rooms.set(instanceId, room);
    return room;
  }

  claimHost(input: ClaimHostRequest, discordUserId: string): ManagedRoom {
    const room = this.getOrCreate(input.instanceId, {
      ...(input.guildId ? { guildId: input.guildId } : {}),
      ...(input.channelId ? { channelId: input.channelId } : {})
    });

    if (room.hostDiscordUserId && room.hostDiscordUserId !== discordUserId) {
      throw new RoomError("room_host_exists", "Another participant is already host.");
    }

    const next: ManagedRoom = {
      ...room,
      ...(input.guildId ? { guildId: input.guildId } : {}),
      ...(input.channelId ? { channelId: input.channelId } : {}),
      hostDiscordUserId: discordUserId,
      updatedAt: new Date().toISOString()
    };

    this.rooms.set(input.instanceId, next);
    return next;
  }

  selectMedia(input: SelectMediaRequest, discordUserId: string): ManagedRoom {
    const room = this.getOrCreate(input.instanceId);

    if (room.hostDiscordUserId !== discordUserId) {
      throw new RoomError("not_room_host", "Only the host can select media.");
    }

    const {
      itemId: _previousItemId,
      mediaSourceId: _previousMediaSourceId,
      title: _previousTitle,
      runtimeTicks: _previousRuntimeTicks,
      audioStreamIndex: _previousAudioStreamIndex,
      subtitleStreamIndex: _previousSubtitleStreamIndex,
      ...roomBase
    } = room;
    const next: ManagedRoom = {
      ...roomBase,
      itemId: input.itemId,
      ...(input.mediaSourceId ? { mediaSourceId: input.mediaSourceId } : {}),
      title: input.title,
      ...(input.runtimeTicks ? { runtimeTicks: input.runtimeTicks } : {}),
      ...(input.audioStreamIndex !== undefined ? { audioStreamIndex: input.audioStreamIndex } : {}),
      ...(input.subtitleStreamIndex !== undefined ? { subtitleStreamIndex: input.subtitleStreamIndex } : {}),
      playState: "loading",
      positionSeconds: 0,
      updatedAt: new Date().toISOString()
    };

    this.rooms.set(input.instanceId, next);
    return next;
  }

  updatePlaybackState(input: {
    instanceId: string;
    discordUserId: string;
    playState: Extract<PlayState, "playing" | "paused" | "buffering" | "ended">;
    positionSeconds: number;
  }): ManagedRoom {
    const room = this.getOrCreate(input.instanceId);

    if (room.hostDiscordUserId !== input.discordUserId) {
      throw new RoomError("not_room_host", "Only the host can update playback state.");
    }

    const next: ManagedRoom = {
      ...room,
      playState: input.playState,
      positionSeconds: input.positionSeconds,
      updatedAt: new Date().toISOString()
    };

    this.rooms.set(input.instanceId, next);
    return next;
  }

  cleanupIdle(input: {
    idleTtlSeconds: number;
    activeInstanceIds?: Iterable<string>;
    now?: Date;
  }): string[] {
    const now = input.now ?? new Date();
    const active = new Set(input.activeInstanceIds ?? []);
    const removed: string[] = [];

    for (const [instanceId, room] of this.rooms) {
      if (active.has(instanceId)) {
        continue;
      }

      const updatedAt = Date.parse(room.updatedAt);

      if (Number.isNaN(updatedAt)) {
        continue;
      }

      if (now.getTime() - updatedAt >= input.idleTtlSeconds * 1000) {
        this.rooms.delete(instanceId);
        removed.push(instanceId);
      }
    }

    return removed;
  }
}

export class RoomError extends Error {
  constructor(
    readonly code: string,
    readonly publicMessage: string
  ) {
    super(code);
  }
}

export const roomManager = new RoomManager();
