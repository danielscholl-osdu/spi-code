// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { parseMessage } from "@spi-code/contracts";
import { attachHostPort, type HostPort } from "./process/port.js";
import { probeStore } from "./process/store-probe.js";
import { openRunStore } from "./store/store.js";

const [storePath, phase, rowId, reportPath] = process.argv.slice(2);
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
parentPort.once("message", ({ data, ports }) => {
  const parsed = parseMessage(data);
  if (!parsed.ok || parsed.message.type !== "ping")
    throw new Error("Invalid host connection message");
  const port = ports[0];
  if (ports.length !== 1 || !port) throw new Error("Host requires exactly one MessagePort");
  attachHostPort(port, process.pid);
});
process.once("exit", () => store.close());
