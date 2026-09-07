import type {
  ClientMessage,
  Participant,
  ServerMessage
} from "@app/shared/protocol";
import { serverMessageSchema } from "@app/shared/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RoomResponse } from "../api/types.js";

export type RemotePlayerEvent = Extract<ServerMessage, { type: "player_event" }> & {
  receivedAt: number;
};

export type RemoteStateUpdate = Extract<ServerMessage, { type: "state_update" }> & {
  receivedAt: number;
};

export type RoomSync = {
  status: "disabled" | "connecting" | "connected" | "disconnected" | "error";
  error: string | undefined;
  room: RoomResponse["room"] | undefined;
  participants: Participant[];
  clockOffsetMs: number;
  remotePlayerEvent: RemotePlayerEvent | undefined;
  remoteStateUpdate: RemoteStateUpdate | undefined;
  claimHost: () => boolean;
  selectMedia: (input: {
    itemId: string;
    mediaSourceId?: string;
    title: string;
    runtimeTicks?: number;
    audioStreamIndex?: number;
    subtitleStreamIndex?: number;
  }) => boolean;
  sendPlayerEvent: (input: {
    action: "play" | "pause" | "seek" | "buffering" | "ended";
    positionSeconds: number;
  }) => boolean;
  sendStateUpdate: (input: {
    playState: "playing" | "paused" | "buffering";
    positionSeconds: number;
  }) => boolean;
};

type UseRoomSyncInput = {
  appToken: string | undefined;
  instanceId: string;
  guildId: string | undefined;
  channelId: string | undefined;
  publicWsUrl: string;
};

type OutboundClientMessage = ClientMessage extends infer Message
  ? Message extends { ts: number }
    ? Omit<Message, "ts">
    : never
  : never;

export function useRoomSync(input: UseRoomSyncInput): RoomSync {
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const reconnectTimerRef = useRef<number | undefined>(undefined);
  const reconnectAttemptRef = useRef(0);
  const mountedRef = useRef(false);
  const [status, setStatus] = useState<RoomSync["status"]>("disabled");
  const [error, setError] = useState<string | undefined>();
  const [room, setRoom] = useState<RoomResponse["room"] | undefined>();
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [remotePlayerEvent, setRemotePlayerEvent] = useState<RemotePlayerEvent | undefined>();
  const [remoteStateUpdate, setRemoteStateUpdate] = useState<RemoteStateUpdate | undefined>();

  const send = useCallback((message: OutboundClientMessage): boolean => {
    const socket = socketRef.current;

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    socket.send(JSON.stringify({
      ...message,
      ts: Date.now()
    }));
    return true;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!input.appToken) {
      setStatus("disabled");
      setParticipants([]);
      setRoom(undefined);
      setRemotePlayerEvent(undefined);
      setRemoteStateUpdate(undefined);
      return;
    }

    let cancelled = false;
    let awaitingSnapshot = true;
    const connect = () => {
      awaitingSnapshot = true;
      setStatus("connecting");
      setError(undefined);

      const url = roomWebSocketUrl({
        publicWsUrl: input.publicWsUrl,
        token: input.appToken ?? "",
        instanceId: input.instanceId
      });

      const socket = new WebSocket(url);
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        if (cancelled || socketRef.current !== socket) {
          return;
        }

        reconnectAttemptRef.current = 0;
        setStatus("connected");
        send({
          type: "hello",
          instanceId: input.instanceId,
          ...(input.guildId ? { guildId: input.guildId } : {}),
          ...(input.channelId ? { channelId: input.channelId } : {})
        });
      });

      socket.addEventListener("message", (event) => {
        if (!cancelled && socketRef.current === socket) handleServerMessage(event.data);
      });

      socket.addEventListener("close", () => {
        if (cancelled || socketRef.current !== socket) {
          return;
        }

        setStatus("disconnected");
        scheduleReconnect(connect);
      });

      socket.addEventListener("error", () => {
        if (cancelled || socketRef.current !== socket) {
          return;
        }

        setStatus("error");
        setError("Room sync connection failed.");
      });
    };

    const handleServerMessage = (raw: unknown) => {
      const payload = parseServerPayload(raw);

      if (payload === undefined) {
        return;
      }

      const parsed = serverMessageSchema.safeParse(payload);

      if (!parsed.success) {
        return;
      }

      const message = parsed.data;

      switch (message.type) {
        case "room_state":
          setError(undefined);
          setRoom(message.room);
          if (awaitingSnapshot) {
            awaitingSnapshot = false;
            setRemoteStateUpdate(undefined);
            setRemotePlayerEvent(message.room.itemId ? {
              type: "player_event",
              action: message.room.playState === "playing" ? "play" : "seek",
              positionSeconds: message.room.positionSeconds + (message.room.playState === "playing"
                ? Math.max(0, (message.serverTs - Date.parse(message.room.updatedAt)) / 1000) : 0),
              targetServerTs: message.serverTs,
              serverTs: message.serverTs,
              receivedAt: Date.now()
            } : undefined);
          }
          return;
        case "participants_update":
          setError(undefined);
          setParticipants(message.participants);
          return;
        case "media_selected":
          setRemotePlayerEvent(undefined);
          setRemoteStateUpdate(undefined);
          setRoom((current) => {
            if (!current) return current;
            const {
              mediaSourceId: _mediaSourceId,
              runtimeTicks: _runtimeTicks,
              audioStreamIndex: _audioStreamIndex,
              subtitleStreamIndex: _subtitleStreamIndex,
              ...base
            } = current;
            return {
              ...base,
              itemId: message.itemId,
              ...(message.mediaSourceId ? { mediaSourceId: message.mediaSourceId } : {}),
              title: message.title,
              ...(message.runtimeTicks ? { runtimeTicks: message.runtimeTicks } : {}),
              ...(message.audioStreamIndex !== undefined ? { audioStreamIndex: message.audioStreamIndex } : {}),
              ...(message.subtitleStreamIndex !== undefined ? { subtitleStreamIndex: message.subtitleStreamIndex } : {}),
              playState: "loading",
              positionSeconds: 0,
              updatedAt: new Date(message.serverTs).toISOString()
            };
          });
          return;
        case "player_event":
          setRemotePlayerEvent({
            ...message,
            receivedAt: Date.now()
          });
          return;
        case "state_update":
          setRemoteStateUpdate({
            ...message,
            receivedAt: Date.now()
          });
          return;
        case "pong": {
          const now = Date.now();
          const midpoint = message.clientTs + ((now - message.clientTs) / 2);
          setClockOffsetMs(message.serverTs - midpoint);
          return;
        }
        case "error":
          setError(message.message);
          return;
        case "hello_ack":
        case "host_changed":
          return;
      }
    };

    const scheduleReconnect = (nextConnect: () => void) => {
      if (!mountedRef.current || cancelled) {
        return;
      }

      const attempt = reconnectAttemptRef.current;
      reconnectAttemptRef.current += 1;
      const delay = Math.min(1000 * 2 ** attempt, 10_000);
      reconnectTimerRef.current = window.setTimeout(nextConnect, delay);
    };

    connect();

    const pingInterval = window.setInterval(() => {
      send({
        type: "ping",
        clientTs: Date.now()
      });
    }, 10_000);

    return () => {
      cancelled = true;
      window.clearInterval(pingInterval);

      if (reconnectTimerRef.current !== undefined) {
        window.clearTimeout(reconnectTimerRef.current);
      }

      socketRef.current?.close(1000, "component unmounted");
      socketRef.current = undefined;
    };
  }, [input.appToken, input.channelId, input.guildId, input.instanceId, input.publicWsUrl, send]);

  return {
    status,
    error,
    room,
    participants,
    clockOffsetMs,
    remotePlayerEvent,
    remoteStateUpdate,
    claimHost: useCallback(() => send({ type: "claim_host" }), [send]),
    selectMedia: useCallback((media) => send({
      type: "select_media",
      itemId: media.itemId,
      title: media.title,
      ...(media.mediaSourceId ? { mediaSourceId: media.mediaSourceId } : {}),
      ...(media.runtimeTicks ? { runtimeTicks: media.runtimeTicks } : {}),
      ...(media.audioStreamIndex !== undefined ? { audioStreamIndex: media.audioStreamIndex } : {}),
      ...(media.subtitleStreamIndex !== undefined ? { subtitleStreamIndex: media.subtitleStreamIndex } : {})
    }), [send]),
    sendPlayerEvent: useCallback((event) => send({
      type: "player_event",
      action: event.action,
      positionSeconds: event.positionSeconds
    }), [send]),
    sendStateUpdate: useCallback((state) => send({
      type: "state_update",
      playState: state.playState,
      positionSeconds: state.positionSeconds
    }), [send])
  };
}

export function roomWebSocketUrl(input: {
  publicWsUrl: string;
  token: string;
  instanceId: string;
  pageHref?: string;
}): string {
  const pageUrl = new URL(input.pageHref ?? window.location.href);
  const configured = new URL(input.publicWsUrl, pageUrl);
  const pageProtocol = pageUrl.protocol === "https:" ? "wss:" : "ws:";
  const resolved = new URL(configured.pathname, `${pageProtocol}//${pageUrl.host}`);

  for (const [key, value] of configured.searchParams) {
    resolved.searchParams.set(key, value);
  }

  resolved.searchParams.set("token", input.token);
  resolved.searchParams.set("instanceId", input.instanceId);

  return resolved.toString();
}

function parseServerPayload(raw: unknown): unknown {
  try {
    return JSON.parse(String(raw)) as unknown;
  } catch {
    return undefined;
  }
}
