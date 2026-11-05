// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Message, PROTOCOL_VERSION, parseMessage } from "@spi-code/contracts";
import { contextFromEnv, type Exec, type Facts } from "@spi-code/core";
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
const [storePath, phase, rowId, reportPath] = process.argv
  .slice(2)
  .filter((arg) => arg !== "--stub-model");
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
  runJSON: async (cmd, args, opts) => (await resolveExec()).runJSON(cmd, args, opts),
  runText: async (cmd, args, opts) => (await resolveExec()).runText(cmd, args, opts),
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
  exec,
  onError: console.error,
});
// Setup gates Watch: the SweepService writes through watch.sweeper() so commits reach the subscriber.
const setup: SetupService = new SetupService({
  exec,
  tools: toolInstaller,
  git: gitInstaller,
  probeSeat: async () =>
    probeCopilotSeat({
      appDataDir: appData,
      capturedPath: await capturedPath(),
      readToken: async () => {
        const result = await exec.runText("gh", ["auth", "token", "--hostname", "github.com"], {
          timeoutMs: 5000,
        });
        const token = result.ok ? result.data.trim() : "";
        if (!token) throw new Error("gh did not return a GitHub token.");
        return token;
      },
    }),
  createSweep: () =>
    new SweepService({
      db: openWatchDb(),
      fleet: watchFleet(ctx),
      appData,
      ctx,
      exec,
      factsSchema: z.custom<Facts>((value) => typeof value === "object" && value !== null),
      doctor: () => setup.doctor(),
      onError: console.error,
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
    const backend = () =>
      createConversationBackend(dirname(storePath), stub, (event) => {
        sendToWindow({
          version: PROTOCOL_VERSION,
          id: requestId,
          kind: "event",
          type: "tool.call",
          payload: { ...event, arguments: {} },
        });
      });
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
    setup.connect(sendToWindow);
  },
  console.error,
);
process.once("exit", () => {
  watchDb?.close();
  store.close();
});
