import { z } from "zod";

const sequence = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const ticks = z.number().int().min(0).max(7 * 86400 * 10_000_000);
const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
export const activityQueueEntrySchema = z.object({ id: identifier, itemId: z.string().regex(/^[a-fA-F0-9-]{32,36}$/) }).strict();
const queue = z.array(activityQueueEntrySchema).max(500);
const repeatMode = z.enum(["RepeatNone", "RepeatOne", "RepeatAll"]);
const envelope = z.object({ epoch: identifier, id: identifier, sequence: sequence.min(1),
  expectedQueueRevision: sequence, issuedAt: z.number().finite().nonnegative() });
export const activityPlaybackCommandSchema = z.discriminatedUnion("type", [
  envelope.extend({ type: z.literal("setQueue"), queue, index: z.number().int().min(-1).max(499), positionTicks: ticks, paused: z.boolean() }).strict(),
  envelope.extend({ type: z.literal("enqueue"), queue: queue.min(1) }).strict(),
  envelope.extend({ type: z.literal("setPlayback"), paused: z.boolean(), positionTicks: ticks.optional() }).strict(),
  envelope.extend({ type: z.literal("seek"), positionTicks: ticks, paused: z.boolean() }).strict(),
  envelope.extend({ type: z.literal("select"), queueItemId: identifier, positionTicks: ticks, paused: z.boolean() }).strict(),
  envelope.extend({ type: z.literal("setRepeatMode"), repeatMode }).strict(),
  envelope.extend({ type: z.literal("stop") }).strict()
]);
export type ActivityPlaybackCommand = z.infer<typeof activityPlaybackCommandSchema>;
export type ActivityQueueEntry = z.infer<typeof activityQueueEntrySchema>;
export type ActivityPlaybackSnapshot = {
  epoch: string; revision: number; queueRevision: number; queue: ActivityQueueEntry[];
  index: number; positionTicks: number; paused: boolean; serverTimeMs: number;
  repeatMode: z.infer<typeof repeatMode>;
  command?: { id: string; clientId: string; sequence: number };
};
export type ActivityPlaybackAck = { id: string; clientId: string; sequence: number; revision: number; duplicate: boolean };
export type ActivityPlaybackState = { snapshot: ActivityPlaybackSnapshot; clientId: string; sequence: number; ack?: ActivityPlaybackAck };
export type ActivityPlaybackIntent = ActivityPlaybackCommand extends infer C ? C extends ActivityPlaybackCommand
  ? Omit<C, "epoch" | "id" | "sequence" | "expectedQueueRevision" | "issuedAt"> : never : never;
