// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout } from "node:timers/promises";
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
}, 120_000);

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
