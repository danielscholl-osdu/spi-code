// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { startHost } from "./host.js";
import type { HostConnection } from "./process/connections.js";

const stub = process.argv.includes("--stub-model");
const smoke = process.argv.includes("--smoke");
const [storePath, phase, rowId, reportPath] = process.argv
  .slice(2)
  .filter((arg) => arg !== "--stub-model" && arg !== "--smoke");
if (phase && (!rowId || !reportPath))
  throw new Error("Smoke probe requires a row id and report path");

startHost({
  storePath: storePath ?? "",
  stub,
  smoke,
  parentPort: (
    process as typeof process & {
      parentPort?: { on(event: "message", listener: (event: HostConnection) => void): unknown };
    }
  ).parentPort,
  env: process.env,
  platform: process.platform,
  pid: process.pid,
  lifecycle: process,
  ...(phase && rowId && reportPath ? { probe: { phase, rowId, reportPath } } : {}),
});
