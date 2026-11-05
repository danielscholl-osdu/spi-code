// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { parseMessage } from "@spi-code/contracts";
import type { HostPort } from "./port.js";

type TransferredPort = HostPort & { close(): void };
export interface HostConnection {
  data: unknown;
  ports: TransferredPort[];
}

export function attachHostConnections(
  parent: { on(event: "message", listener: (event: HostConnection) => void): unknown },
  connect: (port: TransferredPort) => void,
  log: (message: string) => void,
): void {
  let current: TransferredPort | undefined;
  parent.on("message", ({ data, ports }) => {
    const parsed = parseMessage(data);
    const port = ports[0];
    if (!parsed.ok || parsed.message.type !== "ping" || ports.length !== 1 || !port) {
      for (const rejected of ports) rejected.close();
      log("Rejected invalid host connection: expected a ping and exactly one MessagePort");
      return;
    }
    current?.close();
    current = port;
    connect(port);
  });
}
