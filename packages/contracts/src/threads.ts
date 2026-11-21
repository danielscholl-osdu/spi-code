// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { PROTOCOL_VERSION } from "./watch/messages.js";

const id = z.string().min(1);
const sequence = z.int().nonnegative();
const sha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const threadId = z.object({ threadId: id });
const landingTarget = z.enum(["fork-main", "fork-integration", "upstream"]);
const landingRequest = z.discriminatedUnion("target", [
  z.strictObject({ target: z.literal("asking") }),
  z.strictObject({ target: landingTarget }),
  z.strictObject({
    target: z.literal("request"),
    forge: z.enum(["github", "gitlab"]),
    repository: id,
    requestNumber: z.int().positive(),
    branch: id,
    head: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u),
  }),
]);
const landing = z.discriminatedUnion("target", [
  z.strictObject({ target: z.literal("asking") }),
  z.strictObject({
    target: landingTarget,
    branch: id,
    baseRef: id,
    worktree: id,
    head: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u),
  }),
  z.strictObject({
    target: z.literal("request"),
    branch: id,
    baseRef: id,
    worktree: id,
    head: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u),
    forge: z.enum(["github", "gitlab"]),
    repository: id,
    requestNumber: z.int().positive(),
    sourceBranch: id,
  }),
]);
const threadRequest = z.strictObject({
  forge: z.enum(["github", "gitlab"]),
  repository: id,
  requestNumber: z.int().positive(),
  url: z.url({ protocol: /^https$/ }),
});
/** `subject`: the id of the row or popover the thread started from, which it then owns. */
const identity = {
  scope: id,
  title: z.string().optional(),
  subject: id.optional(),
  /** The thread this one continues, whose finding its first message carries. */
  parent: id.optional(),
  accessMode: z.enum(["supervised", "auto-accept-edits"]).optional(),
};
const definition = z.strictObject({
  ...identity,
  landsIn: landing.optional(),
  request: threadRequest.optional(),
  pushedHead: sha.optional(),
});
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
  status: z.enum(["Waiting on you", "Working", "Open", "Settled", "Can't be read"]),
  sequence,
  updatedAt: sequence,
  settledAt: sequence.nullable(),
  done: z.boolean(),
});

const event = { threadId: id, sequence: z.int().positive(), at: sequence };
const turn = { ...event, turnId: id };
export const ThreadEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...event, type: z.literal("thread.created"), thread: definition }),
  z.strictObject({
    ...event,
    type: z.literal("thread.settled"),
    reason: z.enum(["operator", "inactivity"]),
    settledAt: sequence,
    held: z.boolean().optional(),
  }),
  z.strictObject({
    ...event,
    type: z.literal("thread.pushed"),
    head: sha,
    request: threadRequest.optional(),
  }),
  z.strictObject({
    ...event,
    type: z.literal("thread.unsettled"),
    reason: z.literal("operator"),
    restore: z.literal(true).optional(),
  }),
  z.strictObject({ ...event, type: z.literal("thread.seen"), seenSequence: sequence }),
  z.strictObject({
    ...event,
    type: z.literal("thread.landed"),
    landsIn: landing,
    request: threadRequest.optional(),
  }),
  z.strictObject({ ...event, type: z.literal("thread.deleted") }),
  z.strictObject({ ...event, type: z.literal("message.sent"), messageId: id, message }),
  z.strictObject({
    ...event,
    type: z.literal("message.cancelled"),
    messageId: id,
    reason: interruption,
  }),
  z.strictObject({ ...turn, type: z.literal("turn.started"), messageId: id }),
  z.strictObject({
    ...turn,
    type: z.literal("workspace.started"),
    operation: z.enum(["clone", "fetch"]),
  }),
  z.strictObject({ ...turn, type: z.literal("workspace.finished") }),
  z.strictObject({ ...turn, type: z.literal("assistant.thinking") }),
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
    path: id.optional(),
    diff: z.string().optional(),
    reason: z.string().optional(),
    asked: z.boolean().optional(),
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

const count = z.int().nonnegative().nullable();
const pathOwner = z.enum(["fork", "upstream"]);
const changes = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("asking") }),
  z.strictObject({
    state: z.literal("read"),
    head: sha,
    ahead: z.int().nonnegative(),
    uncommitted: z.boolean(),
    files: z.array(
      z.strictObject({
        path: id,
        added: count,
        removed: count,
        untracked: z.boolean(),
        owner: pathOwner.optional(),
      }),
    ),
  }),
  z.strictObject({ state: z.literal("not read"), reason: id }),
]);
const diff = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("read"), patch: z.string(), truncated: z.boolean() }),
  z.strictObject({ state: z.literal("not read"), reason: id }),
]);
const commit = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("committed"), head: sha }),
  z.strictObject({ outcome: z.enum(["refused", "failed"]), reason: id }),
  z.strictObject({ outcome: unknown, reason: id }),
]);
const publication = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("asking") }),
  z.strictObject({
    state: z.literal("ready"),
    remote: id,
    branch: id,
    base: id.optional(),
    opens: z.enum(["pull-request", "merge-request", "none"]),
    request: threadRequest.optional(),
  }),
  z.strictObject({
    state: z.literal("unavailable"),
    reason: id,
    url: z.url({ protocol: /^https$/ }).optional(),
  }),
  z.strictObject({ state: z.literal("not read"), reason: id }),
]);
const publicationOutcome = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("pushed"), head: sha, request: threadRequest.optional() }),
  z.strictObject({
    outcome: z.literal("published"),
    head: sha,
    request: threadRequest,
  }),
  z.strictObject({ outcome: z.enum(["refused", "failed"]), reason: id }),
  z.strictObject({ outcome: unknown, reason: id }),
]);

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
  envelope(
    "thread.start",
    "request",
    z.strictObject({ ...identity, landsIn: landingRequest.optional() }),
  ),
  envelope(
    "thread.started",
    "response",
    threadId.extend({ landsIn: landing, thread: summary, notice: id.optional() }).strict(),
  ),
  envelope("thread.land", "request", threadId.extend({ landsIn: landingRequest }).strict()),
  envelope("thread.landed", "response", threadId.extend({ landsIn: landing }).strict()),
  envelope("thread.delete", "request", threadId.strict()),
  envelope(
    "thread.deleted",
    "response",
    threadId
      .extend({
        deleted: z.boolean(),
        worktree: z.enum(["removed", "kept"]).optional(),
        reason: id.optional(),
      })
      .strict(),
  ),
  envelope("thread.worktrees", "request", z.strictObject({})),
  envelope(
    "thread.worktrees.result",
    "response",
    z.strictObject({
      worktrees: z.array(
        z.strictObject({
          threadId: id,
          repository: id,
          branch: id,
          path: id,
          reason: id,
        }),
      ),
    }),
  ),
  envelope("thread.send", "request", threadId.extend({ message }).strict()),
  envelope("thread.sent", "response", threadId.extend({ outcome }).strict()),
  envelope(
    "thread.approval",
    "request",
    threadId.extend({ turnId: id, approvalId: id, approved: z.boolean() }).strict(),
  ),
  envelope(
    "thread.approval.result",
    "response",
    threadId.extend({ approvalId: id, decided: z.boolean() }).strict(),
  ),
  envelope("thread.changes", "request", threadId.strict()),
  envelope("thread.changes.result", "response", threadId.extend({ changes }).strict()),
  envelope("thread.diff", "request", threadId.extend({ path: id }).strict()),
  envelope("thread.diff.result", "response", threadId.extend({ path: id, diff }).strict()),
  envelope(
    "thread.commit",
    "request",
    threadId.extend({ message: z.string().trim().min(1).max(10_000) }).strict(),
  ),
  envelope("thread.committed", "response", threadId.extend({ commit }).strict()),
  envelope("thread.publication", "request", threadId.strict()),
  envelope("thread.publication.result", "response", threadId.extend({ publication }).strict()),
  envelope("thread.publish", "request", threadId.extend({ head: sha }).strict()),
  envelope(
    "thread.published",
    "response",
    threadId.extend({ publication: publicationOutcome }).strict(),
  ),
  envelope("thread.stop", "request", threadId.strict()),
  envelope("thread.stopped", "response", threadId.strict()),
  envelope("thread.settle", "request", threadId.strict()),
  envelope("thread.settled", "response", threadId.strict()),
  envelope(
    "thread.unsettle",
    "request",
    threadId.extend({ restore: z.literal(true).optional() }).strict(),
  ),
  envelope("thread.unsettled", "response", threadId.strict()),
  envelope("thread.seen", "request", threadId.extend({ sequence }).strict()),
  envelope("thread.seen.result", "response", threadId.strict()),
  envelope("thread.chip", "request", z.strictObject({ id })),
  envelope(
    "thread.chip.result",
    "response",
    z.discriminatedUnion("ok", [
      z.strictObject({
        ok: z.literal(true),
        id,
        sweptAt: id,
        trimmed: z.boolean(),
        bytes: sequence,
        attachment: z.strictObject({ name: id, content: z.string() }),
      }),
      z.strictObject({ ok: z.literal(false), id, reason: id }),
    ]),
  ),
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
