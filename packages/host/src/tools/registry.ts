// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SessionConfig, Tool, ToolHandler, ToolInvocation } from "@github/copilot-sdk";
import { z } from "zod";
import { buildPermissionGate, buildSessionToolFilter } from "./permission-gate.js";
import { APPENDIX_A_TOOLS, type ToolMetadata } from "./tool-names.js";

export type PolicyDecision = { allowed: true } | { allowed: false; reason: string };
export type TierCheck = (
  call: ToolMetadata & { args: unknown; invocation: ToolInvocation },
) => PolicyDecision | Promise<PolicyDecision>;

const decisionSchema = z.discriminatedUnion("allowed", [
  z.strictObject({ allowed: z.literal(true) }),
  z.strictObject({ allowed: z.literal(false), reason: z.string().min(1) }),
]);

export class ToolRefusedError extends Error {
  override name = "ToolRefusedError";
}

export const checkStubTier: TierCheck = ({ tier }) => {
  switch (tier) {
    case "Read":
      return { allowed: true };
    case "Local":
      return { allowed: false, reason: "Worktree confinement ships at M5." };
    case "Command":
      return { allowed: false, reason: "Command cards and sandbox enforcement ship at M5." };
    case "Change":
    case "Consequential":
      return { allowed: false, reason: "No operator approval exists; approvals ship at M4." };
  }
};

export type GatedTool = Tool &
  ToolMetadata & {
    defer: "never";
    skipPermission: true;
    handler: ToolHandler;
  };

export function buildGatedTool<S extends z.ZodType>(
  metadata: ToolMetadata,
  argsSchema: S,
  check: TierCheck = checkStubTier,
  effect: ToolHandler<z.output<S>>,
): GatedTool {
  return {
    ...metadata,
    description: `${metadata.tier} tool; ships at ${metadata.milestone}.`,
    parameters: z.toJSONSchema(argsSchema),
    defer: "never",
    skipPermission: true,
    async handler(args, invocation) {
      const parsed = argsSchema.safeParse(args);
      if (!parsed.success) {
        throw new ToolRefusedError(`${metadata.name}: arguments refused: ${parsed.error.message}`);
      }
      let decision: PolicyDecision;
      try {
        decision = decisionSchema.parse(
          await check({ ...metadata, args: parsed.data, invocation }),
        );
      } catch (cause) {
        throw new ToolRefusedError(`${metadata.name}: refused: policy check failed.`, { cause });
      }
      if (!decision.allowed) {
        throw new ToolRefusedError(`${metadata.name}: refused: ${decision.reason}`);
      }
      return effect(parsed.data, invocation);
    },
  };
}

export type StubSessionConfig = Pick<SessionConfig, "onPermissionRequest"> & {
  tools: GatedTool[];
  availableTools: string[];
  onPermissionRequest: NonNullable<SessionConfig["onPermissionRequest"]>;
};

// The check is host-supplied, never taken from model arguments; M0 has no approval store.
export function createStubSessionConfig(check: TierCheck = checkStubTier): StubSessionConfig {
  const tools = APPENDIX_A_TOOLS.map((metadata) =>
    buildGatedTool(metadata, z.strictObject({}), check, () => `ships at ${metadata.milestone}`),
  );
  return {
    tools,
    ...buildSessionToolFilter(tools.map((tool) => tool.name)),
    onPermissionRequest: buildPermissionGate(),
  } satisfies Pick<SessionConfig, "tools" | "availableTools" | "onPermissionRequest">;
}
