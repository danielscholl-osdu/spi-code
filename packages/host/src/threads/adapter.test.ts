// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout } from "node:timers/promises";
import type { SessionEvent } from "@github/copilot-sdk";
import {
  type Message,
  PROTOCOL_VERSION,
  type ThreadWireEvent,
  todayMembers,
} from "@spi-code/contracts";
import { emptyCache } from "@spi-code/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appStyle, mixedFixtureInput } from "../../test/watch/snapshot-fixture.js";
import { CopilotRuntime, type ThreadCopilotSession } from "../copilot/runtime.js";
import { attachHostPort } from "../process/port.js";
import { WatchRoutes, watchFleet } from "../process/routes.js";
import { PrivilegedGit } from "../scopes/git.js";
import { ScopeRegistry } from "../scopes/registry.js";
import { ScopeWorkspaces } from "../scopes/workspace.js";
import { createLeaseStore } from "../store/leases.js";
import { openStore } from "../store/open.js";
import { createSnapshotStore } from "../store/snapshots.js";
import { projectWatch } from "../watch/project.js";
import { CopilotThreadAdapter } from "./adapter.js";
import type { LatestSweep } from "./context/sweep.js";
import { askingPermission } from "./permissions.js";
import { ThreadRoutes } from "./routes.js";
import { openThreadHost } from "./wiring.js";

const sandbox = { kind: "confined", backend: "seatbelt" } as const;
const synthetic =
  "Tool execution was interrupted before a result was recorded. Its effects may be absent, partial, or already complete.";

class RecordedSession {
  connected = true;
  history: SessionEvent[] = [];
  private listener?: (event: SessionEvent) => void;

  constructor(
    readonly id: string,
    readonly order: string[],
  ) {}

  readonly send = vi.fn(async () => ({
    messageId: `${this.id}-${this.send.mock.calls.length}`,
    sandbox,
  }));
  readonly abort = vi.fn(async () => {});
  readonly release = vi.fn(async () => {
    await Promise.resolve();
    this.connected = false;
    this.order.push(`released ${this.id}`);
  });
  readonly setModel = vi.fn<ThreadCopilotSession["setModel"]>(async () => "confirmed");

  get session(): ThreadCopilotSession {
    const recording = this;
    return {
      sessionId: this.id,
      sandbox,
      get connected() {
        return recording.connected;
      },
      getEvents: async () => [...this.history],
      on: ((listener: (event: SessionEvent) => void) => {
        this.listener = listener;
        return () => {
          delete this.listener;
        };
      }) as ThreadCopilotSession["on"],
      send: this.send,
      abort: this.abort,
      release: this.release,
      setModel: this.setModel,
    };
  }

  get messageId() {
    return `${this.id}-${this.send.mock.calls.length}`;
  }

  event<T extends SessionEvent["type"]>(
    type: T,
    data: Partial<Extract<SessionEvent, { type: T }>["data"]>,
  ) {
    const event = {
      type,
      data,
      id: String(this.history.length),
      parentId: null,
      timestamp: new Date().toISOString(),
    } as SessionEvent;
    this.history.push(event);
    this.listener?.(event);
  }

  begin(turnId: string) {
    this.event("user.message", { messageId: this.messageId, turnId, content: "Question" });
    this.event("assistant.turn_start", { turnId });
  }

  finish(turnId: string) {
    this.event("assistant.turn_end", { turnId });
    this.event("session.idle", {});
  }
}

let root: string;
let database: DatabaseSync;
let storePath: string;
const hosts: ThreadRoutes[] = [];
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "spi-thread-adapter-")));
  storePath = join(root, "runs.sqlite");
  database = new DatabaseSync(storePath);
});
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
  database.close();
  rmSync(root, { recursive: true, force: true });
});

function recordedRuntime(...ids: string[]) {
  const order: string[] = [];
  const sessions = ids.map((id) => new RecordedSession(id, order));
  const runtime = new CopilotRuntime({ appDataDir: root, capturedPath: "" });
  const restart = vi.spyOn(runtime, "restartThreadClient").mockImplementation(async () => {
    order.push("restart");
  });
  vi.spyOn(runtime, "stop").mockResolvedValue();
  const open = vi
    .spyOn(runtime, "openThreadSession")
    .mockImplementation(async (_workspace, options) => {
      order.push(options.resumeId ? `resume ${options.resumeId}` : "create");
      const next = sessions[open.mock.calls.length - 1];
      if (!next) throw new Error("No recorded session");
      return next.session;
    });
  return { runtime, sessions, open, restart, order };
}

function dependencies(runtime: CopilotRuntime, savedSweep: LatestSweep = () => undefined) {
  const git = new PrivilegedGit({ appData: root, capturedPath: "" });
  const workspaces = new ScopeWorkspaces(git);
  return {
    db: database,
    storePath,
    scopes: new ScopeRegistry(),
    savedSweep,
    git: async () => git,
    workspaces: () => workspaces,
    runtime: async (remember: (value: string) => void) => {
      remember("fixture-copilot-value");
      return runtime;
    },
    env: { GITLAB_TOKEN: "fixture-glab-value" },
  };
}

async function connect(
  runtime: CopilotRuntime,
  existing?: string,
  savedSweep?: LatestSweep,
  env?: NodeJS.ProcessEnv,
) {
  const options = dependencies(runtime, savedSweep);
  const host = new ThreadRoutes({ ...options, env: { ...options.env, ...env } });
  hosts.push(host);
  const output: Message[] = [];
  let receive: (event: { data: unknown }) => void = () => {};
  attachHostPort(
    {
      on: (_event, listener) => {
        receive = listener;
      },
      postMessage: (data) => {
        output.push(data as Message);
      },
      start() {},
    },
    1,
    host.routes,
  );
  let index = 0;
  function dispatch<T extends Extract<Message, { kind: "request" }>>(
    type: T["type"],
    payload: T["payload"],
  ) {
    const id = String(++index);
    receive({ data: { version: PROTOCOL_VERSION, id, kind: "request", type, payload } });
    return id;
  }
  async function response(id: string) {
    return vi.waitFor(
      () => {
        const result = output.find((entry) => entry.id === id && entry.kind === "response");
        if (!result) throw new Error("Waiting for response");
        return result;
      },
      { interval: 5, timeout: 2500 },
    );
  }
  const threadId =
    existing ??
    (await response(dispatch("thread.start", { scope: "program" })).then((result) => {
      if (result.type !== "thread.started") throw new Error("Thread did not start");
      return result.payload.threadId;
    }));
  if (!threadId) throw new Error("Missing thread ID");
  dispatch("thread.subscribe", { threadId, fromSequence: 0 });
  return {
    host,
    threadId,
    dispatch,
    response,
    send: (message: Extract<Message, { type: "thread.send" }>["payload"]["message"]) =>
      dispatch("thread.send", { threadId, message }),
    stop: () => dispatch("thread.stop", { threadId }),
    events: () =>
      output.flatMap((entry): ThreadWireEvent[] =>
        entry.type === "thread.events" ? entry.payload.events : [],
      ),
  };
}

it("stops the SDK stream, records partial text as not known and releases before resuming the ID", async () => {
  const {
    runtime,
    sessions: [first, second],
    open,
    order,
  } = recordedRuntime("sdk-old", "sdk-old");
  if (!first || !second) throw new Error("Incomplete recording");
  const port = await connect(runtime);
  const firstSend = port.send({
    prompt: "Count slowly",
    model: "selected",
    reasoningEffort: "medium",
  });
  await vi.waitFor(() => expect(first.send).toHaveBeenCalledOnce());
  first.begin("first");
  first.event("assistant.message_start", { messageId: "partial" });
  first.event("assistant.message_delta", {
    messageId: "partial",
    deltaContent: "Visible partial\n",
  });
  await vi.waitFor(() =>
    expect(port.events()).toContainEqual(
      expect.objectContaining({
        type: "assistant.delta",
        text: "Visible partial\n",
      }),
    ),
  );
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const originalRelease = first.release.getMockImplementation();
  first.release.mockImplementationOnce(async () => {
    await held;
    await originalRelease?.();
  });
  const stopping = port.stop();
  await vi.waitFor(() => expect(first.release).toHaveBeenCalledOnce());
  const next = port.send({ prompt: "Continue" });
  try {
    await vi.waitFor(() =>
      expect(port.events()).toContainEqual(
        expect.objectContaining({
          type: "message.sent",
          message: expect.objectContaining({ prompt: "Continue" }),
        }),
      ),
    );
    await setTimeout(1550);
    expect(open).toHaveBeenCalledOnce();
  } finally {
    release();
  }
  expect(await port.response(stopping)).toMatchObject({ type: "thread.stopped" });
  expect(await port.response(firstSend)).toMatchObject({ payload: { outcome: "stopped" } });
  expect(first.abort).toHaveBeenCalledOnce();
  expect(port.events()).toContainEqual(
    expect.objectContaining({
      type: "turn.finished",
      outcome: "stopped",
      partialTextSeen: "not known",
    }),
  );
  await vi.waitFor(() => expect(second.send).toHaveBeenCalledOnce());
  expect(
    open.mock.calls.map(([, options]) => ({
      model: options.model,
      effort: options.reasoningEffort,
      resume: options.resumeId,
    })),
  ).toEqual([
    { model: "selected", effort: "medium", resume: undefined },
    { model: "selected", effort: "medium", resume: "sdk-old" },
  ]);
  expect(order).toEqual(["create", "released sdk-old", "resume sdk-old"]);
  second.begin("second");
  second.finish("second");
  expect(await port.response(next)).toMatchObject({ payload: { outcome: "completed" } });
});

it("waits for a stopped session open to release before starting the queued turn", async () => {
  const {
    runtime,
    sessions: [first, second],
    open,
    order,
  } = recordedRuntime("slow-open", "queued");
  if (!first || !second) throw new Error("Incomplete recording");
  const adapter = CopilotThreadAdapter.prototype as unknown as { open(): Promise<unknown> };
  using enterOpen = vi.spyOn(adapter, "open");
  let unblock = () => {};
  const held = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  open.mockImplementationOnce(async () => {
    order.push("opening");
    await held;
    return first.session;
  });
  const port = await connect(runtime);
  const firstSend = port.send({ prompt: "Open a session" });
  await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
  const stopping = port.stop();
  const next = port.send({ prompt: "Run after stop" });
  try {
    expect(await port.response(stopping)).toMatchObject({ type: "thread.stopped" });
    await vi.waitFor(() => expect(enterOpen).toHaveBeenCalledTimes(2));
    expect(open).toHaveBeenCalledOnce();
  } finally {
    unblock();
  }
  expect(await port.response(firstSend)).toMatchObject({ payload: { outcome: "stopped" } });
  await vi.waitFor(() => expect(second.send).toHaveBeenCalledOnce());
  expect(first.send).not.toHaveBeenCalled();
  expect(order).toEqual(["opening", "released slow-open", "create"]);
  second.begin("0");
  second.finish("0");
  expect(await port.response(next)).toMatchObject({ payload: { outcome: "completed" } });
});

it("tracks tools when the same warm session restarts turn numbering at zero", async () => {
  const {
    runtime,
    sessions: [session],
    open,
  } = recordedRuntime("warm");
  if (!session) throw new Error("Incomplete recording");
  const port = await connect(runtime);
  for (const [index, callId] of ["first-read", "second-read"].entries()) {
    const response = port.send({ prompt: `Question ${index + 1}` });
    await vi.waitFor(() => expect(session.send).toHaveBeenCalledTimes(index + 1));
    session.event("user.message", { messageId: session.messageId, content: "Question" });
    session.event("assistant.turn_start", { turnId: "0" });
    if (index === 1) {
      session.event("tool.execution_start", {
        toolName: "view",
        turnId: "0",
        toolCallId: "first-read",
      });
    }
    session.event("tool.execution_start", { toolName: "view", turnId: "0", toolCallId: callId });
    session.event("tool.execution_complete", {
      turnId: "0",
      toolCallId: callId,
      success: true,
      result: { content: callId },
    });
    session.finish("0");
    expect(await port.response(response)).toMatchObject({ payload: { outcome: "completed" } });
  }
  expect(open).toHaveBeenCalledOnce();
  expect(port.events().filter(({ type }) => type === "tool.started")).toMatchObject([
    { callId: "first-read" },
    { callId: "second-read" },
  ]);
  expect(port.events().filter(({ type }) => type === "tool.finished")).toMatchObject([
    { callId: "first-read", result: "first-read" },
    { callId: "second-read", result: "second-read" },
  ]);
});

it("restarts after disconnect, keeps tool effects unknown and drops a synthetic completion in the next turn", async () => {
  const {
    runtime,
    sessions: [before, after],
    restart,
    order,
  } = recordedRuntime("sdk-fixed", "sdk-fixed", "sdk-fixed");
  if (!before || !after) throw new Error("Incomplete recording");
  const port = await connect(runtime);
  const first = port.send({ prompt: "Read this" });
  await vi.waitFor(() => expect(before.send).toHaveBeenCalledOnce());
  before.begin("first");
  before.event("tool.execution_start", {
    toolName: "view",
    toolCallId: "old-call",
    turnId: "first",
  });
  before.connected = false;
  expect(await port.response(first)).toMatchObject({ payload: { outcome: "failed" } });
  expect(restart).toHaveBeenCalledOnce();
  expect(order).toEqual(["create", "released sdk-fixed", "restart"]);
  expect(port.events()).toContainEqual(
    expect.objectContaining({
      type: "turn.finished",
      failure: "Copilot disconnected. The in-flight tool effects are not known.",
    }),
  );
  expect(port.events()).toContainEqual(
    expect.objectContaining({
      type: "tool.cancelled",
      callId: "old-call",
      effectState: "not known",
    }),
  );

  after.history = [...before.history];
  const followUp = port.send({ prompt: "What happened?" });
  await vi.waitFor(() => expect(after.send).toHaveBeenCalledOnce());
  expect(order).toEqual(["create", "released sdk-fixed", "restart", "resume sdk-fixed"]);
  after.begin("second");
  after.event("tool.execution_start", {
    toolName: "view",
    toolCallId: "new-call",
    turnId: "second",
  });
  after.event("tool.execution_complete", {
    toolCallId: "new-call",
    turnId: "first",
    success: false,
    error: { message: synthetic },
  });
  after.event("tool.execution_complete", {
    toolCallId: "old-call",
    turnId: "first",
    success: false,
    error: { message: synthetic },
  });
  after.event("tool.execution_complete", {
    toolCallId: "new-call",
    turnId: "second",
    success: false,
    result: { content: synthetic },
  });
  after.event("tool.execution_complete", {
    toolCallId: "new-call",
    turnId: "second",
    success: true,
    result: { content: "File read" },
  });
  after.event("assistant.turn_end", { turnId: "second" });
  after.event("assistant.turn_start", { turnId: "third" });
  after.event("assistant.message_start", { messageId: "reply" });
  after.event("assistant.message_delta", {
    messageId: "reply",
    deltaContent: "Reply after the read\n",
  });
  await vi.waitFor(() =>
    expect(port.events()).toContainEqual(
      expect.objectContaining({
        type: "assistant.delta",
        text: "Reply after the read\n",
      }),
    ),
  );
  after.finish("third");
  expect(await port.response(followUp)).toMatchObject({ payload: { outcome: "completed" } });
  expect(port.events().filter((event) => event.type === "tool.finished")).toMatchObject([
    { callId: "new-call", outcome: "completed", result: "File read" },
  ]);
});

it("keeps model and effort on a warm session, and tells the thread when the SDK history is missing", async () => {
  const {
    runtime,
    sessions: [first],
  } = recordedRuntime("previous");
  if (!first) throw new Error("Incomplete recording");
  const port = await connect(runtime);
  const ask = async (turnId: string, message: Parameters<typeof port.send>[0]) => {
    const id = port.send(message);
    await vi.waitFor(() => expect(first.send).toHaveBeenCalledTimes(Number(turnId)));
    first.begin(turnId);
    first.finish(turnId);
    expect(await port.response(id)).toMatchObject({ payload: { outcome: "completed" } });
  };
  await ask("1", { prompt: "One", model: "one", reasoningEffort: "medium" });
  await ask("2", { prompt: "Two", model: "two", reasoningEffort: "low" });
  await ask("3", { prompt: "Three", reasoningEffort: "high" });
  expect(first.setModel.mock.calls).toEqual([
    ["two", "low"],
    ["two", "high"],
  ]);
  await port.host.stop();
  const nextRuntime = recordedRuntime("unavailable", "replacement");
  const replacement = nextRuntime.sessions[1];
  if (!replacement) throw new Error("Incomplete recording");
  nextRuntime.open.mockRejectedValueOnce(new Error("Session not found: previous"));
  const nextPort = await connect(nextRuntime.runtime, port.threadId);
  const id = nextPort.send({ prompt: "Continue despite the lost history" });
  await vi.waitFor(() => expect(replacement.send).toHaveBeenCalledOnce());
  expect(
    nextRuntime.open.mock.calls.map(([, options]) => [
      options.resumeId,
      options.model,
      options.reasoningEffort,
    ]),
  ).toEqual([
    ["previous", "two", "high"],
    [undefined, "two", "high"],
  ]);
  replacement.begin("fresh");
  replacement.finish("fresh");
  expect(await nextPort.response(id)).toMatchObject({ payload: { outcome: "completed" } });
  expect(nextPort.events()).toContainEqual(
    expect.objectContaining({ type: "tool.started", name: "session.replaced" }),
  );
});

it("records unconfirmed Auto effort once and resumes with desired settings after a failed switch", async () => {
  const {
    runtime,
    sessions: [first, second],
    open,
  } = recordedRuntime("auto", "auto");
  if (!first || !second) throw new Error("Incomplete recording");
  first.setModel.mockResolvedValueOnce("not known");
  first.setModel.mockRejectedValueOnce(new Error("Model switch failed."));
  const port = await connect(runtime);
  const ask = async (
    prompt: string,
    session: RecordedSession,
    count: number,
    reasoningEffort?: "high",
  ) => {
    const id = port.send({ prompt, ...(reasoningEffort ? { reasoningEffort } : {}) });
    await vi.waitFor(() => expect(session.send).toHaveBeenCalledTimes(count));
    session.begin(prompt);
    session.finish(prompt);
    expect(await port.response(id)).toMatchObject({ payload: { outcome: "completed" } });
  };
  await ask("first", first, 1);
  await ask("effort", first, 2, "high");
  await ask("unchanged", first, 3);
  expect(first.setModel.mock.calls).toEqual([["auto", "high"]]);
  expect(port.events()).toContainEqual(
    expect.objectContaining({ type: "tool.finished", result: { reasoningEffort: "not known" } }),
  );

  const failure = await port.response(
    port.send({ prompt: "Switch", model: "picked", reasoningEffort: "high" }),
  );
  expect(failure).toMatchObject({ payload: { outcome: "failed" } });
  await ask("resumed", second, 1);
  expect(first.setModel.mock.calls).toEqual([
    ["auto", "high"],
    ["picked", "high"],
  ]);
  expect(open.mock.calls[1]?.[1]).toMatchObject({
    model: "picked",
    reasoningEffort: "high",
    resumeId: "auto",
  });
});

function savedFixtureSweep(releaseObject = "password: readable fixture-copilot-value") {
  openStore(storePath).close();
  const input = appStyle(mixedFixtureInput());
  const now = input.context.clock.now().getTime();
  const fleet = watchFleet(input.context);
  const owner = "fixture-sweeper";
  const fence = createLeaseStore(database).acquire(fleet, owner, 60_000, now);
  if (fence === undefined) throw new Error("No sweep lease");
  const releaseRecords = input.releaseRecords.map((record) =>
    record.source === "github-releases" ? { ...record, object: releaseObject } : record,
  );
  const view = projectWatch(input);
  createSnapshotStore(database).writeSnapshot(
    { fleet, owner, fence },
    {
      facts: input.facts,
      cache: { ...emptyCache(), releases: { ...input.releases, records: releaseRecords } },
      reads: input.reads,
    },
    view,
    now,
  );
  const watch = new WatchRoutes({
    db: () => database,
    fleet,
    ctx: input.context,
    appData: input.appData,
    exec: {
      runJSON: vi.fn(() => {
        throw new Error("Unexpected forge read");
      }),
      runText: vi.fn(() => {
        throw new Error("Unexpected forge read");
      }),
    },
    onError: (error) => {
      throw error;
    },
  });
  return { watch, view };
}

it("lets an Asking turn read journal-redacted SPI evidence using each host-known credential source", async () => {
  const env = {
    COPILOT_GITHUB_TOKEN: "fixture-copilot-env",
    GH_TOKEN: "fixture-gh-env",
    GITHUB_TOKEN: "fixture-github-env",
    GITLAB_TOKEN: "fixture-glab-value",
    GLAB_TOKEN: "fixture-glab-env",
    GITLAB_ACCESS_TOKEN: "fixture-gitlab-access",
  };
  const known = [...Object.values(env), "fixture-copilot-value", "fixture-signin-value"];
  const { watch, view } = savedFixtureSweep(known.join(" "));
  const {
    runtime,
    sessions: [session],
    open,
  } = recordedRuntime("spi-read");
  if (!session) throw new Error("Incomplete recording");
  const port = await connect(runtime, undefined, watch.savedSweep, env);
  port.host.remember("fixture-signin-value");
  const id = port.send({
    prompt: "Question",
    attachments: [{ name: "context:releases", content: '{"token":"fake-short"}' }],
  });
  await vi.waitFor(() => expect(session.send).toHaveBeenCalledOnce());
  session.begin("spi-read-turn");
  const config = open.mock.calls[0]?.[1];
  const tool = config?.tools?.find(({ name }) => name === "spi_evidence");
  const handler = tool?.handler;
  if (!config || !tool || !handler) throw new Error("SPI evidence was not offered");
  expect(config.systemMessage).toMatchObject({
    content: expect.stringContaining("- spi_evidence: "),
  });
  expect(session.send).toHaveBeenCalledWith({
    prompt: 'context:releases\n{"token":"[redacted]"}\n\nQuestion',
  });
  expect(tool.skipPermission).toBe(false);
  const readEvidence = async (path: string) => {
    const args = { path };
    const invocation = {
      sessionId: session.id,
      toolCallId: path,
      toolName: tool.name,
      arguments: args,
    };
    await expect(
      config.onPermissionRequest(
        { kind: "custom-tool", toolName: tool.name, toolDescription: "Evidence", args },
        invocation,
      ),
    ).resolves.toEqual({ kind: "approve-once" });
    return JSON.parse(String(await handler(args, invocation)));
  };
  expect(await readEvidence("/releases/lines")).toMatchObject({
    sweptAt: view.sweptAt,
    reads: expect.arrayContaining([
      expect.objectContaining({
        collector: "releases",
        source: "github-releases",
        object: known.map(() => "[redacted]").join(" "),
      }),
    ]),
  });
  expect(await readEvidence("/services/2/home/stations/0")).toMatchObject({
    reads: expect.arrayContaining([expect.objectContaining({ collector: "github" })]),
  });
  session.finish("spi-read-turn");
  await expect(port.response(id)).resolves.toMatchObject({ payload: { outcome: "completed" } });
});

it("lets Asking use SPI read tools only through the permission request handler", async () => {
  const {
    runtime,
    sessions: [session],
    open,
  } = recordedRuntime("spi-change");
  if (!session) throw new Error("Incomplete recording");
  const port = await connect(runtime);
  const id = port.send({ prompt: "Question" });
  await vi.waitFor(() => expect(session.send).toHaveBeenCalledOnce());
  session.begin("spi-change-turn");
  const config = open.mock.calls[0]?.[1];
  if (!config?.onPermissionDenied) throw new Error("Missing sandbox denial observer");
  const invocation = { sessionId: session.id };
  await expect(
    config.onPermissionRequest(
      {
        kind: "custom-tool",
        toolName: "merge_pr",
        toolDescription: "Merge a pull request",
        skipPermission: true,
      },
      invocation,
    ),
  ).resolves.toEqual({ kind: "reject" });
  const spiRead = {
    kind: "custom-tool",
    toolName: "spi_brief",
    toolDescription: "Read Today",
  } as const;
  await expect(config.onPermissionRequest(spiRead, invocation)).resolves.toEqual({
    kind: "approve-once",
  });
  await expect(config.onPermissionDenied(spiRead, invocation)).resolves.toEqual({ kind: "reject" });
  session.finish("spi-change-turn");
  await port.response(id);
  expect(port.events().filter(({ type }) => type === "approval.resolved")).toMatchObject([
    { approved: false },
    { approved: true },
    { approved: false },
  ]);
});

it("denies and journals Asking permissions and redacts named model and journal fields", async () => {
  const {
    runtime,
    sessions: [session],
    open,
  } = recordedRuntime("permissions");
  if (!session) throw new Error("Incomplete recording");
  const port = await connect(runtime);
  const id = port.send({ prompt: "Question" });
  await vi.waitFor(() => expect(session.send).toHaveBeenCalledOnce());
  session.begin("permission-turn");
  const config = open.mock.calls[0]?.[1];
  if (!config?.onPermissionDenied) throw new Error("Missing sandbox denial observer");
  const invoke = { sessionId: session.id };
  expect(
    await config.onPermissionDenied(
      {
        kind: "shell",
        fullCommandText: "echo fixture-copilot-value",
        commands: [],
        hasWriteFileRedirection: false,
        intention: "Test",
        possiblePaths: [],
        possibleUrls: [],
        canOfferSessionApproval: false,
      },
      invoke,
    ),
  ).toEqual({ kind: "reject" });
  expect(
    await config.onPermissionRequest(
      {
        kind: "write",
        canOfferSessionApproval: false,
        diff: "",
        fileName: "fixture-glab-value",
        intention: "Test",
      },
      invoke,
    ),
  ).toEqual({ kind: "reject" });
  const hook = await config.hooks?.onPostToolUse?.(
    {
      workingDirectory: root,
      sessionId: session.id,
      timestamp: new Date(),
      toolName: "view",
      toolArgs: { unused: "fixture-copilot-value" },
      toolResult: {
        resultType: "success",
        textResultForLlm: "password: readable fixture-copilot-value",
      },
    },
    invoke,
  );
  expect(hook).toEqual({
    modifiedResult: { resultType: "success", textResultForLlm: "password: readable [redacted]" },
  });
  // A malformed SDK result makes the redactor throw. The hook must still replace it.
  await expect(
    Promise.resolve().then(() =>
      config.hooks?.onPostToolUse?.(
        {
          workingDirectory: root,
          sessionId: session.id,
          timestamp: new Date(),
          toolName: "view",
          toolArgs: {},
          toolResult: {
            resultType: "success",
            textResultForLlm: "password: readable fixture-copilot-value",
            error: {} as unknown as string,
          },
        },
        invoke,
      ),
    ),
  ).resolves.toEqual({
    modifiedResult: { resultType: "failure", textResultForLlm: "Tool result withheld." },
  });
  session.event("tool.execution_start", {
    toolName: "view",
    toolCallId: "view",
    turnId: "permission-turn",
    arguments: { secret: "fixture-copilot-value" },
    model: "do-not-journal",
  });
  session.event("tool.execution_complete", {
    toolCallId: "view",
    turnId: "permission-turn",
    success: true,
    result: { content: "password: demo", detailedContent: "password: demo fixture-glab-value" },
    model: "do-not-journal",
  });
  session.finish("permission-turn");
  await port.response(id);
  const events = port.events();
  expect(events.filter(({ type }) => type === "approval.resolved")).toMatchObject([
    { approved: false },
    { approved: false },
  ]);
  expect(events.filter(({ type }) => type === "tool.finished")).toMatchObject([
    { result: "password: [redacted]" },
  ]);
  expect(JSON.stringify(events)).not.toMatch(
    /fixture-copilot-value|fixture-glab-value|do-not-journal/,
  );
});

function askingFiles() {
  const managed = join(root, "ManagedRepos");
  const clone = join(managed, "CloneCheckout");
  const tempPath = join(root, "scratch");
  const outsideDir = join(managed, "CloneCheckoutOutside");
  for (const directory of [clone, tempPath, outsideDir]) mkdirSync(directory, { recursive: true });
  const file = join(clone, "ReadMe.md");
  const outside = join(outsideDir, "OutsideReadme.md");
  writeFileSync(file, "Public");
  writeFileSync(outside, "Outside");
  writeFileSync(join(tempPath, "scratch.txt"), "Scratch");
  const requestApproval = vi.fn(async (_request, allowed: boolean | undefined) => allowed === true);
  const events = { requestApproval, delta() {}, toolStarted() {}, toolFinished() {} };
  function read(path: string, resolvedPath?: string, clonePath = clone) {
    return askingPermission({ clonePath, tempPath }, () => events)(
      {
        kind: "read",
        intention: "read",
        path,
        ...(resolvedPath === undefined ? {} : { resolvedPath }),
      },
      { sessionId: "sdk" },
    );
  }
  return { clone, file, managed, outside, outsideDir, read, tempPath };
}

it("approves an inside read with a matching attested path", async () => {
  const { file, read } = askingFiles();
  await expect(read("ReadMe.md", file)).resolves.toEqual({ kind: "approve-once" });
});

it("approves an inside read with a case variant on a case-insensitive disk", async ({ skip }) => {
  const { file, read } = askingFiles();
  const variant = join(root, "managedrepos", "clonecheckout", "readme.md");
  if (!existsSync(variant)) skip("The fixture volume is case-sensitive");
  expect(realpathSync.native(variant)).toBe(realpathSync.native(file));
  await expect(read(variant, file)).resolves.toEqual({ kind: "approve-once" });
});

it("approves an attested case variant of the same inside file", async ({ skip }) => {
  const { file, read } = askingFiles();
  const variant = join(root, "managedrepos", "clonecheckout", "readme.md");
  if (!existsSync(variant)) skip("The fixture volume is case-sensitive");
  await expect(read(file, variant)).resolves.toEqual({ kind: "approve-once" });
});

it("refuses a read that walks out of the clone with ..", async () => {
  const { clone, outside, read } = askingFiles();
  const traversal = ["..", "CloneCheckoutOutside", "OutsideReadme.md"].join(sep);
  expect(realpathSync.native(`${clone}${sep}${traversal}`)).toBe(outside);
  await expect(read(traversal)).resolves.toEqual({ kind: "reject" });
});

it("refuses a read through a symlink inside the clone that points outside", async () => {
  const { clone, outsideDir, read } = askingFiles();
  symlinkSync(outsideDir, join(clone, "linked"), "junction");
  await expect(read(join("linked", "OutsideReadme.md"))).resolves.toEqual({ kind: "reject" });
});

it("refuses a read whose .. follows a symlink outside the clone on POSIX", async ({ skip }) => {
  if (process.platform === "win32") skip("Win32 normalizes .. before traversing the path");
  const { clone, outsideDir, read } = askingFiles();
  const child = join(outsideDir, "child");
  mkdirSync(child);
  writeFileSync(join(outsideDir, "ReadMe.md"), "Outside");
  symlinkSync(child, join(clone, "linked"), "dir");
  const traversal = ["linked", "..", "ReadMe.md"].join(sep);
  expect(realpathSync.native(`${clone}${sep}${traversal}`)).toBe(join(outsideDir, "ReadMe.md"));
  await expect(read(traversal)).resolves.toEqual({ kind: "reject" });
});

it.skipIf(process.platform === "win32").each([
  { label: "absolute", relative: false, depth: 2, target: "secret.txt" },
  { label: "relative", relative: true, depth: 2, target: "secret.txt" },
  { label: "absolute into scratch", relative: false, depth: 3, target: "scratch.txt" },
])("refuses a $label read when symlink traversal and lexical resolution disagree", async (row) => {
  const { clone, managed, read, tempPath } = askingFiles();
  const tail = row.target === "scratch.txt" ? ["scratch", row.target] : [row.target];
  const physical = join(clone, "inside", ...tail);
  const lexical =
    row.target === "scratch.txt" ? join(tempPath, row.target) : join(managed, row.target);
  const linked = join(clone, "inside", ...Array.from({ length: row.depth }, () => "child"));
  mkdirSync(linked, { recursive: true });
  mkdirSync(dirname(physical), { recursive: true });
  symlinkSync(linked, join(clone, "linked"), "dir");
  writeFileSync(physical, "Inside");
  writeFileSync(lexical, "Outside");
  const traversal = ["linked", ...Array.from({ length: row.depth }, () => ".."), ...tail].join(sep);
  const absolute = `${clone}${sep}${traversal}`;
  expect(realpathSync.native(absolute)).toBe(physical);
  expect(realpathSync.native(join(clone, traversal))).toBe(lexical);
  await expect(read(row.relative ? traversal : absolute)).resolves.toEqual({ kind: "reject" });
});

it("approves an inside read when a parent of the clone is symlinked", async () => {
  const { file, managed, read } = askingFiles();
  const alias = join(root, "alias");
  symlinkSync(managed, alias, "junction");
  const throughAlias = join(alias, "CloneCheckout");
  await expect(read(file, join(throughAlias, "ReadMe.md"), throughAlias)).resolves.toEqual({
    kind: "approve-once",
  });
});

it("refuses a missing requested path", async () => {
  const { read } = askingFiles();
  await expect(read("Missing.md")).resolves.toEqual({ kind: "reject" });
});

it("refuses a missing attested path", async () => {
  const { clone, file, read } = askingFiles();
  await expect(read(file, join(clone, "Missing.md"))).resolves.toEqual({ kind: "reject" });
});

it("refuses an attested resolvedPath outside the clone", async () => {
  const { file, outside, read } = askingFiles();
  await expect(read(file, outside)).resolves.toEqual({ kind: "reject" });
});

it("refuses an attested resolvedPath that names a different file inside the clone", async () => {
  const { clone, file, read } = askingFiles();
  const other = join(clone, "Other.md");
  writeFileSync(other, "Different file");
  await expect(read(file, other)).resolves.toEqual({ kind: "reject" });
});

it("refuses a read in sandbox scratch space outside the clone", async () => {
  const { read, tempPath } = askingFiles();
  await expect(read(join(tempPath, "scratch.txt"))).resolves.toEqual({ kind: "reject" });
});

function shortName(path: string, alias: string): string {
  execFileSync("fsutil.exe", ["file", "setshortname", path, alias]);
  const short = join(dirname(path), alias);
  expect(realpathSync.native(short)).toBe(realpathSync.native(path));
  return short;
}

it("refuses a Windows rooted read without a drive", async ({ skip }) => {
  if (process.platform !== "win32") skip("A Windows drive root is required");
  const { read } = askingFiles();
  const clone = mkdtempSync(join(process.cwd(), ".asking-drive-"));
  try {
    const file = join(clone, "ReadMe.md");
    writeFileSync(file, "Inside");
    const driveLess = file.slice(2);
    expect(realpathSync.native(driveLess)).toBe(realpathSync.native(file));
    await expect(read(driveLess, undefined, clone)).resolves.toEqual({ kind: "reject" });
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
});

it("approves a Windows 8.3 spelling of an inside path", async ({ skip }) => {
  if (process.platform !== "win32") skip("Windows NTFS 8.3 names are required");
  const { clone, file, read } = askingFiles();
  const alias = join(shortName(clone, "CLONEC~9"), "ReadMe.md");
  await expect(read(alias, file)).resolves.toEqual({ kind: "approve-once" });
});

it("refuses a Windows 8.3 spelling of an outside path", async ({ skip }) => {
  if (process.platform !== "win32") skip("Windows NTFS 8.3 names are required");
  const { clone, outside, outsideDir, read } = askingFiles();
  shortName(outside, "OUTSID~9.MD");
  symlinkSync(outsideDir, join(clone, "linked"), "junction");
  const alias = join(clone, "linked", "OUTSID~9.MD");
  expect(realpathSync.native(alias)).toBe(realpathSync.native(outside));
  await expect(read(alias)).resolves.toEqual({ kind: "reject" });
});

it("gives the thread journal one writer and releases the lock on shutdown", async () => {
  const { runtime } = recordedRuntime();
  const options = dependencies(runtime);
  const first = openThreadHost(options);
  const other = new DatabaseSync(storePath);
  const id = first.engine.create({ scope: "program" });
  try {
    expect(() => openThreadHost({ ...options, db: other })).toThrow(/locked/iu);
    await first.stop();
    const reopened = openThreadHost({ ...options, db: other });
    expect(reopened.engine.list().map(({ id }) => id)).toEqual([id]);
    await reopened.stop();
  } finally {
    await first.stop();
    other.close();
  }
});

it("packs a row's chip from the saved sweep, says why it refuses one, and keeps the row a thread started from", async () => {
  const { runtime } = recordedRuntime();
  const unsaved = await connect(runtime);
  await expect(
    unsaved.response(unsaved.dispatch("thread.chip", { id: "anything" })),
  ).resolves.toMatchObject({
    type: "thread.chip.result",
    payload: { ok: false, id: "anything", reason: "No sweep has been saved." },
  });
  await unsaved.host.stop();

  const { watch, view } = savedFixtureSweep();
  const port = await connect(runtime, undefined, watch.savedSweep);
  const member = todayMembers(view.briefing)[0]?.member;
  if (!member) throw new Error("Fixture has no Today member");
  const packed = await port.response(port.dispatch("thread.chip", { id: member.id }));
  if (packed.type !== "thread.chip.result" || !packed.payload.ok)
    throw new Error(`Chip refused: ${JSON.stringify(packed.payload)}`);
  expect(packed.payload).toMatchObject({
    id: member.id,
    sweptAt: view.sweptAt,
    attachment: { name: `context:${member.id}` },
  });
  expect(JSON.parse(packed.payload.attachment.content)).toMatchObject({
    id: member.id,
    sweptAt: view.sweptAt,
  });
  await expect(
    port.response(port.dispatch("thread.chip", { id: "place:environment" })),
  ).resolves.toMatchObject({
    payload: {
      ok: false,
      reason: expect.stringContaining("place:environment cannot be a chip yet"),
    },
  });

  const started = await port.response(
    port.dispatch("thread.start", { scope: "program", title: "Why", subject: member.id }),
  );
  if (started.type !== "thread.started") throw new Error("Thread did not start");
  const listed = await port.response(port.dispatch("threads.list", {}));
  if (listed.type !== "threads.result") throw new Error("Threads were not listed");
  expect(listed.payload.threads).toContainEqual(
    expect.objectContaining({
      id: started.payload.threadId,
      thread: { scope: "program", title: "Why", subject: member.id },
    }),
  );
});

it("refuses a send whose bytes would differ from the preview, and sends the fresh preview's bytes", async () => {
  const { watch, view } = savedFixtureSweep();
  const {
    runtime,
    sessions: [session],
  } = recordedRuntime("fresh-preview");
  if (!session) throw new Error("Incomplete recording");
  const member = todayMembers(view.briefing)[0]?.member;
  if (!member) throw new Error("Fixture has no Today member");
  const credential = 'fixture"rotated';
  const title = `Café · ${credential}`;
  const savedSweep: LatestSweep = () => {
    const saved = watch.savedSweep();
    if (!saved) return;
    return {
      ...saved,
      async inspect(id) {
        const answer = await saved.inspect(id);
        if (answer) return { ...answer, result: { ...answer.result, title } };
      },
    };
  };
  const port = await connect(runtime, undefined, savedSweep);
  const chip = async () => {
    const packed = await port.response(port.dispatch("thread.chip", { id: member.id }));
    if (packed.type !== "thread.chip.result" || !packed.payload.ok)
      throw new Error(`Chip refused: ${JSON.stringify(packed.payload)}`);
    expect(packed.payload.bytes).toBe(Buffer.byteLength(packed.payload.attachment.content));
    return packed.payload.attachment;
  };
  const start = () =>
    port.response(
      port.dispatch("thread.start", { scope: "program", title: "Why", subject: member.id }),
    );
  const stale = {
    type: "error",
    payload: {
      code: "stale_preview",
      message: expect.stringContaining("changed since its preview"),
    },
  };

  const previewed = await chip();
  expect(JSON.parse(previewed.content)).toMatchObject({ title });
  await expect(start()).resolves.toMatchObject({ type: "thread.started" });
  const listed = async () => {
    const result = await port.response(port.dispatch("threads.list", {}));
    return result.type === "threads.result" ? result.payload.threads.length : -1;
  };
  const threads = await listed();

  port.host.remember(credential);
  await expect(start()).resolves.toMatchObject(stale);
  expect(await listed()).toBe(threads);
  await expect(
    port.response(port.send({ prompt: "Why", attachments: [previewed] })),
  ).resolves.toMatchObject(stale);
  expect(session.send).not.toHaveBeenCalled();

  const fresh = await chip();
  expect(JSON.parse(fresh.content)).toMatchObject({ title: "Café · [redacted]" });
  await expect(start()).resolves.toMatchObject({ type: "thread.started" });
  const attached = { name: "context:previous-reading", content: JSON.stringify({ title }) };
  const sent = port.send({ prompt: "Why", attachments: [fresh, attached] });
  await vi.waitFor(() => expect(session.send).toHaveBeenCalledOnce());
  expect(session.send).toHaveBeenCalledWith({
    prompt: `${fresh.name}\n${fresh.content}\n\n${attached.name}\n{"title":"Café · [redacted]"}\n\nWhy`,
  });
  session.begin("fresh-turn");
  session.finish("fresh-turn");
  await expect(port.response(sent)).resolves.toMatchObject({ payload: { outcome: "completed" } });
});
