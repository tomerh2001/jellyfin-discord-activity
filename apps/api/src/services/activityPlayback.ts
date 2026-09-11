import { createHash, randomBytes } from "node:crypto";
import { activityPlaybackCommandSchema, type ActivityPlaybackAck, type ActivityPlaybackCommand, type ActivityPlaybackIntent, type ActivityPlaybackSnapshot, type ActivityPlaybackState } from "@app/shared";
import { NativeError, type NativePartyService, type NativeViewer } from "./nativeParty.js";

type Result = { fingerprint: string; ack?: ActivityPlaybackAck; error?: NativeError };
type Actor = { sequence: number; history: Map<string, Result> };
type State = {
  snapshot: ActivityPlaybackSnapshot; anchor: number; actors: Map<string, Actor>;
  listeners: Map<NativeViewer, (state: ActivityPlaybackState) => void>;
};

/** The sole party timeline. Library/media authorization remains in the native gateway. */
export class ActivityPlaybackCoordinator {
  private readonly states = new Map<string, State>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly mediaPermission = new WeakMap<NativeViewer, number>();

  constructor(private readonly service: NativePartyService, readonly now = Date.now) {}

  private state(viewer: NativeViewer): State {
    const party = this.service.parties.get(viewer.partyId);
    if (!party) throw new NativeError("native_session_expired", 401);
    let state = this.states.get(party.id);
    if (!state) {
      state = { snapshot: { epoch: party.groupId, revision: 0, queueRevision: 0, queue: [], index: -1,
        positionTicks: 0, paused: true, repeatMode: "RepeatNone", serverTimeMs: this.now() }, anchor: this.now(), actors: new Map(), listeners: new Map() };
      this.states.set(party.id, state);
    }
    return state;
  }

  private project(state: State): ActivityPlaybackSnapshot {
    const now = this.now();
    return { ...state.snapshot, queue: state.snapshot.queue.map((entry) => ({ ...entry })), serverTimeMs: now,
      positionTicks: Math.min(7 * 86400 * 10_000_000, Math.round(state.snapshot.positionTicks
        + (state.snapshot.paused ? 0 : Math.max(0, now - state.anchor) * 10_000))) };
  }

  private response(state: State, viewer: NativeViewer, snapshot = this.project(state)): ActivityPlaybackState {
    return { snapshot, clientId: viewer.deviceId, sequence: state.actors.get(viewer.deviceId)?.sequence ?? 0 };
  }

  private async allowed(viewer: NativeViewer): Promise<void> {
    await this.service.authorize(viewer.capability);
    if ((this.mediaPermission.get(viewer) ?? 0) > this.now()) return;
    const user = await this.service.json(viewer, "GET", "/Users/Me") as { Policy?: { EnableMediaPlayback?: boolean } };
    if (user?.Policy?.EnableMediaPlayback === false) throw new NativeError("native_playback_denied");
    this.mediaPermission.set(viewer, this.now() + 30_000);
  }

  async get(viewer: NativeViewer): Promise<ActivityPlaybackState> {
    return this.serial(viewer.partyId, async () => {
      await this.allowed(viewer);
      const state = this.state(viewer);
      await this.service.requireViewerItems(viewer, state.snapshot.queue.map((entry) => entry.itemId));
      await this.service.authorize(viewer.capability);
      return this.response(state, viewer);
    });
  }

  /** Subscribe atomically with queue validation so a joining account cannot miss a queue change. */
  async connect(viewer: NativeViewer, listener: (state: ActivityPlaybackState) => void): Promise<() => void> {
    return this.serial(viewer.partyId, async () => {
      await this.allowed(viewer);
      const state = this.state(viewer);
      await this.service.requireViewerItems(viewer, state.snapshot.queue.map((entry) => entry.itemId));
      await this.service.authorize(viewer.capability);
      if (!viewer.sockets) throw new NativeError("native_socket_required", 409);
      state.listeners.set(viewer, listener);
      viewer.joined = true;
      listener(this.response(state, viewer));
      return () => { if (state.listeners.get(viewer) === listener) state.listeners.delete(viewer); };
    });
  }

  async submit(viewer: NativeViewer, input: unknown): Promise<ActivityPlaybackState> {
    const parsed = activityPlaybackCommandSchema.safeParse(input);
    if (!parsed.success) throw new NativeError("activity_invalid_command", 400);
    return this.serial(viewer.partyId, () => this.apply(viewer, parsed.data, viewer.deviceId));
  }

  /** Discord commands resolve against current state inside the same ordering boundary. */
  async control(viewer: NativeViewer, intent: (snapshot: ActivityPlaybackSnapshot) => ActivityPlaybackIntent): Promise<ActivityPlaybackState> {
    return this.serial(viewer.partyId, async () => {
      await this.allowed(viewer);
      const state = this.state(viewer);
      const clientId = `discord:${viewer.deviceId}`;
      const command = activityPlaybackCommandSchema.parse({ ...intent(this.project(state)), epoch: state.snapshot.epoch,
        id: randomBytes(16).toString("hex"), sequence: (state.actors.get(clientId)?.sequence ?? 0) + 1,
        expectedQueueRevision: state.snapshot.queueRevision, issuedAt: this.now() });
      return this.apply(viewer, command, clientId);
    });
  }

  private async apply(viewer: NativeViewer, command: ActivityPlaybackCommand, clientId: string): Promise<ActivityPlaybackState> {
    await this.allowed(viewer);
    if (!viewer.joined || !viewer.sockets) throw new NativeError("native_player_not_connected", 409);
    const state = this.state(viewer);
    if (command.epoch !== state.snapshot.epoch) throw new NativeError("activity_epoch_changed", 409);
    const actor = state.actors.get(clientId) ?? { sequence: 0, history: new Map<string, Result>() };
    state.actors.set(clientId, actor);
    const fingerprint = createHash("sha256").update(JSON.stringify(command)).digest("hex");
    const previous = actor.history.get(command.id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new NativeError("activity_command_conflict", 409);
      if (previous.error) throw previous.error;
      return { ...this.response(state, viewer), ack: { ...previous.ack!, duplicate: true } };
    }
    if (command.sequence <= actor.sequence) throw new NativeError("activity_stale_sequence", 409);
    actor.sequence = command.sequence;
    const result: Result = { fingerprint };
    actor.history.set(command.id, result);
    if (actor.history.size > 256) actor.history.delete(actor.history.keys().next().value!);
    try {
      if (this.now() - command.issuedAt > 10_000) throw new NativeError("activity_stale_command", 409);
      if (command.expectedQueueRevision !== state.snapshot.queueRevision) throw new NativeError("activity_queue_changed", 409);
      const next = this.project(state);
      let anchor = next.serverTimeMs;
      let queueChanged = false;
      const setTimeline = (positionTicks: number, paused: boolean) => {
        next.positionTicks = positionTicks; next.paused = paused;
        anchor = paused ? this.now() : Math.min(this.now(), Math.max(command.issuedAt, this.now() - 5_000));
      };
      if (command.type === "setQueue") {
        if ((command.queue.length === 0 && (command.index !== -1 || !command.paused))
          || (command.queue.length > 0 && (command.index < 0 || command.index >= command.queue.length))) throw new NativeError("activity_invalid_queue", 400);
        next.queue = command.queue; next.index = command.index;
        setTimeline(command.queue.length ? command.positionTicks : 0, command.paused); queueChanged = true;
      } else if (command.type === "enqueue") {
        next.queue = [...next.queue, ...command.queue];
        if (next.index < 0) { next.index = 0; setTimeline(0, true); }
        queueChanged = true;
      } else if (command.type === "stop") {
        next.queue = []; next.index = -1; setTimeline(0, true); queueChanged = true;
      } else if (command.type === "setRepeatMode") {
        queueChanged = next.repeatMode !== command.repeatMode;
        next.repeatMode = command.repeatMode;
      } else {
        if (!next.queue[next.index]) throw new NativeError("no_playing_item", 409);
        if (command.type === "select") {
          const index = next.queue.findIndex((entry) => entry.id === command.queueItemId);
          if (index < 0) throw new NativeError("activity_queue_changed", 409);
          queueChanged = true; next.index = index;
          setTimeline(command.positionTicks, command.paused);
        } else if (command.type === "seek") setTimeline(command.positionTicks, command.paused);
        else if (command.positionTicks !== undefined) setTimeline(command.positionTicks, command.paused);
        else {
          // Without a sampled client position, preserve the already projected timeline.
          next.paused = command.paused; anchor = this.now();
        }
      }
      if (next.queue.length > 500 || new Set(next.queue.map((entry) => entry.id)).size !== next.queue.length) throw new NativeError("activity_invalid_queue", 400);
      if (queueChanged && next.queue.length) await this.service.requirePartyItems(viewer, next.queue.map((entry) => entry.itemId));
      await this.service.authorize(viewer.capability);
      if (!viewer.joined || !viewer.sockets || this.states.get(viewer.partyId) !== state) throw new NativeError("native_player_not_connected", 409);
      next.revision++; if (queueChanged) next.queueRevision++;
      next.command = { id: command.id, clientId, sequence: command.sequence };
      state.snapshot = next; state.anchor = anchor;
      const party = this.service.parties.get(viewer.partyId)!;
      party.queueItemIds = next.queue.map((entry) => entry.itemId);
      const playingId = next.queue[next.index]?.id;
      if (playingId) party.currentPlaylistItemId = playingId;
      else delete party.currentPlaylistItemId;
      const ack: ActivityPlaybackAck = { ...next.command, revision: next.revision, duplicate: false };
      result.ack = ack;
      const snapshot = this.project(state);
      for (const [member, listener] of state.listeners) {
        if (!this.service.active(member) || !member.sockets) continue;
        try { listener({ ...this.response(state, member, snapshot), ...(member === viewer ? { ack } : {}) }); }
        catch { /* A closed viewer cannot prevent other participants receiving state. */ }
      }
      return { ...this.response(state, viewer, snapshot), ack };
    } catch (error) {
      result.error = error instanceof NativeError ? error : new NativeError("activity_command_failed", 502);
      throw result.error;
    }
  }

  forgetViewer(viewer: NativeViewer): void {
    const state = this.states.get(viewer.partyId);
    state?.listeners.delete(viewer);
    state?.actors.delete(viewer.deviceId);
    state?.actors.delete(`discord:${viewer.deviceId}`);
  }
  destroy(partyId: string): void { this.states.delete(partyId); }

  private async serial<T>(partyId: string, work: () => Promise<T>): Promise<T> {
    const task = (this.pending.get(partyId)?.catch(() => undefined) ?? Promise.resolve()).then(work);
    this.pending.set(partyId, task);
    try { return await task; }
    finally { if (this.pending.get(partyId) === task) this.pending.delete(partyId); }
  }
}
