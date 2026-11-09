// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
import { attachHostPort, type HostPort, type HostRequestQueue } from "./process/port.js";
import { WatchRoutes, watchFleet } from "./process/routes.js";
import { probeStore } from "./process/store-probe.js";
import { probeCopilotSeat } from "./setup/seat.js";
import { type SetupGit, SetupService } from "./setup/service.js";
import { openRunStore } from "./store/store.js";
import { SweepService } from "./sweep/service.js";

const stub = process.argv.includes("--stub-model");
const smoke = process.argv.includes("--smoke");
if (smoke && !stub) throw new Error("Smoke requires the stub model");
const [storePath, phase, rowId, reportPath] = process.argv
  .slice(2)
  .filter((arg) => arg !== "--stub-model" && arg !== "--smoke");
if (!storePath) throw new Error("Host requires an app-data store path");
const store = openRunStore(storePath);
if (phase) {
  if (!rowId || !reportPath) throw new Error("Smoke probe requires a row id and report path");
  probeStore(store, phase, rowId, reportPath);
}
const parentPort = (
  process as typeof process & {
    parentPort?: {
      on(event: "message", listener: (event: HostConnection) => void): void;
    };
  }
).parentPort;
if (!parentPort) throw new Error("Host must run inside an Electron utilityProcess");
const appData = dirname(storePath);
const watchPath = storePath;
const ctx = contextFromEnv(process.env);
let watchDb: DatabaseSync | undefined;
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
  process.platform === "win32" ? createWindowsGitInstaller(appData) : new MacGitInstaller(),
);
const resolveExec = memo(async () => {
  const installer = await toolInstaller();
  const git = process.platform === "win32" ? await gitInstaller() : undefined;
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
function openWatchDb(): DatabaseSync {
  if (!watchDb) {
    watchDb = new DatabaseSync(watchPath);
    watchDb.exec("PRAGMA busy_timeout = 5000");
  }
  return watchDb;
}
const watch = new WatchRoutes({
  db: openWatchDb,
  fleet: watchFleet(ctx),
  ctx,
  appData,
  exec,
  onError: console.error,
  requestSweep: () => setup.requestSweep(),
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
      db: openWatchDb(),
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
const routes = { ...watch.routes, ...setup.routes };
let activeBackend: ConversationBackend | undefined;
let connectedPort: HostPort | undefined;
let requestId = "startup";
let handler: ReturnType<typeof conversationHandler> | undefined;
const requestQueue: HostRequestQueue = { pending: Promise.resolve() };
function sendToWindow(message: Message): void {
  const parsed = parseMessage(message);
  if (!parsed.ok) throw new Error("Host generated an invalid message");
  if (!connectedPort) throw new Error("Host port is not connected");
  connectedPort.postMessage(parsed.message);
}
process.once("SIGTERM", () => {
  void setup
    .stop()
    .catch(console.error)
    .then(() => activeBackend?.stop())
    .then(
      () => process.exit(0),
      () => {
        console.error("Copilot shutdown failed");
        process.exit(1);
      },
    );
});
attachHostConnections(
  parentPort,
  (port) => {
    connectedPort = port;
    const backend = async () =>
      createConversationBackend(
        appData,
        stub,
        (event) => {
          sendToWindow({
            version: PROTOCOL_VERSION,
            id: requestId,
            kind: "event",
            type: "tool.call",
            payload: { ...event, arguments: {} },
          });
        },
        stub ? undefined : await toolInstaller(),
      );
    attachHostPort(
      port,
      process.pid,
      async (message) => {
        requestId = message.id;
        if (!handler) {
          activeBackend ??= await backend();
          handler = conversationHandler(activeBackend, sendToWindow);
        }
        await handler(message);
      },
      requestQueue,
      routes,
    );
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
process.once("exit", () => {
  watchDb?.close();
  store.close();
});
