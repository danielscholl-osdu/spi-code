// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { dirname } from "node:path";
import { type Message, PROTOCOL_VERSION, parseMessage } from "@spi-code/contracts";
import { attachHostConnections, type HostConnection } from "./process/connections.js";
import {
  type ConversationBackend,
  conversationHandler,
  createConversationBackend,
} from "./process/conversation.js";
import { attachHostPort, type HostPort, type HostRequestQueue } from "./process/port.js";
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
    );
  },
  console.error,
);
process.once("exit", () => store.close());
