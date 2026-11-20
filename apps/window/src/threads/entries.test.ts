// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ThreadWireEvent } from "@spi-code/contracts";
import { expect, it } from "vitest";
import { threadEntries } from "./entries.js";
import type { ModelOption } from "./types.js";

const models: ModelOption[] = [
  { id: "opus", name: "Opus", policy: "enabled", reasoningEfforts: ["high"] },
  { id: "sonnet", name: "Sonnet", policy: "enabled" },
];
let sequence = 0;
const at = 1;
const threadId = "t1";
const created: ThreadWireEvent = {
  threadId,
  sequence: ++sequence,
  at,
  type: "thread.created",
  thread: { scope: "indexer" },
};
const sent = (
  messageId: string,
  message: Extract<ThreadWireEvent, { type: "message.sent" }>["message"],
): ThreadWireEvent => ({
  threadId,
  sequence: ++sequence,
  at,
  type: "message.sent",
  messageId,
  message,
});
const turn = (turnId: string) => ({ threadId, sequence: ++sequence, at, turnId });

it("leaves one model line where a message changes the model or effort, and none for the first", () => {
  const { entries } = threadEntries(
    [
      created,
      sent("m1", { prompt: "one", model: "sonnet" }),
      sent("m2", { prompt: "two", model: "sonnet" }),
      sent("m3", { prompt: "three", model: "opus", reasoningEffort: "high" }),
      sent("m4", { prompt: "four", model: "opus", reasoningEffort: "high" }),
      sent("m5", { prompt: "five", model: "unlisted" }),
    ],
    models,
  );
  expect(entries.map((entry) => (entry.kind === "model-switch" ? entry.to : entry.kind))).toEqual([
    "user",
    "user",
    "Opus · High",
    "user",
    "user",
    "unlisted",
    "user",
  ]);
});

it("shows a message's chips by subject, and a turn's calls, reply and end as the journal has them", () => {
  const { entries, running } = threadEntries(
    [
      created,
      sent("m1", {
        prompt: "Why?",
        attachments: [{ name: "context:sync-run:indexer", content: "{}" }],
      }),
      { ...turn("u1"), type: "turn.started", messageId: "m1" },
      { ...turn("u1"), type: "assistant.delta", text: "Read" },
      { ...turn("u1"), type: "assistant.delta", text: "ing." },
      {
        ...turn("u1"),
        type: "tool.started",
        callId: "c1",
        name: "spi_inspect",
        kind: "tool",
        arguments: { id: "x" },
      },
      {
        ...turn("u1"),
        type: "tool.finished",
        callId: "c1",
        outcome: "failed",
        result: "denied",
        resultBytes: 6,
        durationMs: 1,
      },
      {
        ...turn("u1"),
        type: "tool.started",
        callId: "c2",
        name: "spi_brief",
        kind: "tool",
        arguments: {},
      },
      { ...turn("u1"), type: "assistant.delta", text: "Done." },
      {
        ...turn("u1"),
        type: "turn.finished",
        outcome: "failed",
        failure: "Copilot stopped answering.",
      },
    ],
    models,
  );
  expect(running).toBe(false);
  expect(entries).toEqual([
    { kind: "user", id: "m1", text: "Why?", chips: ["sync-run:indexer"] },
    expect.objectContaining({ kind: "assistant", text: "Reading.", streaming: false }),
    expect.objectContaining({
      kind: "call",
      id: "c1",
      status: "failed",
      args: '{"id":"x"}',
      result: "denied",
    }),
    expect.objectContaining({ kind: "call", id: "c2", status: "unknown" }),
    expect.objectContaining({ kind: "assistant", text: "Done.", streaming: false }),
    { kind: "turn-end", id: "end:u1", state: "failed", detail: "Copilot stopped answering." },
  ]);
});

it("keeps a turn running until the journal ends it, and says a restart cancelled a queued message", () => {
  const started = [
    created,
    sent("m1", { prompt: "Go" }),
    { ...turn("u1"), type: "turn.started", messageId: "m1" },
  ] as ThreadWireEvent[];
  expect(threadEntries(started, models).running).toBe(true);
  const { entries, running } = threadEntries(
    [
      ...started,
      { ...turn("u1"), type: "turn.finished", outcome: "cancelled", reason: "restart" },
      {
        threadId,
        sequence: ++sequence,
        at,
        type: "message.cancelled",
        messageId: "m2",
        reason: "restart",
      },
    ],
    models,
  );
  expect(running).toBe(false);
  expect(entries.slice(1)).toEqual([
    {
      kind: "turn-end",
      id: "end:u1",
      state: "cancelled",
      detail: "Ended when SPI Code restarted.",
    },
    expect.objectContaining({ kind: "turn-end", state: "cancelled" }),
  ]);
});

it("keeps an approval's exact edit and says a restarted approval applied nothing", () => {
  const { entries } = threadEntries(
    [
      created,
      sent("m1", { prompt: "Edit it" }),
      { ...turn("u1"), type: "turn.started", messageId: "m1" },
      {
        ...turn("u1"),
        type: "approval.requested",
        approvalId: "a1",
        kind: "write",
        detail: "/repo/src.ts",
        path: "/repo/src.ts",
        diff: "--- a/src.ts\n+++ b/src.ts\n@@\n-old\n+new",
      },
      { ...turn("u1"), type: "approval.cancelled", approvalId: "a1", reason: "restart" },
      { ...turn("u1"), type: "turn.finished", outcome: "cancelled", reason: "restart" },
    ],
    models,
  );
  expect(entries).toContainEqual({
    kind: "approval",
    id: "a1",
    approvalId: "a1",
    turnId: "u1",
    requestKind: "write",
    status: "cancelled",
    detail: "/repo/src.ts",
    path: "/repo/src.ts",
    diff: "--- a/src.ts\n+++ b/src.ts\n@@\n-old\n+new",
    reason: "SPI Code restarted before the edit was approved. The edit was not applied.",
  });
});

it("omits host-passed approvals and labels host refusals", () => {
  const { entries } = threadEntries(
    [
      created,
      { ...turn("u1"), type: "turn.started", messageId: "m1" },
      {
        ...turn("u1"),
        type: "approval.requested",
        approvalId: "pass",
        kind: "read",
        detail: "/repo/src.ts",
        path: "/repo/src.ts",
        asked: false,
      },
      { ...turn("u1"), type: "approval.resolved", approvalId: "pass", approved: true },
      {
        ...turn("u1"),
        type: "approval.requested",
        approvalId: "deny",
        kind: "write",
        detail: "/repo/src.ts",
        path: "/repo/src.ts",
        reason: "This thread is not allowed to edit this path.",
        asked: false,
      },
      { ...turn("u1"), type: "approval.resolved", approvalId: "deny", approved: false },
    ],
    models,
  );
  expect(entries).toEqual([
    expect.objectContaining({
      kind: "approval",
      id: "deny",
      status: "refused",
      reason: "This thread is not allowed to edit this path.",
    }),
  ]);
});
