// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { register } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SessionEvent } from "@github/copilot-sdk";
import {
  type Message,
  PROTOCOL_VERSION,
  type ThreadWireEvent,
} from "../packages/contracts/dist/index.js";
import { emptyCache } from "../packages/core/dist/index.js";
import {
  compareTraces,
  findLeaks,
  protectedChanges,
  usageAround,
} from "../packages/host/build/traces/relations.js";
import {
  type HostOp,
  installedSdkVersion,
  readTrace,
  SCENARIOS,
  type Scenario,
  type TraceOp,
  tracePath,
} from "../packages/host/build/traces/trace.js";
import { CopilotRuntime } from "../packages/host/dist/copilot/runtime.js";
import { attachHostPort } from "../packages/host/dist/process/port.js";
import { WatchRoutes, watchFleet } from "../packages/host/dist/process/routes.js";
import { PrivilegedGit } from "../packages/host/dist/scopes/git.js";
import { ScopeRegistry } from "../packages/host/dist/scopes/registry.js";
import { ScopeWorkspaces } from "../packages/host/dist/scopes/workspace.js";
import { createLeaseStore } from "../packages/host/dist/store/leases.js";
import { openStore } from "../packages/host/dist/store/open.js";
import { createSnapshotStore } from "../packages/host/dist/store/snapshots.js";
import { chipFromSweep, snapshotChips } from "../packages/host/dist/threads/context/draft.js";
import { ThreadRoutes } from "../packages/host/dist/threads/routes.js";
import { projectWatch } from "../packages/host/dist/watch/project.js";
import { createToolOutputRedactor, type JsonValue } from "../packages/threads/dist/index.js";

const usage =
  "Usage: node scripts/copilot-trace.ts [--record] [scenario ...]\n" +
  "Runs the named scenarios (all when none is named) on the signed-in Copilot runtime.\n" +
  "Without --record it compares each run with packages/host/test/traces/<sdk>/; with it, it writes them.";
const args = process.argv.slice(2);
const record = args.includes("--record");
const named = args.filter((arg) => !arg.startsWith("--"));
if (args.includes("--help") || named.some((name) => !SCENARIOS.includes(name as Scenario))) {
  console.log(usage);
  process.exit(args.includes("--help") ? 0 : 2);
}
const chosen = (named.length ? named : SCENARIOS) as readonly Scenario[];
const sdk = installedSdkVersion();
const turnTimeoutMs = 180_000;
const scope = "partition";
const host = new URL("../packages/host/", import.meta.url).href;

// The compiled test fixtures import host sources; run those from the host's dist.
register(
  `data:text/javascript,${encodeURIComponent(`export function resolve(specifier, context, next) {
  const from = context.parentURL ?? "";
  if (from.startsWith(${JSON.stringify(`${host}build/`)}) && specifier.startsWith(".")) {
    const url = new URL(specifier, from).href;
    if (url.startsWith(${JSON.stringify(`${host}src/`)}))
      return next(${JSON.stringify(`${host}dist/`)} + url.slice(${`${host}src/`.length}), context);
  }
  return next(specifier, context);
}`)}`,
);
const { appStyle, mixedFixtureInput } = (await import(
  "../packages/host/build/watch/snapshot-fixture.js"
)) as typeof import("../packages/host/build/watch/snapshot-fixture.js");
const PIN = ["repos", "azure", "osdu-spi-partition", "checkout", "README.md"];
const LONG = 2000;

function readCredential(): string {
  const stored = execFileSync(
    "/usr/bin/security",
    ["find-generic-password", "-s", "gh:github.com", "-w"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 },
  ).trim();
  const wrapper = "go-keyring-base64:";
  const token = stored.startsWith(wrapper)
    ? Buffer.from(stored.slice(wrapper.length), "base64").toString("utf8")
    : stored;
  if (!token) throw new Error("Credential unavailable");
  return token;
}

type Op<K extends TraceOp["op"]> = Extract<TraceOp, { op: K }>;
type SendOp = Extract<HostOp, { action: "send" }>;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

class Recorder {
  ops: TraceOp[] = [];
  log<T extends TraceOp>(op: T): T {
    this.ops.push(op);
    return op;
  }
}

function recording(runtime: CopilotRuntime, recorder: Recorder) {
  const open = runtime.openThreadSession.bind(runtime);
  runtime.openThreadSession = async (workspace, options) => {
    let sessionId = "";
    const permission =
      (handler: "request" | "denied", inner: typeof options.onPermissionRequest) =>
      async (...call: Parameters<typeof options.onPermissionRequest>) => {
        const op = recorder.log<Op<"permission">>({
          op: "permission",
          sessionId: sessionId || call[1].sessionId,
          handler,
          request: clone(call[0]),
        });
        const result = await inner(...call);
        op.result = clone(result);
        return result;
      };
    const session = await open(workspace, {
      ...options,
      onPermissionRequest: permission("request", options.onPermissionRequest),
      ...(options.onPermissionDenied
        ? { onPermissionDenied: permission("denied", options.onPermissionDenied) }
        : {}),
      ...(options.tools
        ? {
            tools: options.tools.map(({ handler, ...tool }) => ({
              ...tool,
              handler: async (...call: Parameters<NonNullable<typeof handler>>) => {
                recorder.log({
                  op: "tool",
                  sessionId,
                  name: tool.name,
                  toolCallId: call[1].toolCallId,
                  arguments: clone(call[0] ?? null),
                });
                if (!handler) throw new Error("The tool has no handler.");
                return handler(...call);
              },
            })),
          }
        : {}),
    });
    sessionId = session.sessionId;
    recorder.log({
      op: "open",
      sessionId,
      ...(options.resumeId === undefined ? {} : { resumeId: options.resumeId }),
    });
    session.on((event: SessionEvent) => {
      recorder.log({ op: "event", sessionId, event: clone(event) });
    });
    return {
      sessionId,
      get connected() {
        return session.connected;
      },
      get sandbox() {
        return session.sandbox;
      },
      on: session.on,
      async getEvents() {
        const events = await session.getEvents();
        recorder.log({ op: "history", sessionId, events: clone(events) });
        return events;
      },
      abort() {
        recorder.log({ op: "abort", sessionId });
        return session.abort();
      },
      async setModel(model, reasoningEffort) {
        const op = recorder.log<Op<"setModel">>({
          op: "setModel",
          sessionId,
          model,
          ...(reasoningEffort ? { reasoningEffort } : {}),
        });
        const result = await session.setModel(model, reasoningEffort);
        op.result = result;
        return result;
      },
      async send(message) {
        recorder.log({ op: "send", sessionId });
        const sent = await session.send(message);
        recorder.log({
          op: "sent",
          sessionId,
          messageId: sent.messageId,
          sandbox: clone(sent.sandbox),
        });
        return sent;
      },
      release() {
        recorder.log({ op: "release", sessionId });
        return session.release();
      },
    };
  };
}

type Live = Awaited<ReturnType<typeof liveHarness>>;

async function liveHarness(token: string) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "spi-copilot-trace-"));
  const storePath = join(directory, "runs.sqlite");
  openStore(storePath).close();
  const db = new DatabaseSync(storePath);
  const capturedPath = process.env.PATH ?? "/usr/bin:/bin";
  const git = new PrivilegedGit({ appData: directory, capturedPath });

  const input = appStyle(mixedFixtureInput());
  const now = input.context.clock.now().getTime();
  const fleet = watchFleet(input.context);
  const fence = createLeaseStore(db).acquire(fleet, "trace-sweeper", 60_000, now);
  if (fence === undefined) throw new Error("No sweep lease");
  createSnapshotStore(db).writeSnapshot(
    { fleet, owner: "trace-sweeper", fence },
    {
      facts: input.facts,
      cache: { ...emptyCache(), releases: input.releases },
      reads: input.reads,
    },
    projectWatch(input),
    now,
  );
  const watch = new WatchRoutes({
    db: () => db,
    fleet,
    ctx: input.context,
    appData: input.appData,
    exec: {
      runJSON: () => {
        throw new Error("Unexpected forge read");
      },
      runText: () => {
        throw new Error("Unexpected forge read");
      },
    },
    onError: (error) => {
      throw error;
    },
  });

  const recorder = new Recorder();
  let host: ThreadRoutes | undefined;
  let receive: (event: { data: unknown }) => void = () => {};
  const replies = new Map<string, (message: Message) => void>();
  let events: ThreadWireEvent[] = [];
  let index = 0;

  function connect() {
    const routes = new ThreadRoutes({
      db,
      storePath,
      scopes: new ScopeRegistry(),
      savedSweep: watch.savedSweep,
      env: {},
      git: async () => git,
      workspaces: (runner) => new ScopeWorkspaces(runner),
      runtime: async (onCredential) => {
        const runtime = new CopilotRuntime(
          { appDataDir: directory, capturedPath, onCredential },
          async () => token,
        );
        recording(runtime, recorder);
        return runtime;
      },
    });
    attachHostPort(
      {
        on: (_event, listener) => {
          receive = listener;
        },
        start: () => {},
        postMessage: (message: Message) => {
          if (message.type === "thread.events") events.push(...message.payload.events);
          if (message.kind === "response") replies.get(message.id)?.(message);
        },
      },
      process.pid,
      routes.routes,
    );
    host = routes;
  }

  function dispatch(type: string, payload: unknown, id = `trace-${++index}`) {
    receive({ data: { version: PROTOCOL_VERSION, id, kind: "request", type, payload } });
    return id;
  }

  function request(type: string, payload: unknown): Promise<Message> {
    const id = `trace-${++index}`;
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      new Promise<Message>((resolve) => {
        replies.set(id, resolve);
        dispatch(type, payload, id);
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${type} timed out`)), turnTimeoutMs);
      }),
    ]).finally(() => {
      clearTimeout(timer);
      replies.delete(id);
    });
  }

  function outcomeOf(message: Message): string {
    return message.type === "thread.sent" ? message.payload.outcome : message.type;
  }

  connect();
  return {
    directory,
    watch,
    begin() {
      recorder.ops = [];
      events = [];
      return recorder;
    },
    events: () => events,
    async start() {
      const started = await request("thread.start", { scope });
      if (started.type !== "thread.started") throw new Error("Could not start the thread");
      const { threadId } = started.payload;
      dispatch("thread.subscribe", { threadId, fromSequence: 0 });
      return threadId;
    },
    async send(
      threadId: string,
      prompt: string,
      attachments: { name: string; content: string }[] = [],
    ): Promise<string> {
      const op = recorder.log<SendOp>({
        op: "host",
        action: "send",
        prompt,
        ...(attachments.length
          ? {
              attachments: attachments.map(({ name, content }) => ({
                name,
                bytes: Buffer.byteLength(content),
              })),
            }
          : {}),
      });
      const response = await request("thread.send", {
        threadId,
        message: { prompt, ...(attachments.length ? { attachments } : {}) },
      });
      op.outcome = outcomeOf(response);
      return op.outcome;
    },
    async sendAndStop(threadId: string, prompt: string) {
      const op = recorder.log<SendOp>({ op: "host", action: "send", prompt });
      const sending = request("thread.send", { threadId, message: { prompt } });
      const deadline = Date.now() + turnTimeoutMs;
      while (
        events.filter(({ type }) => type === "assistant.delta").length < 2 &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      recorder.log({ op: "host", action: "stop" } satisfies HostOp);
      const stopped = await request("thread.stop", { threadId });
      op.outcome = outcomeOf(await sending);
      return { outcome: op.outcome, stopped: stopped.type };
    },
    async restart(threadId: string) {
      recorder.log({ op: "host", action: "restart" } satisfies HostOp);
      await host?.stop();
      connect();
      dispatch("thread.subscribe", { threadId, fromSequence: 0 });
    },
    async close() {
      try {
        await host?.stop();
      } finally {
        db.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

const read = (live: Live, marker: string) => {
  const file = join(live.directory, ...PIN);
  return `Make two file view tool calls, one at a time and never in parallel. First view lines 1 to 3 of ${file}. Only after that result returns, view lines 4 to 6 of the same file. Read no other file. Then reply with the exact text ${marker} and nothing else.`;
};

const scenarios: Record<Scenario, (live: Live) => Promise<string[]>> = {
  async "two-messages"(live) {
    const thread = await live.start();
    return [
      await live.send(thread, read(live, "TRACE-ONE")),
      await live.send(thread, read(live, "TRACE-TWO")),
    ];
  },
  async "cold-resume"(live) {
    const thread = await live.start();
    const first = await live.send(thread, read(live, "TRACE-BEFORE"));
    await live.restart(thread);
    return [first, await live.send(thread, read(live, "TRACE-AFTER"))];
  },
  async "stop-mid-stream"(live) {
    const thread = await live.start();
    const { outcome } = await live.sendAndStop(
      thread,
      "Without using any tool, count from 1 to 400 with one number per line.",
    );
    return [outcome];
  },
  async "spi-tool"(live) {
    const thread = await live.start();
    const chip = await chipFromSweep(live.watch.savedSweep, "place:releases", {
      value: (value: JsonValue) => value,
    });
    if (!chip.ok) throw new Error(chip.reason);
    const snapshot = snapshotChips([chip.chip]);
    if (!snapshot.ok) throw new Error(snapshot.reason);
    return [
      await live.send(thread, "Reply with the exact text TRACE-READY and nothing else."),
      await live.send(
        thread,
        "Call the spi_evidence tool once with the path /releases/lines. Then reply with the exact text TRACE-SPI and nothing else.",
        snapshot.attachments,
      ),
    ];
  },
  async "denied-read"(live) {
    const thread = await live.start();
    const scratch = join(live.directory, "thread-temp", thread);
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    const file = join(scratch, "outside-clone.txt");
    writeFileSync(file, "Synthetic trace fixture outside the clone.\n");
    const outcome = await live.send(
      thread,
      `View ${file} with your file view tool, using that path exactly as written. If the read is refused, reply with the exact text TRACE-REFUSED and nothing else.`,
    );
    if (
      outcome !== "stopped" ||
      !live
        .events()
        .some((event) => event.type === "turn.finished" && event.reason === "refused-tool")
    ) {
      throw new Error("The outside read did not stop the turn after a refused tool call.");
    }
    return [outcome];
  },
  async "denied-write"(live) {
    const thread = await live.start();
    return [
      await live.send(
        thread,
        "Create a new file named trace-probe.txt in the working directory containing the word hello. If you cannot, reply with the exact text TRACE-DENIED and nothing else.",
      ),
    ];
  },
};

function finalize(ops: TraceOp[], token: string, directory: string): TraceOp[] {
  const home = homedir();
  const original = JSON.parse(
    JSON.stringify(ops).replaceAll(directory, "$APP_DATA").replaceAll(home, "~"),
  ) as JsonValue[];
  const { journal } = createToolOutputRedactor([token]);
  const redacted = original.map((op) => journal.value(op));
  const changed = protectedChanges(original, redacted);
  if (changed.length) throw new Error(`Redaction changed protected fields: ${changed.join(", ")}`);
  const text = JSON.stringify(redacted);
  if (text.includes(token)) throw new Error("The trace holds the session credential.");
  const leaks = findLeaks(text);
  if (leaks.length) throw new Error(`The trace holds ${leaks.join(", ")}.`);
  return redacted.map(shorten) as TraceOp[];
}

/** Long prose (system prompts, snapshots) keeps its type and length but not its text. */
function shorten(value: JsonValue): JsonValue {
  if (typeof value === "string")
    return value.length > LONG ? `${value.slice(0, 200)}… [${value.length} chars]` : value;
  if (Array.isArray(value)) return value.map(shorten);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, shorten(entry)]));
  return value;
}

let token = "";
function diagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown error";
  const redacted = token ? message.replaceAll(token, "[redacted]") : message;
  return findLeaks(redacted).length ? "[redacted]" : redacted;
}

let live: Live | undefined;
let failed = false;
try {
  token = readCredential();
  live = await liveHarness(token);
  for (const scenario of chosen) {
    const recorder = live.begin();
    recorder.log({ op: "trace", scenario, sdk, scope });
    let outcomes: string[];
    try {
      outcomes = await scenarios[scenario](live);
    } catch (error) {
      failed = true;
      console.log(`${scenario}: failed (${diagnostic(error)})`);
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const opened = new Set(recorder.ops.flatMap((op) => (op.op === "open" ? [op.sessionId] : [])));
    const own = recorder.ops.filter((op) => !("sessionId" in op) || opened.has(op.sessionId));
    const ops = finalize(own, token, live.directory);
    console.log(`${scenario}: ${outcomes.join(", ")}`);
    if (scenario === "spi-tool") {
      for (const line of usageAround(ops)) console.log(`  ${line}`);
    }
    if (record) {
      const path = tracePath(sdk, scenario);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, `${ops.map((op) => JSON.stringify(op)).join("\n")}\n`);
      console.log(`  wrote ${path.slice(path.indexOf("packages/"))}`);
    } else {
      let recorded: TraceOp[];
      try {
        recorded = readTrace(sdk, scenario);
      } catch {
        failed = true;
        console.log(`  no recorded trace for Copilot SDK ${sdk}; run with --record`);
        continue;
      }
      const { order, relations } = compareTraces(recorded, ops);
      for (const line of order) console.log(`  order: ${line}`);
      for (const line of relations) console.log(`  relation: ${line}`);
      if (relations.length) failed = true;
      if (!order.length && !relations.length) console.log("  matches the recorded trace");
    }
  }
} catch (error) {
  failed = true;
  console.error(`Copilot trace failed: ${diagnostic(error)}`);
} finally {
  try {
    await live?.close();
  } catch {
    console.error("Copilot trace could not shut down cleanly");
    failed = true;
  }
}
process.exitCode = failed ? 1 : 0;
