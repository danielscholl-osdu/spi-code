// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { createStubSessionConfig, ToolRefusedError } from "../tools/registry.js";

export interface ToolObservation {
  callId: string;
  name: string;
  outcome: "completed" | "refused" | "error";
}

export function registrySource(observe: (event: ToolObservation) => void) {
  const config = createStubSessionConfig();
  let permissionId = 0;
  return {
    ...config,
    tools: config.tools.map((tool) => ({
      ...tool,
      async handler(args: unknown, invocation: Parameters<typeof tool.handler>[1]) {
        try {
          const result = await tool.handler(args, invocation);
          observe({ callId: invocation.toolCallId, name: tool.name, outcome: "completed" });
          return result;
        } catch (error) {
          observe({
            callId: invocation.toolCallId,
            name: tool.name,
            outcome: error instanceof ToolRefusedError ? "refused" : "error",
          });
          throw error;
        }
      },
    })),
    onPermissionRequest: async (...args: Parameters<typeof config.onPermissionRequest>) => {
      const result = await config.onPermissionRequest(...args);
      const decision = result.kind === "attributed" ? result.result : result;
      observe({
        callId: `permission-${++permissionId}`,
        name: `builtin:${args[0].kind}`,
        outcome: decision.kind === "reject" ? "refused" : "error",
      });
      return result;
    },
  };
}
