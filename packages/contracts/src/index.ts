// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { PROTOCOL_VERSION, WatchMessageSchema } from "./watch/messages.js";

export * from "./watch/index.js";

const identifier = z.string().min(1);
const envelope = {
  version: z.literal(PROTOCOL_VERSION),
  // Responses and turn events reuse the originating request's id.
  id: identifier,
};

export const MessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...envelope,
    kind: z.literal("event"),
    type: z.literal("signin.state"),
    payload: z
      .strictObject({ signedIn: z.boolean(), mode: z.enum(["gh", "stub"]) })
      .refine(({ signedIn, mode }) => mode !== "stub" || !signedIn, {
        message: "Stub mode cannot claim gh sign-in",
      }),
  }),
  z.strictObject({
    ...envelope,
    kind: z.literal("event"),
    type: z.literal("session.ended"),
    payload: z.strictObject({ reason: z.enum(["credential_changed", "authentication_failed"]) }),
  }),
  z.strictObject({
    ...envelope,
    kind: z.literal("event"),
    type: z.literal("host.hello"),
    payload: z.strictObject({ pid: z.number().int().positive() }),
  }),
  z.strictObject({
    ...envelope,
    kind: z.literal("request"),
    type: z.literal("ping"),
    payload: z.strictObject({}),
  }),
  z.strictObject({
    ...envelope,
    kind: z.literal("response"),
    type: z.literal("pong"),
    payload: z.strictObject({}),
  }),
  z.strictObject({
    ...envelope,
    kind: z.literal("request"),
    type: z.literal("models.list"),
    payload: z.strictObject({}),
  }),
  z.strictObject({
    ...envelope,
    kind: z.literal("response"),
    type: z.literal("models.result"),
    payload: z.strictObject({
      models: z.array(z.strictObject({ id: identifier, name: identifier })),
    }),
  }),
  z.strictObject({
    ...envelope,
    kind: z.literal("request"),
    type: z.literal("turn.start"),
    payload: z.strictObject({ modelId: identifier, prompt: identifier }),
  }),
  z.strictObject({
    ...envelope,
    kind: z.literal("event"),
    type: z.literal("turn.delta"),
    payload: z.strictObject({ text: z.string() }),
  }),
  z.strictObject({
    ...envelope,
    kind: z.literal("event"),
    type: z.literal("turn.end"),
    payload: z.strictObject({
      reason: z.enum(["completed", "cancelled", "error"]),
    }),
  }),
  z.strictObject({
    ...envelope,
    kind: z.literal("event"),
    type: z.literal("tool.call"),
    payload: z.strictObject({
      callId: identifier,
      name: identifier,
      arguments: z.record(z.string(), z.json()),
      outcome: z.enum(["completed", "refused", "error"]).optional(),
    }),
  }),
  z.strictObject({
    ...envelope,
    kind: z.literal("response"),
    type: z.literal("error"),
    payload: z.strictObject({ code: identifier, message: identifier }),
  }),
  ...WatchMessageSchema.options,
]);

export type Message = z.infer<typeof MessageSchema>;

export type MessageRejection = {
  reason: "invalid_message";
  issues: {
    code: string;
    path: (string | number)[];
    message: string;
  }[];
};

export type ParseMessageResult =
  | { ok: true; message: Message }
  | { ok: false; rejection: MessageRejection };

export function parseMessage(input: unknown): ParseMessageResult {
  const result = MessageSchema.safeParse(input);
  if (result.success) {
    return { ok: true, message: result.data };
  }
  return {
    ok: false,
    rejection: {
      reason: "invalid_message",
      issues: result.error.issues.map((issue) => ({
        code: issue.code,
        path: issue.path.map((part) => (typeof part === "number" ? part : String(part))),
        message: issue.message,
      })),
    },
  };
}
