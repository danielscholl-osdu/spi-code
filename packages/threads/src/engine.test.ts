// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import type {
  RuntimeEvents,
  RuntimeStop,
  RuntimeTurn,
  ThreadEvent,
  WorkspacePreparation,
} from "./index.js";
import { ThreadEngine } from "./index.js";

function harness(
  database = new DatabaseSync(":memory:"),
  workspace: (
    preparation: WorkspacePreparation,
  ) => { cwd: string } | Promise<{ cwd: string }> = () => ({
    cwd: "/workspace",
  }),
) {
  const turns: {
    input: RuntimeTurn<string>;
    events: RuntimeEvents;
    finish: () => void;
  }[] = [];
  const runtime = {
    run: vi.fn((input: RuntimeTurn<string>, events: RuntimeEvents) => {
      return new Promise<RuntimeStop | undefined>((resolve) => {
        turns.push({ input, events, finish: () => resolve(undefined) });
      });
    }),
  };
  const engine = new ThreadEngine(database, {
    runtime,
    workspace: { resolve: (_request, preparation) => workspace(preparation) },
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

it("moves an Asking thread without changing its messages and resolves the next turn in the worktree", async () => {
  let cwd = "/workspace/clone";
  const { engine, turn, database } = harness(new DatabaseSync(":memory:"), () => ({ cwd }));
  const id = engine.create({ scope: "partition", title: "Retry the port" });
  const first = engine.send(id, { prompt: "Why did this stop?" });
  (await turn()).finish();
  await first;

  cwd = "/workspace/thread";
  engine.land(id, {
    target: "fork-main",
    branch: `spi/${id}`,
    baseRef: "refs/remotes/origin/main",
    worktree: cwd,
    head: "a".repeat(40),
  });
  const next = engine.send(id, { prompt: "Make the change" });
  const second = await turn(1);
  expect(second.input.workspace).toEqual({ cwd });
  expect(second.input.thread.landsIn).toMatchObject({
    target: "fork-main",
    worktree: cwd,
    branch: `spi/${id}`,
  });
  second.finish();
  await next;
  expect(engine.read(id).messages.map(({ message }) => message.prompt)).toEqual([
    "Why did this stop?",
    "Make the change",
  ]);
  const reopened = harness(database).engine;
  expect(reopened.read(id)).toMatchObject({
    thread: { landsIn: { target: "fork-main", worktree: cwd } },
    messages: [
      { message: { prompt: "Why did this stop?" } },
      { message: { prompt: "Make the change" } },
    ],
  });
  database.close();
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
    status: "Open",
    settledAt: null,
    done: false,
    turns: [{ text: "The sweep.", outcome: "completed" }],
  });
  database.close();
});

it("journals workspace preparation and one textless thinking mark per stretch, and reopens them", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "spi-threads-")), "journal.sqlite");
  try {
    const { engine, turn, database } = harness(new DatabaseSync(path), (preparation) => {
      preparation.started("clone");
      preparation.finished();
      return { cwd: "/workspace" };
    });
    const id = engine.create({ scope: "partition" });
    const outcome = engine.send(id, { prompt: "Why?" });
    const { events, finish } = await turn();
    events.thinking();
    events.thinking();
    events.delta("Because.");
    events.thinking();
    events.toolStarted({ callId: "read", name: "view", kind: "tool", arguments: {} });
    events.toolFinished({ callId: "read", outcome: "completed", result: "ok" });
    events.thinking();
    finish();
    await outcome;
    expect(engine.eventsSince(id, 0).map((event) => event.type)).toEqual([
      "thread.created",
      "message.sent",
      "turn.started",
      "workspace.started",
      "workspace.finished",
      "assistant.thinking",
      "assistant.thinking",
      "assistant.delta",
      "tool.started",
      "tool.finished",
      "assistant.thinking",
      "turn.finished",
    ]);
    expect(
      engine.eventsSince(id, 0).find((event) => event.type === "workspace.started"),
    ).toMatchObject({ operation: "clone" });
    database.close();
    const reopened = harness(new DatabaseSync(path));
    expect(reopened.engine.read(id)).toMatchObject({
      status: "Open",
      turns: [{ text: "Because.", outcome: "completed" }],
    });
    reopened.database.close();
  } finally {
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

it("drops a preparation end that arrives after the operator stopped the turn", async () => {
  let release: (() => void) | undefined;
  let preparation: WorkspacePreparation | undefined;
  const { engine, database } = harness(new DatabaseSync(":memory:"), (given) => {
    preparation = given;
    given.started("fetch");
    return new Promise((resolve) => {
      release = () => resolve({ cwd: "/workspace" });
    });
  });
  const id = engine.create({ scope: "partition" });
  const outcome = engine.send(id, { prompt: "Why?" });
  await vi.waitFor(() => expect(release).toBeDefined());
  const stopped = engine.stop(id);
  expect(() => preparation?.finished()).not.toThrow();
  release?.();
  await stopped;
  await expect(outcome).resolves.toBe("stopped");
  expect(engine.eventsSince(id, 0).map((event) => event.type)).toEqual([
    "thread.created",
    "message.sent",
    "turn.started",
    "workspace.started",
    "turn.finished",
  ]);
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

it.each([
  {
    name: "a YAML password",
    path: "/wt/app.yaml",
    diff: "@@ -1 +1 @@\n-password: oldSyntheticValue1\n+password: newSyntheticValue2\n",
  },
  {
    name: "a token assignment",
    path: "/wt/Auth.java",
    diff: "@@ -1 +1 @@\n-    String token = request.getHeader(name);\n+    String token = request.getParameter(name);\n",
  },
  {
    name: "an API key lookup",
    path: "/wt/client.ts",
    diff: "@@ -1 +1 @@\n-const apiKey = process.env.OLD_NAME;\n+const api_key = settings.lookup;\n",
  },
  {
    name: "an env example",
    path: "/wt/.env.example",
    diff: "@@ -0,0 +1 @@\n+CLIENT_SECRET=replace-me-synthetic\n",
  },
  {
    name: "an assignment-shaped path",
    path: "/wt/token=abcdefghijklmnop/file.ts",
    diff: "+x\n",
  },
  {
    name: "an empty diff",
    path: "/wt/new.ts",
    diff: "",
  },
])("refuses an asking write with $name", async ({ path, diff }) => {
  const { engine, turn, database } = harness();
  const id = engine.create({ scope: "partition" });
  const outcome = engine.send(id, { prompt: "Edit" });
  const { events, finish } = await turn();
  await expect(
    events.requestApproval({ approvalId: "edit", kind: "write", detail: path, path, diff }),
  ).resolves.toBe(false);
  expect(engine.decideApproval(id, engine.read(id).turns[0]?.id ?? "", "edit", true)).toBe(false);
  const approval = engine
    .eventsSince(id, 0)
    .find((event) => event.type === "approval.requested" && event.approvalId === "edit");
  expect(approval).toMatchObject({
    type: "approval.requested",
    asked: false,
    reason: expect.stringMatching(
      /secret, so it can't be shown for approval|no diff to show for approval/,
    ),
  });
  finish();
  await outcome;
  database.close();
});

it("keeps a secret split by a thinking mark out of the journal", async () => {
  const { engine, turn, database } = harness();
  const id = engine.create({ scope: "partition" });
  const outcome = engine.send(id, { prompt: "Show it" });
  const { events, finish } = await turn();
  const secret = `ghp_${"x".repeat(36)}`;
  events.delta(`Token ${secret.slice(0, 20)}`);
  events.thinking();
  events.delta(`${secret.slice(20)} found.`);
  finish();
  await expect(outcome).resolves.toBe("completed");
  const journal = engine.eventsSince(id, 0);
  expect(journal.map(({ type }) => type)).toContain("assistant.thinking");
  const written = JSON.stringify(journal);
  expect([secret.slice(0, 20), secret.slice(20)].filter((half) => written.includes(half))).toEqual(
    [],
  );
  expect(engine.read(id).turns[0]?.text).toBe("Token [redacted] found.");
  database.close();
});

it("will not delete a thread while a command or turn is running", async () => {
  const { engine, turn, database } = harness();
  const id = engine.create({ scope: "partition" });
  const outcome = engine.send(id, { prompt: "Run it" });
  const active = await turn();
  active.events.toolStarted({ callId: "command", name: "bash", kind: "command", arguments: {} });
  expect(() => engine.delete(id)).toThrow("Stop the thread");
  expect(engine.list()).toContainEqual(expect.objectContaining({ id }));
  active.finish();
  await outcome;
  engine.delete(id);
  expect(engine.list()).not.toContainEqual(expect.objectContaining({ id }));
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
    status: "Open",
    done: false,
    turns: [{ text: "", approvals: [{ end: { type: "approval.cancelled" } }] }],
  });
  database.close();
});

it("keeps approvals in different threads isolated and applies no declined edit", async () => {
  const { engine, turn, database } = harness();
  const firstId = engine.create({ scope: "partition" });
  const secondId = engine.create({ scope: "storage" });
  const firstOutcome = engine.send(firstId, { prompt: "Edit partition" });
  const first = await turn();
  const secondOutcome = engine.send(secondId, { prompt: "Edit storage" });
  const second = await turn(1);
  let file = "before";
  const firstApproval = first.events
    .requestApproval({ approvalId: "edit", kind: "edit", detail: "partition.ts" })
    .then((approved) => {
      if (approved) file = "partition";
    });
  const secondApproval = second.events
    .requestApproval({ approvalId: "edit", kind: "edit", detail: "storage.ts" })
    .then((approved) => {
      if (approved) file = "storage";
    });

  expect(engine.decideApproval(secondId, first.input.turnId, "edit", true)).toBe(false);
  expect(engine.decideApproval(firstId, first.input.turnId, "edit", false)).toBe(true);
  await firstApproval;
  expect(file).toBe("before");
  expect(engine.read(secondId).status).toBe("Waiting on you");
  expect(engine.decideApproval(secondId, second.input.turnId, "edit", true)).toBe(true);
  await secondApproval;
  expect(file).toBe("storage");
  first.finish();
  second.finish();
  await Promise.all([firstOutcome, secondOutcome]);
  database.close();
});

it("stops a queued message sent while the stopped turn is still releasing its session", async () => {
  let resolved = 0;
  const { engine, runtime, turn, database } = harness(new DatabaseSync(":memory:"), () => {
    resolved++;
    return { cwd: "/workspace" };
  });
  const id = engine.create({ scope: "partition" });
  const first = engine.send(id, { prompt: "First" });
  const running = await turn();
  const stopped = engine.stop(id);
  expect(engine.eventsSince(id, 0).at(-1)).toMatchObject({ type: "turn.finished" });
  const second = engine.send(id, { prompt: "Second" });
  const stoppedAgain = engine.stop(id);
  running.finish();
  await Promise.all([stopped, stoppedAgain]);
  await expect(first).resolves.toBe("stopped");
  await expect(second).resolves.toBe("stopped");
  expect(runtime.run).toHaveBeenCalledTimes(1);
  expect(resolved).toBe(1);
  expect(engine.eventsSince(id, 0).slice(-2)).toMatchObject([
    { type: "turn.started" },
    { type: "turn.finished", outcome: "stopped", reason: "operator" },
  ]);
  expect(engine.read(id).turns.map(({ outcome }) => outcome)).toEqual(["stopped", "stopped"]);
  database.close();
});

it("retains the runtime stop reason in the journal and timeline and settles open effects", async () => {
  const { engine, runtime, turn, database } = harness();
  runtime.run.mockImplementationOnce(async (_input, events) => {
    events.toolStarted({ callId: "read", name: "view", kind: "tool", arguments: null });
    void events.requestApproval({ approvalId: "pending", kind: "read", detail: "Another read" });
    return { outcome: "stopped", reason: "refused-tool" };
  });
  const id = engine.create({ scope: "partition" });
  await expect(engine.send(id, { prompt: "Read a file" })).resolves.toBe("stopped");
  expect(engine.eventsSince(id, 0).slice(-3)).toMatchObject([
    { type: "tool.cancelled", reason: "refused-tool", effectState: "not known" },
    { type: "approval.cancelled", reason: "refused-tool" },
    { type: "turn.finished", outcome: "stopped", reason: "refused-tool" },
  ]);
  expect(engine.read(id).turns).toMatchObject([{ outcome: "stopped", stopReason: "refused-tool" }]);
  const followUp = engine.send(id, { prompt: "Continue" });
  const next = await turn();
  expect(next.input.context.instructions).toContain("Copilot stopped after a refused tool call.");
  next.finish();
  await followUp;
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
    let editApplied = false;
    void running.events
      .requestApproval({
        approvalId: "ap-crash",
        kind: "edit",
        detail: "edit file",
      })
      .then((approved) => {
        if (approved) editApplied = true;
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
      status: "Open",
      messages: [{ status: "started" }, { status: "cancelled" }],
      turns: [
        {
          outcome: "cancelled",
          partialTextSeen: "not known",
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
    expect(editApplied).toBe(false);
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

it("stores manual settlement and a hand-unsettled hold, and refuses both running states", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-01T10:00:00Z"));
  const { engine, turn, database } = harness();
  const id = engine.create({ scope: "partition" });
  const waiting = engine.send(id, { prompt: "Inspect" });
  const first = await turn();
  expect(engine.settle(id)).toBe(false);
  const approval = first.events.requestApproval({
    approvalId: "approval",
    kind: "read",
    detail: "Read the tree",
  });
  expect(engine.settle(id)).toBe(false);
  expect(engine.read(id).status).toBe("Waiting on you");
  engine.decideApproval(id, first.input.turnId, "approval", true);
  await approval;
  first.finish();
  await waiting;

  const activity = engine.read(id).updatedAt;
  expect(engine.settle(id)).toBe(true);
  expect(engine.read(id)).toMatchObject({
    status: "Settled",
    settledAt: activity,
    updatedAt: activity,
  });
  expect(engine.eventsSince(id, 0).at(-1)).toMatchObject({
    type: "thread.settled",
    reason: "operator",
    settledAt: activity,
  });

  engine.unsettle(id);
  vi.setSystemTime(new Date("2026-11-09T10:00:00Z"));
  engine.autoSettle();
  expect(engine.read(id).status).toBe("Open");

  const followUp = engine.send(id, { prompt: "Continue" });
  const second = await turn(1);
  second.finish();
  await followUp;
  vi.setSystemTime(new Date("2026-11-17T10:00:00Z"));
  engine.autoSettle();
  expect(engine.read(id).status).toBe("Settled");
  expect(engine.eventsSince(id, 0).at(-1)).toMatchObject({
    type: "thread.settled",
    reason: "inactivity",
  });
  database.close();
});

it("restores the hand-unsettled state from before an ordinary Undo", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-01T10:00:00Z"));
  const { engine, database } = harness();
  const id = engine.create({ scope: "partition" });

  expect(engine.settle(id)).toBe(true);
  engine.unsettle(id, { restore: true });
  vi.setSystemTime(new Date("2026-11-09T10:00:00Z"));
  engine.autoSettle();
  expect(engine.read(id).status).toBe("Settled");

  engine.unsettle(id);
  expect(engine.settle(id)).toBe(true);
  engine.unsettle(id, { restore: true });
  vi.setSystemTime(new Date("2026-11-17T10:00:00Z"));
  engine.autoSettle();
  expect(engine.read(id).status).toBe("Open");
  database.close();
});

it("marks only completed turns after the thread's seen sequence as Done", async () => {
  const { engine, turn, database } = harness();
  const id = engine.create({ scope: "partition" });
  const first = engine.send(id, { prompt: "First" });
  (await turn()).finish();
  await first;
  engine.seen(id, 1);
  expect(engine.read(id).done).toBe(true);
  engine.seen(id, engine.read(id).sequence);
  expect(engine.read(id).done).toBe(false);

  const second = engine.send(id, { prompt: "Second" });
  (await turn(1)).finish();
  await second;
  expect(engine.read(id).done).toBe(true);
  const writes = engine.eventsSince(id, 0).length;
  engine.seen(id, 1);
  engine.seen(id, engine.read(id).sequence + 1);
  expect(engine.eventsSince(id, 0)).toHaveLength(writes);
  engine.seen(id, engine.read(id).sequence);

  const stopped = engine.send(id, { prompt: "Third" });
  const third = await turn(2);
  await engine.stop(id);
  third.finish();
  await stopped;
  expect(engine.read(id)).toMatchObject({ status: "Open", done: false });
  database.close();
});

it("auto-settles an old idle journal while reopening it", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-01T10:00:00Z"));
  const directory = mkdtempSync(join(tmpdir(), "spi-thread-settlement-"));
  const path = join(directory, "threads.db");
  const database = new DatabaseSync(path);
  const { engine, turn } = harness(database);
  const id = engine.create({ scope: "partition" });
  const sent = engine.send(id, { prompt: "Inspect" });
  (await turn()).finish();
  await sent;
  await engine.shutdown();
  database.close();

  vi.setSystemTime(new Date("2026-11-09T10:00:00Z"));
  const reopened = harness(new DatabaseSync(path));
  expect(reopened.engine.read(id)).toMatchObject({
    status: "Settled",
    updatedAt: Date.parse("2026-11-01T10:00:00Z"),
  });
  await reopened.engine.shutdown();
  reopened.database.close();
  rmSync(directory, { recursive: true, force: true });
});

it("keeps an unreadable journal visible without claiming its state or definition", () => {
  const { engine, database } = harness();
  const id = engine.create({ scope: "partition", title: "Inspect" });
  database
    .prepare(
      "INSERT INTO thread_engine_journal (thread_id, sequence, at, payload) VALUES (?, 2, ?, ?)",
    )
    .run(id, Date.now() + 1000, "{not json");
  const unreadable: string[] = [];
  const reopened = new ThreadEngine(database, {
    runtime: { run: async () => undefined },
    workspace: { resolve: () => ({ cwd: "/workspace" }) },
    context: { prepare: () => ({ instructions: "", attachments: [] }) },
    tools: { offer: () => [] },
    onUnreadableThread: (threadId) => unreadable.push(threadId),
  });
  expect(unreadable).toEqual([id]);
  expect(reopened.list()).toContainEqual({
    id,
    thread: { scope: "not known" },
    status: "Can't be read",
    sequence: 2,
    updatedAt: expect.any(Number),
    settledAt: null,
    done: false,
  });
  expect(() => reopened.read(id)).toThrow("Unknown thread");
  database.close();
});

it.each([
  {
    name: "unknown settlement reason",
    payload: (at: number) =>
      JSON.stringify({ type: "thread.settled", reason: "mystery", settledAt: at }),
  },
  {
    name: "negative settlement time",
    payload: () => JSON.stringify({ type: "thread.settled", reason: "operator", settledAt: -1 }),
  },
  {
    name: "unknown un-settlement reason",
    payload: () => JSON.stringify({ type: "thread.unsettled", reason: "mystery" }),
  },
  {
    name: "negative seen sequence",
    payload: () => JSON.stringify({ type: "thread.seen", seenSequence: -1 }),
  },
  {
    name: "extra settlement field",
    payload: (at: number) =>
      JSON.stringify({ type: "thread.settled", reason: "operator", settledAt: at, extra: true }),
  },
  {
    name: "malformed landed target",
    payload: () =>
      JSON.stringify({
        type: "thread.landed",
        landsIn: {
          target: "fork-main",
          branch: "spi/thread",
          baseRef: "refs/remotes/origin/main",
          worktree: "/workspace/thread",
          head: "not-a-sha",
        },
      }),
  },
])("lists a journal with $name as unreadable", ({ payload }) => {
  const database = new DatabaseSync(":memory:");
  const { engine } = harness(database);
  const id = engine.create({ scope: "partition" });
  const at = engine.list().find((thread) => thread.id === id)?.updatedAt;
  if (at === undefined) throw new Error("Created thread is missing");
  database
    .prepare(
      "INSERT INTO thread_engine_journal (thread_id, sequence, at, payload) VALUES (?, 2, ?, ?)",
    )
    .run(id, at, payload(at));

  const reopened = harness(database).engine;
  expect(reopened.list().find((thread) => thread.id === id)).toMatchObject({
    status: "Can't be read",
    done: false,
  });
  database.close();
});

it("keeps an unreadable thread in the list and recovers the rest of the journal", () => {
  const database = new DatabaseSync(":memory:");
  const first = harness(database).engine;
  const healthy = first.create({ scope: "storage" });
  const damaged = first.create({ scope: "partition" });
  database.prepare("INSERT INTO thread_engine_journal VALUES (?, 2, 0, '{')").run(damaged);
  const reopened = harness(database).engine;
  expect(reopened.list().map(({ id }) => id)).toEqual([healthy, damaged]);
  expect(reopened.list().find(({ id }) => id === damaged)?.status).toBe("Can't be read");
  expect(() => reopened.read(damaged)).toThrow("Unknown thread");
  database.close();
});

it("retains a bounded, redacted failure reason", async () => {
  const { database, engine, runtime } = harness();
  const id = engine.create({ scope: "partition" });
  const secret = `ghp_${"x".repeat(36)}`;
  runtime.run.mockRejectedValueOnce(new Error(`Rejected token: ${secret}\n${"x".repeat(1000)}`));
  await expect(engine.send(id, { prompt: "Hello" })).resolves.toBe("failed");
  const outcome = engine.read(id).turns[0];
  expect(outcome?.failure?.length).toBe(500);
  expect(outcome?.failure).toContain("Rejected token: [redacted]");
  expect(JSON.stringify(engine.eventsSince(id, 0))).not.toContain(secret);
  database.close();
});

it("unblocks the queue and shutdown when an aborted runtime never settles", async () => {
  vi.useFakeTimers();
  const { database, engine, turn } = harness();
  const id = engine.create({ scope: "partition" });
  const first = engine.send(id, { prompt: "This runtime ignores abort" });
  const second = engine.send(id, { prompt: "This is queued" });
  await turn();
  const stopped = engine.stop(id);
  await vi.advanceTimersByTimeAsync(1500);
  await stopped;
  await expect(first).resolves.toBe("stopped");
  const next = await turn(1);
  expect(next.input.message.prompt).toBe("This is queued");
  const shutdown = engine.shutdown();
  await vi.advanceTimersByTimeAsync(1500);
  await shutdown;
  await expect(second).resolves.toBe("cancelled");
  expect(next.input.signal.aborted).toBe(true);
  database.close();
});
