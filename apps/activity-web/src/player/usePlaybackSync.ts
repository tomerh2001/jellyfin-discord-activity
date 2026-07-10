import type {
  RemotePlayerEvent,
  RemoteStateUpdate,
  RoomSync
} from "../room/RoomProvider.js";

export type {
  RemotePlayerEvent,
  RemoteStateUpdate
};

export type SyncStatus = RoomSync["status"];

export type DriftCorrection =
  | { type: "none" }
  | { type: "rate"; rate: number }
  | { type: "seek" };

const hardSeekThresholdSeconds = 2.0;
const softDriftThresholdSeconds = 0.08;

export function calculateDriftSeconds(localSeconds: number, remoteSeconds: number): number {
  return remoteSeconds - localSeconds;
}

export function correctionForDrift(localSeconds: number, remoteSeconds: number): DriftCorrection {
  const drift = calculateDriftSeconds(localSeconds, remoteSeconds);
  const magnitude = Math.abs(drift);

  if (magnitude >= hardSeekThresholdSeconds) {
    return { type: "seek" };
  }

  if (magnitude >= softDriftThresholdSeconds) {
    return {
      type: "rate",
      rate: drift > 0 ? 1.05 : 0.95
    };
  }

  return { type: "none" };
}
