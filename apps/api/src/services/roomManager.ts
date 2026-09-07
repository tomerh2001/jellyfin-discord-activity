import { roomStateSchema, type ClaimHostRequest, type PlayState, type RoomResponse, type SelectMediaRequest } from "@app/shared";

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export type ManagedRoom = RoomResponse["room"];

export class RoomManager {
  private readonly rooms = new Map<string, ManagedRoom>();
  private persistencePath?: string;
  private persistenceTimer: ReturnType<typeof setTimeout> | undefined;

  configurePersistence(databaseUrl: string): void {
    const databasePath = databaseUrl.startsWith("file:") ? databaseUrl.slice(5) : databaseUrl;
    const nextPath = path.join(path.dirname(databasePath), "rooms.json");
    if (this.persistencePath === nextPath) return;
    this.flushPersistence();
    this.rooms.clear();
    this.persistencePath = nextPath;
    if (!existsSync(nextPath)) return;
    const snapshots = roomStateSchema.array().parse(JSON.parse(readFileSync(nextPath, "utf8")));
    for (const snapshot of snapshots) {
      // Live sessions and host ownership never survive a process restart.
      const { hostDiscordUserId: _host, ...room } = snapshot;
      this.rooms.set(room.instanceId, {
        ...room,
        playState: room.itemId ? "paused" : "idle"
      });
    }
  }

  flushPersistence(): void {
    if (this.persistenceTimer) clearTimeout(this.persistenceTimer);
    this.persistenceTimer = undefined;
    if (!this.persistencePath) return;
    mkdirSync(path.dirname(this.persistencePath), { recursive: true });
    const temporaryPath = `${this.persistencePath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify([...this.rooms.values()])}\n`, { mode: 0o600 });
    renameSync(temporaryPath, this.persistencePath);
  }

  private persistSoon(): void {
    if (!this.persistencePath || this.persistenceTimer) return;
    this.persistenceTimer = setTimeout(() => {
      try { this.flushPersistence(); }
      catch { process.emitWarning("Unable to persist watch-party room snapshots; check the data mount."); }
    }, 1000);
    this.persistenceTimer.unref();
  }

  get(instanceId: string): ManagedRoom | undefined {
    return this.rooms.get(instanceId);
  }

  findByChannel(guildId: string, channelId: string): ManagedRoom | undefined {
    return [...this.rooms.values()]
      .filter((room) => room.guildId === guildId && room.channelId === channelId)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
  }

  /** Called with unique, live participants in connection order. */
  reconcileHost(instanceId: string, connectedUserIds: string[]): ManagedRoom | undefined {
    const room = this.rooms.get(instanceId);
    if (!room || (room.hostDiscordUserId && connectedUserIds.includes(room.hostDiscordUserId))) return room;
    const host = connectedUserIds[0];
    if (!room.hostDiscordUserId && !host) return room;
    const { hostDiscordUserId: _previousHost, ...base } = room;
    const next: ManagedRoom = {
      ...base,
      ...(host ? { hostDiscordUserId: host } : {}),
      ...(room.playState === "playing" ? {
        playState: host ? "playing" as const : "paused" as const,
        positionSeconds: Math.min(
          room.runtimeTicks ? room.runtimeTicks / 10_000_000 : Number.POSITIVE_INFINITY,
          room.positionSeconds + Math.max(0, (Date.now() - Date.parse(room.updatedAt)) / 1000)
        )
      } : {}),
      updatedAt: new Date().toISOString()
    };
    this.rooms.set(instanceId, next);
    this.persistSoon();
    return next;
  }

  get size(): number {
    return this.rooms.size;
  }

  has(instanceId: string): boolean {
    return this.rooms.has(instanceId);
  }

  getOrCreate(instanceId: string, input?: Partial<Pick<ManagedRoom, "guildId" | "channelId">>): ManagedRoom {
    const existing = this.rooms.get(instanceId);

    if (existing) {
      if ((input?.guildId !== undefined && existing.guildId !== input.guildId)
        || (input?.channelId !== undefined && existing.channelId !== input.channelId)) {
        throw new RoomError("room_context_mismatch", "Room does not belong to that Discord channel.");
      }
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
    this.persistSoon();
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
    this.persistSoon();
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
    this.persistSoon();
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
    this.persistSoon();
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

    if (removed.length) this.persistSoon();
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
