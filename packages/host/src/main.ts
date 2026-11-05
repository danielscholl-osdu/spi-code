// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Message, PROTOCOL_VERSION, parseMessage } from "@spi-code/contracts";
import { contextFromEnv, type Exec } from "@spi-code/core";
import { createToolInstaller } from "@spi-code/tools";
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
import { openRunStore } from "./store/store.js";

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
const ctx = contextFromEnv(process.env);
let watchDb: DatabaseSync | undefined;
let hostExec: Promise<HostExec> | undefined;
function resolveExec(): Promise<HostExec> {
  hostExec ??= (async () =>
    new HostExec({
      appData,
      capturedPath: (await captureLoginShellPath()).path,
      installer: await createToolInstaller(appData),
    }))().catch((error: unknown) => {
    hostExec = undefined;
    throw error;
  });
  return hostExec;
}
const exec: Exec = {
  runJSON: async (cmd, args, opts) => (await resolveExec()).runJSON(cmd, args, opts),
  runText: async (cmd, args, opts) => (await resolveExec()).runText(cmd, args, opts),
};
// A SweepService for this fleet writes through watch.sweeper() so commits reach the subscriber.
const watch = new WatchRoutes({
  db: () => {
    if (!watchDb) {
      watchDb = new DatabaseSync(storePath);
      watchDb.exec("PRAGMA busy_timeout = 5000");
    }
    return watchDb;
  },
  fleet: watchFleet(ctx),
  ctx,
  exec,
  onError: console.error,
});
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
  void (activeBackend?.stop() ?? Promise.resolve()).then(
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
      watch.routes,
    );
  },
  console.error,
);
process.once("exit", () => {
  watchDb?.close();
  store.close();
});
