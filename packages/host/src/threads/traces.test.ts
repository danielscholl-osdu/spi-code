// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout } from "node:timers/promises";
import type { SessionEvent } from "@github/copilot-sdk";
import { type Message, PROTOCOL_VERSION, type ThreadWireEvent } from "@spi-code/contracts";
import { type JsonValue, journalOutputRedactor } from "@spi-code/threads";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { findLeaks, ownedToolStarts, turns } from "../../test/traces/relations.js";
import { carries, TracePlayer } from "../../test/traces/replay.js";
import {
  installedSdkVersion,
  parseTrace,
  readTrace,
  SCENARIOS,
  type TraceOp,
  tracePath,
  tracesRoot,
  traceVersions,
} from "../../test/traces/trace.js";
import { CopilotRuntime } from "../copilot/runtime.js";
import { attachHostPort } from "../process/port.js";
import { PrivilegedGit } from "../scopes/git.js";
import { ScopeRegistry } from "../scopes/registry.js";
import { ScopeWorkspaces } from "../scopes/workspace.js";
import { trackTurn } from "./events.js";
import { ThreadRoutes } from "./routes.js";

const version = installedSdkVersion();

/** Fields trackTurn reads that the runtime sets only in situations no recorded scenario reaches. */
const ABSENT_BY_DESIGN: Record<string, string> = {
  agentId: "set only on a sub-agent's events; no scenario starts a sub-agent",
};

type Replayed = {
  ops: readonly TraceOp[];
  player: TracePlayer;
  outcomes: string[];
  events: ThreadWireEvent[];
};

let root: string;
const replays = new Map<string, Replayed | Error>();

function port(runtime: CopilotRuntime, database: DatabaseSync, storePath: string) {
  const git = new PrivilegedGit({ appData: root, capturedPath: "" });
  const workspaces = new ScopeWorkspaces(git);
  const host = new ThreadRoutes({
    db: database,
    storePath,
    scopes: new ScopeRegistry(),
    savedSweep: () => undefined,
    git: async () => git,
    workspaces: () => workspaces,
    runtime: async () => runtime,
    env: {},
  });
  const responses = new Map<string, Message>();
  const waiting = new Map<string, (message: Message) => void>();
  const events: ThreadWireEvent[] = [];
  let receive: (event: { data: unknown }) => void = () => {};
  attachHostPort(
    {
      on: (_event, listener) => {
        receive = listener;
      },
      postMessage: (data) => {
        const message = data as Message;
        if (message.type === "thread.events") events.push(...message.payload.events);
        if (message.kind !== "response") return;
        responses.set(message.id, message);
        waiting.get(message.id)?.(message);
      },
      start() {},
    },
    1,
    host.routes,
  );
  let index = 0;
  const dispatch = (type: string, payload: unknown) => {
    const id = String(++index);
    receive({ data: { version: PROTOCOL_VERSION, id, kind: "request", type, payload } });
    return id;
  };
  const response = (id: string) =>
    new Promise<Message>((resolve) => {
      const done = responses.get(id);
      if (done) resolve(done);
      else waiting.set(id, resolve);
    });
  return { host, dispatch, response, events };
}

async function replay(ops: readonly TraceOp[], name: string): Promise<Replayed> {
  const storePath = join(mkdtempSync(join(root, `${name}-`)), "runs.sqlite");
  const database = new DatabaseSync(storePath);
  const player = new TracePlayer(ops);
  const runtime = new CopilotRuntime({ appDataDir: root, capturedPath: "" });
  vi.spyOn(runtime, "openThreadSession").mockImplementation(player.openThreadSession);
  vi.spyOn(runtime, "restartThreadClient").mockResolvedValue();
  vi.spyOn(runtime, "stop").mockResolvedValue();
  let current = port(runtime, database, storePath);
  const started = await current.response(current.dispatch("thread.start", { scope: "program" }));
  if (started.type !== "thread.started") throw new Error("The thread did not start");
  const { threadId } = started.payload;
  current.dispatch("thread.subscribe", { threadId, fromSequence: 0 });
  const sends: Promise<Message>[] = [];
  const ended = player.ended.then(async () => {
    await setTimeout(2000);
    throw new Error("The trace ended with a turn unfinished.");
  });
  ended.catch(() => {});
  const settle = async () => {
    for (const [index, sent] of sends.entries()) {
      await Promise.race([sent, player.failed, ended]).catch((error: unknown) => {
        throw new Error(
          `Turn ${index + 1} did not finish: ${error instanceof Error ? error.message : error}`,
        );
      });
    }
  };
  try {
    for (let op = await player.host(); op; op = await player.host()) {
      if (op.action === "send") {
        await settle();
        const id = current.dispatch("thread.send", { threadId, message: { prompt: op.prompt } });
        sends.push(current.response(id));
      } else if (op.action === "stop") {
        current.dispatch("thread.stop", { threadId });
      } else {
        await settle();
        await current.host.stop();
        current = port(runtime, database, storePath);
        current.dispatch("thread.subscribe", { threadId, fromSequence: 0 });
      }
    }
    await settle();
    const outcomes = await Promise.all(
      sends.map(async (sent) => {
        const message = await sent;
        return message.type === "thread.sent" ? message.payload.outcome : message.type;
      }),
    );
    await Promise.race([player.ended, player.failed]);
    return { ops, player, outcomes, events: current.events };
  } finally {
    await current.host.stop();
    database.close();
  }
}

beforeAll(async () => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "spi-thread-traces-")));
  if (!traceVersions().includes(version)) return;
  for (const scenario of SCENARIOS) {
    if (!existsSync(tracePath(version, scenario))) continue;
    try {
      replays.set(scenario, await replay(readTrace(version, scenario), scenario));
    } catch (error) {
      replays.set(scenario, error instanceof Error ? error : new Error(String(error)));
    }
  }
}, 240_000);

afterAll(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

it("has every scenario recorded for the installed Copilot SDK", () => {
  const record = `record them with pnpm smoke:threads --record on Copilot SDK ${version}`;
  expect(traceVersions(), record).toContain(version);
  for (const scenario of SCENARIOS)
    expect(existsSync(tracePath(version, scenario)), `${scenario}: ${record}`).toBe(true);
});

it.each(SCENARIOS)(
  "replays %s: each turn ends once with its recorded outcome and journals the tools it owns",
  (scenario) => {
    const replayed = replays.get(scenario);
    if (replayed instanceof Error) throw replayed;
    if (!replayed) throw new Error(`${scenario} was not replayed`);
    const sent = turns(replayed.ops);
    expect(replayed.outcomes).toEqual(
      sent.map(({ ops }) => (ops[0]?.op === "host" && "outcome" in ops[0] ? ops[0].outcome : "")),
    );
    const started = replayed.events.flatMap((event) =>
      event.type === "turn.started" ? [event.turnId] : [],
    );
    const finished = replayed.events.flatMap((event) =>
      event.type === "turn.finished" ? [event.turnId] : [],
    );
    expect(started).toHaveLength(sent.length);
    expect(finished).toEqual(started);
    const recorded = new Set(
      replayed.ops.flatMap((op) =>
        op.op === "event" && op.event.type === "tool.execution_start"
          ? [op.event.data.toolCallId]
          : [],
      ),
    );
    const journaled = started.map((turnId) =>
      replayed.events.flatMap((event) =>
        event.type === "tool.started" && event.turnId === turnId && recorded.has(event.callId)
          ? [event.callId]
          : [],
      ),
    );
    expect(journaled).toEqual(sent.map(ownedToolStarts));
  },
);

it("records a refused read outside the clone and replays the runtime abort as stopped", () => {
  const replayed = replays.get("denied-read");
  if (replayed instanceof Error) throw replayed;
  if (!replayed) throw new Error("denied-read was not replayed");
  expect(replayed.ops.filter(({ op }) => op === "permission")).toEqual([
    expect.objectContaining({
      request: expect.objectContaining({
        kind: "read",
        path: expect.stringMatching(/^\$APP_DATA\/thread-temp\/[^/]+\/outside-clone\.txt$/u),
      }),
      result: { kind: "reject" },
    }),
  ]);
  expect(replayed.outcomes).toEqual(["stopped"]);
  expect(replayed.events.filter(({ type }) => type === "turn.finished")).toEqual([
    expect.objectContaining({ outcome: "stopped", reason: "refused-tool" }),
  ]);
});

it.each<{
  scenario: (typeof SCENARIOS)[number];
  omitted: SessionEvent["type"];
}>([
  { scenario: "denied-read", omitted: "abort" },
  { scenario: "denied-read", omitted: "tool.execution_complete" },
])("marks $scenario failed when $omitted is missing", async ({ scenario, omitted }) => {
  const ops = readTrace(version, scenario).filter(
    (op) => op.op !== "event" || op.event.type !== omitted,
  );
  const replayed = await replay(ops, `missing-${omitted}`);
  expect(replayed.outcomes).toEqual(["failed"]);
  expect(replayed.events.filter(({ type }) => type === "turn.finished")).toEqual([
    expect.objectContaining({ outcome: "failed" }),
  ]);
});

it.each<{
  name: string;
  scenario: (typeof SCENARIOS)[number];
  beforeIdle: SessionEvent["type"][];
  afterIdle: SessionEvent["type"][];
}>([
  {
    name: "refused, no abort, not ended",
    scenario: "denied-read",
    beforeIdle: [
      "user.message",
      "assistant.turn_start",
      "assistant.message",
      "tool.execution_start",
      "tool.execution_complete",
    ],
    afterIdle: [],
  },
  {
    name: "no refusal, idle before turn_end",
    scenario: "denied-write",
    beforeIdle: ["user.message", "assistant.turn_start", "assistant.message"],
    afterIdle: [],
  },
  {
    name: "no refusal, idle right after user.message",
    scenario: "denied-write",
    beforeIdle: ["user.message"],
    afterIdle: [],
  },
  {
    name: "two idles: early idle then real end",
    scenario: "denied-write",
    beforeIdle: ["user.message"],
    afterIdle: ["assistant.turn_start", "assistant.message", "assistant.turn_end", "session.idle"],
  },
])("keeps waiting on early idle ($name)", ({ scenario, beforeIdle, afterIdle }) => {
  const ops = readTrace(version, scenario);
  const sent = ops.find((op) => op.op === "sent");
  if (!sent) throw new Error(`The ${scenario} trace must include a send.`);
  const finish = vi.fn();
  const tracker = trackTurn(
    [],
    {
      delta() {},
      thinking() {},
      toolStarted() {},
      toolFinished() {},
      requestApproval: async () => false,
    },
    finish,
  );
  const observe = (type: SessionEvent["type"]) => {
    const op = ops.find((op) => op.op === "event" && op.event.type === type);
    if (op?.op !== "event") throw new Error(`The ${scenario} trace must include ${type}.`);
    tracker.observe(op.event);
  };
  tracker.sent(sent.messageId);
  for (const type of beforeIdle) observe(type);
  observe("session.idle");
  expect(finish).not.toHaveBeenCalled();

  for (const type of afterIdle) observe(type);
  expect(finish.mock.calls).toEqual(afterIdle.length ? [[]] : []);
});

it.each([
  { ending: "plain idle", outcome: "completed" },
  { ending: "abort", outcome: "failed" },
  { ending: "aborted idle after a later successful tool", outcome: "failed" },
])("marks a refused read with a reply as $outcome after $ending", async ({ ending, outcome }) => {
  const denied = readTrace(version, "denied-read");
  const sent = denied.find((op) => op.op === "sent");
  const reply = readTrace(version, "denied-write").find(
    (op) => op.op === "event" && op.event.type === "assistant.message",
  );
  const replyEvent = reply?.op === "event" ? reply.event : undefined;
  if (!sent || replyEvent?.type !== "assistant.message") {
    throw new Error("The traces must include a sent message and a final reply.");
  }
  const laterTool = readTrace(version, "cold-resume").filter(
    (op) =>
      op.op === "event" &&
      (op.event.type === "assistant.turn_start" ||
        op.event.type === "tool.execution_start" ||
        op.event.type === "tool.execution_complete") &&
      op.event.data.turnId === "1",
  );
  const ops = denied.flatMap((op): TraceOp[] => {
    if (op.op !== "event") return [op];
    if (op.event.type === "abort") return ending === "abort" ? [op] : [];
    if (
      op.event.type === "session.idle" &&
      ending === "aborted idle after a later successful tool"
    ) {
      return [
        ...laterTool.map((step) => ({ ...step, sessionId: op.sessionId })),
        { ...op, event: { ...op.event, data: { ...op.event.data, aborted: true } } },
      ];
    }
    if (op.event.type !== "assistant.turn_end") return [op];
    return [
      {
        op: "event",
        sessionId: op.sessionId,
        event: {
          ...replyEvent,
          data: {
            ...replyEvent.data,
            originatingMessageId: sent.messageId,
            turnId: op.event.data.turnId,
          },
        },
      },
      op,
    ];
  });
  const replayed = await replay(ops, "refused-then-replied");
  expect(replayed.outcomes).toEqual([outcome]);
  if (outcome === "failed") {
    expect(replayed.events.filter(({ type }) => type === "turn.finished")).toEqual([
      expect.objectContaining({ outcome, failure: "Copilot interrupted the turn." }),
    ]);
  }
});

it("has every field trackTurn reads in at least one recorded event of that type", () => {
  const traces = [...replays.values()].filter(
    (replayed): replayed is Replayed => !(replayed instanceof Error),
  );
  expect(traces).toHaveLength(SCENARIOS.length);
  const corpus = traces.flatMap(({ ops }) =>
    ops.flatMap((op) => (op.op === "event" ? [op.event] : op.op === "history" ? op.events : [])),
  );
  const reads = new Set(traces.flatMap(({ player }) => [...player.reads]));
  const lacking = [...reads].filter((read) => {
    const [type, path = ""] = read.split(" ");
    if (Object.hasOwn(ABSENT_BY_DESIGN, path)) return false;
    return !corpus.some((event) => event.type === type && carries(event, path));
  });
  expect(lacking).toEqual([]);
});

it("holds no credential or email address and is a fixed point of the journal profile", () => {
  const files = readdirSync(tracesRoot, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".jsonl"));
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const text = readFileSync(join(tracesRoot, file), "utf8");
    expect(findLeaks(text), file).toEqual([]);
    for (const op of parseTrace(text) as unknown as JsonValue[])
      expect(journalOutputRedactor.value(op)).toEqual(op);
  }
});
