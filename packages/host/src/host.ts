// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { dirname } from "node:path";
import {
  type Message,
  PROTOCOL_VERSION,
  parseMessage,
  SweepStatusSchema,
} from "@spi-code/contracts";
import { contextFromEnv, type Exec, factsSchema, GraphqlBudget } from "@spi-code/core";
import {
  createToolInstaller,
  createWindowsGitInstaller,
  MacGitInstaller,
  type ToolInstaller,
} from "@spi-code/tools";
import { z } from "zod";
import { captureLoginShellPath } from "./env/shell-environment.js";
import { HostExec } from "./exec/host-exec.js";
import { attachHostConnections, type HostConnection } from "./process/connections.js";
import {
  type ConversationBackend,
  conversationHandler,
  createConversationBackend,
} from "./process/conversation.js";
import {
  attachHostPort,
  type HostPort,
  type HostRequestQueue,
  type HostRoute,
  type HostRoutes,
} from "./process/port.js";
import { WatchRoutes, watchFleet } from "./process/routes.js";
import { probeStore } from "./process/store-probe.js";
import { probeCopilotSeat } from "./setup/seat.js";
import { type SetupGit, SetupService } from "./setup/service.js";
import { openStore } from "./store/open.js";
import { createRunStore } from "./store/store.js";
import { SweepService } from "./sweep/service.js";

export interface HostOptions {
  storePath: string;
  stub: boolean;
  smoke: boolean;
  parentPort:
    | {
        on(event: "message", listener: (event: HostConnection) => void): unknown;
      }
    | undefined;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  pid: number;
  lifecycle: Pick<NodeJS.Process, "once" | "exit">;
  probe?: { phase: string; rowId: string; reportPath: string };
}

export function startHost(options: HostOptions) {
  const { storePath, stub, smoke, parentPort, env, platform, pid, lifecycle, probe } = options;
  if (smoke && !stub) throw new Error("Smoke requires the stub model");
  if (!storePath) throw new Error("Host requires an app-data store path");
  if (!parentPort) throw new Error("Host must run inside an Electron utilityProcess");
  const db = openStore(storePath);
  if (probe) probeStore(createRunStore(db), probe.phase, probe.rowId, probe.reportPath);
  const appData = dirname(storePath);
  const ctx = contextFromEnv(env);
  function memo<T>(load: () => Promise<T>): () => Promise<T> {
    let value: Promise<T> | undefined;
    return () => {
      value ??= load().catch((error: unknown) => {
        value = undefined;
        throw error;
      });
      return value;
    };
  }
  const capturedPath = memo(async () => (await captureLoginShellPath()).path);
  const toolInstaller = memo(() => createToolInstaller(appData));
  const gitInstaller = memo<SetupGit & { binDir?: () => Promise<string | undefined> }>(async () =>
    platform === "win32" ? createWindowsGitInstaller(appData) : new MacGitInstaller(),
  );
  const resolveExec = memo(async () => {
    const installer = await toolInstaller();
    const git = platform === "win32" ? await gitInstaller() : undefined;
    // On Windows the managed Git resolves through HostExec like gh and glab, read on every call.
    const managed: Pick<ToolInstaller, "binDir"> = {
      binDir: async (tool) => (tool === "git" ? git?.binDir?.() : installer.binDir(tool)),
    };
    return new HostExec({
      appData,
      capturedPath: await capturedPath(),
      installer: managed,
      ...(git ? { managedTools: ["gh", "glab", "git"] } : {}),
    });
  });
  const exec: Exec = {
    runJSON: async (cmd, args, opts) => {
      if (smoke) throw new Error("External commands are forbidden in smoke mode");
      return (await resolveExec()).runJSON(cmd, args, opts);
    },
    runText: async (cmd, args, opts) => {
      if (smoke) throw new Error("External commands are forbidden in smoke mode");
      return (await resolveExec()).runText(cmd, args, opts);
    },
  };
  const watch = new WatchRoutes({
    db: () => db,
    fleet: watchFleet(ctx),
    ctx,
    appData,
    exec,
    onError: console.error,
    requestSweep: (request) => setup.requestSweep(request),
    sweepProgress: () => setup.progress,
  });
  const budget = new GraphqlBudget(ctx.clock);
  // Setup gates Watch: the SweepService writes through watch.sweeper() so commits reach the subscriber.
  const setup: SetupService = new SetupService({
    exec,
    tools: toolInstaller,
    git: gitInstaller,
    clock: ctx.clock,
    probeSeat: async () =>
      probeCopilotSeat({
        appDataDir: appData,
        capturedPath: await capturedPath(),
        installer: await toolInstaller(),
      }),
    sweepStatus: () => watch.status,
    refreshBudget: async (signal) => {
      const result = await exec.runJSON("gh", ["api", "rate_limit"], { timeoutMs: 5000, signal });
      if (!result.ok) throw new Error("The GitHub API budget query failed.");
      const {
        resources: { graphql },
      } = z
        .object({
          resources: z.object({
            graphql: z.object({ remaining: z.int().nonnegative(), reset: z.int().nonnegative() }),
          }),
        })
        .parse(result.data);
      return SweepStatusSchema.pick({ remaining: true, resetAt: true }).parse({
        remaining: graphql.remaining,
        resetAt: new Date(graphql.reset * 1000).toISOString(),
      });
    },
    createSweep: () =>
      new SweepService({
        db,
        fleet: watchFleet(ctx),
        appData,
        ctx,
        exec,
        budget,
        factsSchema,
        doctor: () => setup.doctor(),
        onError: console.error,
        onProgress: (progress) => watch.publishProgress(progress),
        onStatus: (status) => watch.publishStatus(status),
        createSweeper: watch.sweeper(),
      }),
    onError: console.error,
  });
  let activeBackend: ConversationBackend | undefined;
  let connectedPort: HostPort | undefined;
  let handler: ReturnType<typeof conversationHandler> | undefined;
  let stopped = false;
  let closed = false;
  let stopping: Promise<void> | undefined;
  const ports = new Map<HostPort, () => void>();
  let observeTurn: Parameters<typeof createConversationBackend>[2] | undefined;
  const requestQueue: HostRequestQueue = { pending: Promise.resolve() };
  function sendToWindow(message: Message): void {
    const parsed = parseMessage(message);
    if (!parsed.ok) throw new Error("Host generated an invalid message");
    if (!connectedPort) throw new Error("Host port is not connected");
    connectedPort.postMessage(parsed.message);
  }
  const conversation = async (message: Message) => {
    if (!handler) {
      activeBackend ??= await createConversationBackend(
        appData,
        stub,
        (event) => {
          if (!observeTurn) {
            console.error("Tool event has no active turn", event.name, event.outcome);
            return;
          }
          observeTurn(event);
        },
        stub ? undefined : await toolInstaller(),
      );
      handler = conversationHandler(activeBackend, sendToWindow);
    }
    if (stopped) throw new Error("Host is stopped");
    if (message.type === "turn.start") {
      observeTurn = (event) =>
        sendToWindow({
          version: PROTOCOL_VERSION,
          id: message.id,
          kind: "event",
          type: "tool.call",
          payload: { ...event, arguments: {} },
        });
      try {
        await handler(message);
      } finally {
        observeTurn = undefined;
      }
    } else {
      await handler(message);
    }
  };
  const registrations: HostRoutes = {
    ...watch.routes,
    ...setup.routes,
    "models.list": Object.assign((message: Message) => conversation(message), { serial: true }),
    "turn.start": Object.assign((message: Message) => conversation(message), { serial: true }),
  };
  const routes: HostRoutes = {};
  for (const [type, route] of Object.entries(registrations)) {
    if (!route) continue;
    const handle: HostRoute = (message, send) => {
      if (stopped || !connectedPort) throw new Error("Host is not connected or is stopped");
      return route(message, send);
    };
    routes[type as Message["type"]] = Object.assign(
      handle,
      route.serial === undefined ? {} : { serial: route.serial },
    );
  }
  function closeStore() {
    if (closed) return;
    closed = true;
    db.close();
  }
  function stop(): Promise<void> {
    if (stopping) return stopping;
    stopped = true;
    for (const stopPort of ports.values()) stopPort();
    stopping = setup
      .stop()
      .catch(console.error)
      .then(async () => {
        const backend = activeBackend;
        await backend?.stop();
        await requestQueue.pending;
        if (activeBackend !== backend) await activeBackend?.stop();
      })
      .finally(closeStore);
    return stopping;
  }
  lifecycle.once("SIGTERM", () => {
    void stop().then(
      () => lifecycle.exit(0),
      () => {
        console.error("Copilot shutdown failed");
        lifecycle.exit(1);
      },
    );
  });
  attachHostConnections(
    parentPort,
    (port) => {
      if (stopped) {
        port.close();
        console.error("Rejected host connection after stop");
        return;
      }
      connectedPort = port;
      (port as typeof port & { on(event: "close", listener: () => void): unknown }).on(
        "close",
        () => {
          ports.get(port)?.();
          ports.delete(port);
        },
      );
      ports.set(port, attachHostPort(port, pid, routes, requestQueue));
      if (smoke) {
        sendToWindow({
          version: PROTOCOL_VERSION,
          id: "smoke-setup",
          kind: "event",
          type: "setup.state",
          payload: {
            tools: [],
            watchReady: true,
            disabledReason: null,
            checkedAt: ctx.clock.now().toISOString(),
          },
        });
      } else setup.connect(sendToWindow);
    },
    console.error,
  );
  lifecycle.once("exit", closeStore);
  return { routes, stop };
}
