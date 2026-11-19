// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import type { RuntimeEvents, RuntimeTurn, ThreadEvent } from "./index.js";
import { ThreadEngine } from "./index.js";

function harness(database = new DatabaseSync(":memory:")) {
  const turns: {
    input: RuntimeTurn<string>;
    events: RuntimeEvents;
    finish: () => void;
  }[] = [];
  const runtime = {
    run: vi.fn((input: RuntimeTurn<string>, events: RuntimeEvents) => {
      return new Promise<void>((resolve) => {
        turns.push({ input, events, finish: resolve });
      });
    }),
  };
  const engine = new ThreadEngine(database, {
    runtime,
    workspace: { resolve: () => ({ cwd: "/workspace" }) },
    context: {
      prepare: ({ message }) => ({
        instructions: "Scope instructions.",
        attachments: message.attachments ?? [],
      }),
    },
    tools: { offer: () => ["read_current"] },
  });
  async function turn(index = 0) {
    for (let attempt = 0; attempt < 10 && !turns[index]; attempt++) await Promise.resolve();
    const active = turns[index];
    assert(active, `Runtime turn ${index + 1} did not start`);
    return active;
  }
  return { engine, runtime, turn, database };
}

afterEach(() => {
  vi.useRealTimers();
});

it("passes the host's workspace, context and tools, journals deltas in order and settles", async () => {
  const { engine, turn, database } = harness();
  const id = engine.create({ scope: "partition" });
  const attachments = [{ name: "Saved sweep", content: "Sweep at 08:02." }];
  const outcome = engine.send(id, { prompt: "Read the sweep", attachments });
  const running = await turn();
  expect(running.input).toMatchObject({
    workspace: { cwd: "/workspace" },
    context: { instructions: "Scope instructions.", attachments },
    tools: ["read_current"],
  });
  expect(engine.read(id).status).toBe("Working");
  running.events.delta("The ");
  running.events.delta("sweep.");
  running.finish();
  await expect(outcome).resolves.toBe("completed");
  expect(
    engine
      .eventsSince(id, 0)
      .filter((event) => event.type === "assistant.delta")
      .map((event) => event.text),
  ).toEqual(["The sweep."]);
  expect(engine.read(id)).toMatchObject({
    status: "Settled",
    turns: [{ text: "The sweep.", outcome: "completed" }],
  });
  database.close();
});

it("journals text through the redactor before a tool call and an approval request", async () => {
  const { engine, turn, database } = harness();
  const id = engine.create({ scope: "partition" });
  const outcome = engine.send(id, { prompt: "Run checks" });
  const { events, finish } = await turn();
  const fake = "fake".repeat(5);
  events.delta(`Checking token: ${fake}`);
  events.toolStarted({ callId: "check", name: "check", kind: "command", arguments: {} });
  events.delta(`Confirm password: ${fake}`);
  void events.requestApproval({ approvalId: "edit", kind: "edit", detail: "Edit file" });
  const journal = engine.eventsSince(id, 0).slice(-4);
  expect(journal).toMatchObject([
    { type: "assistant.delta", text: "Checking token: [redacted]" },
    { type: "tool.started" },
    { type: "assistant.delta", text: "Confirm password: [redacted]" },
    { type: "approval.requested" },
  ]);
  expect(JSON.stringify(journal).includes(fake)).toBe(false);
  finish();
  await expect(outcome).resolves.toBe("completed");
  database.close();
});

it("stops by operator request, releases approvals and ignores callbacks from the stopped turn", async () => {
  const { engine, turn, database } = harness();
  const id = engine.create({ scope: "partition" });
  const outcome = engine.send(id, { prompt: "Check something" });
  const running = await turn();
  const approval = running.events.requestApproval({
    approvalId: "ap-1",
    kind: "edit",
    detail: "edit file",
  });
  expect(engine.read(id).status).toBe("Waiting on you");
  const stopped = engine.stop(id);
  expect(running.input.signal.aborted).toBe(true);
  await expect(approval).resolves.toBe(false);
  running.events.delta("late");
  running.finish();
  await stopped;
  await expect(outcome).resolves.toBe("stopped");
  expect(engine.eventsSince(id, 0).at(-1)).toMatchObject({
    type: "turn.finished",
    outcome: "stopped",
    reason: "operator",
  });
  expect(engine.read(id)).toMatchObject({
    status: "Settled",
    turns: [{ text: "", approvals: [{ end: { type: "approval.cancelled" } }] }],
  });
  database.close();
});

it("rolls back incomplete cancellation but still signals stop and denies pending approvals", async () => {
  const { engine, turn, database } = harness();
  const id = engine.create({ scope: "partition" });
  const outcome = engine.send(id, { prompt: "Run checks" });
  const running = await turn();
  running.events.toolStarted({ callId: "call-1", name: "check", kind: "command", arguments: {} });
  const approval = running.events.requestApproval({
    approvalId: "ap-1",
    kind: "edit",
    detail: "edit file",
  });
  const before = engine.eventsSince(id, 0);
  expect(engine.decideApproval(id, "old-turn", "ap-1", true)).toBe(false);
  database.exec(`
    CREATE TEMP TRIGGER refuse_finish BEFORE INSERT ON thread_engine_journal
    WHEN json_extract(NEW.payload, '$.type') = 'turn.finished'
    BEGIN SELECT RAISE(ABORT, 'cannot write turn finish'); END
  `);
  await expect(engine.stop(id)).rejects.toThrow("cannot write turn finish");
  expect(engine.eventsSince(id, 0)).toEqual(before);
  expect(engine.read(id).status).toBe("Waiting on you");
  expect(running.input.signal.aborted).toBe(true);
  await expect(approval).resolves.toBe(false);
  expect(engine.decideApproval(id, running.input.turnId, "ap-1", true)).toBe(false);
  database.exec("DROP TRIGGER refuse_finish");

  running.finish();
  await expect(outcome).resolves.toBe("stopped");
  expect(engine.read(id).turns[0]?.tools[0]?.end).toMatchObject({
    type: "tool.cancelled",
    processState: "not known",
  });
  database.close();
});

it("runs two durable queued messages in their original send order", async () => {
  const { engine, runtime, turn, database } = harness();
  const id = engine.create({ scope: "partition" });
  const outcomes = ["one", "two", "three"].map((prompt) => engine.send(id, { prompt }));
  expect(engine.read(id).messages.map((message) => message.status)).toEqual([
    "started",
    "queued",
    "queued",
  ]);
  for (const [index, prompt] of ["one", "two", "three"].entries()) {
    const running = await turn(index);
    expect(runtime.run).toHaveBeenCalledTimes(index + 1);
    expect(running.input.message.prompt).toBe(prompt);
    running.finish();
  }
  await expect(Promise.all(outcomes)).resolves.toEqual(["completed", "completed", "completed"]);
  database.close();
});

it("keeps a tool running for 400 seconds and journals its arguments, result, size and duration", async () => {
  vi.useFakeTimers();
  const { engine, turn, database } = harness();
  const id = engine.create({ scope: "partition" });
  const outcome = engine.send(id, { prompt: "Run a long check" });
  const running = await turn();
  running.events.toolStarted({
    callId: "call-1",
    name: "check",
    kind: "command",
    arguments: { task: "long" },
  });
  await vi.advanceTimersByTimeAsync(400_000);
  expect(running.input.signal.aborted).toBe(false);
  expect(engine.read(id).status).toBe("Working");
  running.events.toolFinished({ callId: "call-1", outcome: "completed", result: "été" });
  running.finish();
  await expect(outcome).resolves.toBe("completed");
  expect(engine.read(id).turns[0]?.tools).toEqual([
    {
      start: expect.objectContaining({ callId: "call-1", arguments: { task: "long" } }),
      end: expect.objectContaining({
        callId: "call-1",
        result: "été",
        resultBytes: Buffer.byteLength(JSON.stringify("été")),
        durationMs: 400_000,
      }),
    },
  ]);
  database.close();
});

it("cancels interrupted work on disk once, leaves process fate unknown and starts no turn on reopening", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spi-threads-"));
  try {
    const path = join(dir, "journal.sqlite");
    const first = harness(new DatabaseSync(path));
    const id = first.engine.create({ scope: "partition" });
    void first.engine.send(id, { prompt: "Run checks" });
    const running = await first.turn();
    running.events.delta("Partial reply\nunfinished line");
    running.events.toolStarted({
      callId: "call-crash",
      name: "check",
      kind: "command",
      arguments: {},
    });
    void running.events.requestApproval({
      approvalId: "ap-crash",
      kind: "edit",
      detail: "edit file",
    });
    const fakeBlock = `  ${"fixture".repeat(2400)}\n`;
    running.events.delta("client-key-data: |\n");
    running.events.delta(fakeBlock);
    running.events.delta("After the block\n");
    const unfinished = "x".repeat(16 * 1024);
    running.events.delta(unfinished);
    void first.engine.send(id, { prompt: "Queued before crash" });
    first.database.close();

    const second = harness(new DatabaseSync(path));
    await Promise.resolve();
    const events = second.engine.eventsSince(id, 0);
    expect(second.runtime.run).not.toHaveBeenCalled();
    expect(second.engine.read(id)).toMatchObject({
      status: "Settled",
      messages: [{ status: "started" }, { status: "cancelled" }],
      turns: [
        {
          outcome: "cancelled",
          text: "Partial reply\nunfinished line[redacted]\nAfter the block\n",
          tools: [
            { end: { type: "tool.cancelled", reason: "restart", processState: "not known" } },
          ],
          approvals: [{ end: { type: "approval.cancelled", reason: "restart" } }],
        },
      ],
    });
    expect(events.filter((event) => event.type === "turn.started")).toHaveLength(1);
    expect(events.some((event) => event.type === "tool.finished")).toBe(false);
    second.database.close();

    const third = harness(new DatabaseSync(path));
    expect(third.runtime.run).not.toHaveBeenCalled();
    expect(third.engine.eventsSince(id, 0)).toEqual(events);
    const followUp = third.engine.send(id, { prompt: "Inspect what happened" });
    const next = await third.turn();
    expect(next.input.message.prompt).toBe("Inspect what happened");
    expect(next.input.context.instructions).toContain(running.input.turnId);
    expect(next.input.context.instructions).toContain("call-crash");
    expect(next.input.context.instructions).toContain("ap-crash");
    expect(next.input.context.instructions).toContain("not known");
    next.events.toolFinished({ callId: "call-crash", outcome: "failed", result: null });
    expect(third.engine.read(id).turns[1]?.tools).toEqual([]);
    next.finish();
    await followUp;

    const later = third.engine.send(id, { prompt: "Move on" });
    const fresh = await third.turn(1);
    expect(fresh.input.context.instructions).toBe("Scope instructions.");
    fresh.finish();
    await later;
    third.database.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("subscribes after a sequence and delivers only that thread's later events across catch-up and live writes", async () => {
  const { engine, turn, database } = harness();
  const id = engine.create({ scope: "partition" });
  const other = engine.create({ scope: "storage" });
  const outcome = engine.send(id, { prompt: "Check partition" });
  const running = await turn();
  const seen: ThreadEvent[] = [];
  const unsubscribe = engine.subscribe(id, 2, {
    send(events) {
      seen.push(...events);
      if (seen.length === 2) running.events.delta("live\n");
    },
  });
  running.events.delta("catch-up\n");
  engine.send(other, { prompt: "Check storage" }).catch(() => {});
  const sibling = await turn(1);
  sibling.finish();
  await Promise.resolve();
  await Promise.resolve();
  expect(seen.map((event) => [event.sequence, event.type])).toEqual([
    [3, "turn.started"],
    [4, "assistant.delta"],
    [5, "assistant.delta"],
  ]);
  expect(seen.every((event) => event.threadId === id)).toBe(true);
  unsubscribe();
  running.finish();
  await outcome;
  expect(seen).toHaveLength(3);
  database.close();
});
