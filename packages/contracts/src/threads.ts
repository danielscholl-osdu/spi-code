// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { PROTOCOL_VERSION } from "./watch/messages.js";

const id = z.string().min(1);
const sequence = z.int().nonnegative();
const threadId = z.object({ threadId: id });
const definition = z.strictObject({ scope: id, title: z.string().optional() });
export const ReasoningEffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
const message = z.strictObject({
  prompt: z.string().trim().min(1),
  attachments: z.array(z.strictObject({ name: id, content: z.string() })).optional(),
  model: id.optional(),
  reasoningEffort: ReasoningEffortSchema.optional(),
});
const outcome = z.enum(["completed", "failed", "stopped", "cancelled"]);
const interruption = z.enum(["restart", "shutdown"]);
const cancellation = z.enum(["restart", "shutdown", "operator", "turn-ended", "refused-tool"]);
const unknown = z.literal("not known");

const summary = z.strictObject({
  id,
  thread: definition,
  status: z.enum(["Waiting on you", "Working", "Settled"]),
  sequence,
  updatedAt: sequence,
});

const event = { threadId: id, sequence: z.int().positive(), at: sequence };
const turn = { ...event, turnId: id };
export const ThreadEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...event, type: z.literal("thread.created"), thread: definition }),
  z.strictObject({ ...event, type: z.literal("message.sent"), messageId: id, message }),
  z.strictObject({
    ...event,
    type: z.literal("message.cancelled"),
    messageId: id,
    reason: interruption,
  }),
  z.strictObject({ ...turn, type: z.literal("turn.started"), messageId: id }),
  z.strictObject({ ...turn, type: z.literal("assistant.delta"), text: z.string() }),
  z.strictObject({
    ...turn,
    type: z.literal("tool.started"),
    callId: id,
    name: z.string(),
    kind: z.enum(["command", "tool"]),
    arguments: z.json(),
  }),
  z.strictObject({
    ...turn,
    type: z.literal("tool.finished"),
    callId: id,
    outcome: z.enum(["completed", "failed"]),
    result: z.json(),
    resultBytes: sequence,
    durationMs: sequence,
  }),
  z.strictObject({
    ...turn,
    type: z.literal("tool.cancelled"),
    callId: id,
    reason: cancellation,
    durationMs: sequence,
    processState: unknown.optional(),
    effectState: unknown.optional(),
  }),
  z.strictObject({
    ...turn,
    type: z.literal("approval.requested"),
    approvalId: id,
    kind: z.string(),
    detail: z.string(),
  }),
  z.strictObject({
    ...turn,
    type: z.literal("approval.resolved"),
    approvalId: id,
    approved: z.boolean(),
  }),
  z.strictObject({
    ...turn,
    type: z.literal("approval.cancelled"),
    approvalId: id,
    reason: cancellation,
  }),
  z.strictObject({
    ...turn,
    type: z.literal("turn.finished"),
    outcome,
    reason: cancellation.optional(),
    failure: z.string().max(500).optional(),
    partialTextSeen: unknown.optional(),
  }),
]);

export type ThreadWireEvent = z.infer<typeof ThreadEventSchema>;

function envelope<
  T extends string,
  K extends "request" | "response" | "event",
  P extends z.ZodType,
>(type: T, kind: K, payload: P) {
  return z.strictObject({
    version: z.literal(PROTOCOL_VERSION),
    id,
    type: z.literal(type),
    kind: z.literal(kind),
    payload,
  });
}

export const ThreadMessageSchema = z.discriminatedUnion("type", [
  envelope("threads.list", "request", z.strictObject({})),
  envelope("threads.result", "response", z.strictObject({ threads: z.array(summary) })),
  envelope("thread.start", "request", definition),
  envelope("thread.started", "response", threadId.strict()),
  envelope("thread.send", "request", threadId.extend({ message }).strict()),
  envelope("thread.sent", "response", threadId.extend({ outcome }).strict()),
  envelope("thread.stop", "request", threadId.strict()),
  envelope("thread.stopped", "response", threadId.strict()),
  envelope("thread.subscribe", "request", threadId.extend({ fromSequence: sequence }).strict()),
  envelope(
    "thread.events",
    "event",
    threadId.extend({ events: z.array(ThreadEventSchema) }).strict(),
  ),
]);

export const ModelCatalogSchema = z.strictObject({
  models: z.array(
    z.strictObject({
      id,
      name: id,
      multiplier: z.union([z.number().nonnegative(), unknown]).optional(),
      reasoning: z
        .strictObject({
          supported: z.union([z.boolean(), unknown]),
          levels: z.union([z.array(id), unknown]),
          defaultLevel: z.union([id, unknown]),
        })
        .optional(),
      policy: z
        .strictObject({
          state: z.enum(["enabled", "disabled", "unconfigured", "not known"]),
          reason: z.union([id, unknown]),
        })
        .optional(),
    }),
  ),
  account: z.union([z.strictObject({ login: id }), unknown]).optional(),
  usage: z
    .union([
      z.strictObject({
        used: z.union([z.number().nonnegative(), unknown]),
        entitlement: z.union([z.number().nonnegative(), z.literal("unlimited"), unknown]),
        resetAt: z.union([z.iso.datetime({ offset: true }), unknown]),
      }),
      unknown,
    ])
    .optional(),
});
export type ModelCatalogResult = z.infer<typeof ModelCatalogSchema>;
