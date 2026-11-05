// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  const result =
    request.method === "initialize"
      ? {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "spicode_sentinel", version: "1" },
        }
      : request.method === "tools/list"
        ? {
            tools: [
              {
                name: "spicode_sentinel",
                description: "Isolation sentinel",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          }
        : {};
  console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
}
