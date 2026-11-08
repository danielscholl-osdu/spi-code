// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { IdentifierSchema, ObservedAtSchema } from "./evidence.js";
import { WebUrlSchema } from "./inspect.js";

export const WatchToolSchema = z.enum(["copilot", "git", "gh", "glab"]);
export const SetupToolSchema = z.strictObject({
  tool: WatchToolSchema,
  state: z.enum([
    "missing",
    "installing",
    "ready",
    "needs-update",
    "failed",
    "signed-out",
    "scope-missing",
    "no-seat",
    "classic-token",
  ]),
  action: z.enum(["install", "signin", "attention"]).nullable(),
  version: IdentifierSchema.optional(),
  scopes: z.array(IdentifierSchema).optional(),
  missingScopes: z.array(IdentifierSchema).optional(),
  reason: IdentifierSchema.optional(),
});
export const SetupStateSchema = z
  .strictObject({
    tools: z.array(SetupToolSchema),
    watchReady: z.boolean(),
    disabledReason: IdentifierSchema.nullable(),
    checkedAt: ObservedAtSchema.optional(),
  })
  .refine(({ watchReady, disabledReason }) => watchReady === (disabledReason === null), {
    message: "Watch readiness must agree with its disabled reason",
  })
  .refine(({ tools }) => new Set(tools.map(({ tool }) => tool)).size === tools.length, {
    message: "Each tool appears once",
    path: ["tools"],
  });
export const SetupInstallSchema = z.strictObject({ tool: WatchToolSchema });
export const SetupCheckSchema = z.strictObject({});
export const SigninToolSchema = z.enum(["copilot", "gh", "glab"]);
export const SetupSigninSchema = z.discriminatedUnion("tool", [
  z.strictObject({ tool: z.enum(["copilot", "gh"]) }),
  z.strictObject({
    tool: z.literal("glab"),
    token: z
      .string()
      .min(8)
      .max(4096)
      .refine((token) => !/\s/.test(token), "Credential must not contain whitespace")
      .optional(),
  }),
]);
const signinSteps = {
  deviceCode: {
    tool: SigninToolSchema,
    state: z.literal("device-code"),
    deviceCode: IdentifierSchema,
    url: WebUrlSchema,
  },
  running: { tool: SigninToolSchema, state: z.enum(["starting", "waiting", "completed"]) },
  failed: { tool: SigninToolSchema, state: z.literal("failed"), reason: IdentifierSchema },
};
/** One step of a sign-in flow, before the host ties it to the request that started the flow. */
export const SetupSigninStepSchema = z.discriminatedUnion("state", [
  z.strictObject(signinSteps.deviceCode),
  z.strictObject(signinSteps.running),
  z.strictObject(signinSteps.failed),
]);
// requestId is the id of the setup.signin request that started the flow. It is required: host and
// window ship together, so progress without it is rejected rather than applied to any request.
const requestId = { requestId: IdentifierSchema };
export const SetupSigninCancelSchema = z.strictObject(requestId);
export const SetupSigninProgressSchema = z.discriminatedUnion("state", [
  z.strictObject({ ...signinSteps.deviceCode, ...requestId }),
  z.strictObject({ ...signinSteps.running, ...requestId }),
  z.strictObject({ ...signinSteps.failed, ...requestId }),
]);
/** The failed reason the host sends for a sign-in requested while the same flow runs. */
export const signinRunningReason = (flow: "gh" | "glab") => `A ${flow} sign-in is already running.`;
export type SetupState = z.infer<typeof SetupStateSchema>;
export type SetupSigninStep = z.infer<typeof SetupSigninStepSchema>;
export type SetupSigninProgress = z.infer<typeof SetupSigninProgressSchema>;
