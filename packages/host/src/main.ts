// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { dirname } from "node:path";
import { parseMessage } from "@spi-code/contracts";
import {
  type ConversationBackend,
  conversationHandler,
  createConversationBackend,
} from "./process/conversation.js";
import { attachHostPort, type HostPort } from "./process/port.js";
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
      once(event: "message", listener: (event: { data: unknown; ports: HostPort[] }) => void): void;
    };
  }
).parentPort;
if (!parentPort) throw new Error("Host must run inside an Electron utilityProcess");
let activeBackend: ConversationBackend | undefined;
process.once("SIGTERM", () => {
  void (activeBackend?.stop() ?? Promise.resolve()).then(
    () => process.exit(0),
    () => {
      console.error("Copilot shutdown failed");
      process.exit(1);
    },
  );
});
parentPort.once("message", ({ data, ports }) => {
  const parsed = parseMessage(data);
  if (!parsed.ok || parsed.message.type !== "ping")
    throw new Error("Invalid host connection message");
  const port = ports[0];
  if (ports.length !== 1 || !port) throw new Error("Host requires exactly one MessagePort");
  let requestId = "startup";
  let handler: ReturnType<typeof conversationHandler> | undefined;
  const backend = () =>
    createConversationBackend(dirname(storePath), stub, (event) => {
      const message = parseMessage({
        version: 1,
        id: requestId,
        kind: "event",
        type: "tool.call",
        payload: { ...event, arguments: {} },
      });
      if (!message.ok) throw new Error("Invalid tool observation");
      port.postMessage(message.message);
    });
  attachHostPort(port, process.pid, async (message, send) => {
    requestId = message.id;
    if (!handler) {
      activeBackend = await backend();
      handler = conversationHandler(activeBackend, send);
    }
    await handler(message);
  });
});
process.once("exit", () => store.close());
