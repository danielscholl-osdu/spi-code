// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { IdentifierSchema } from "./evidence.js";
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
  })
  .refine(({ watchReady, disabledReason }) => watchReady === (disabledReason === null), {
    message: "Watch readiness must agree with its disabled reason",
  });
export const SetupInstallSchema = z.strictObject({ tool: WatchToolSchema });
export const SigninToolSchema = z.enum(["copilot", "gh", "glab"]);
export const SetupSigninSchema = z.strictObject({ tool: SigninToolSchema });
export const SetupSigninProgressSchema = z.discriminatedUnion("state", [
  z.strictObject({
    tool: SigninToolSchema,
    state: z.literal("device-code"),
    deviceCode: IdentifierSchema,
    url: WebUrlSchema,
  }),
  z.strictObject({ tool: SigninToolSchema, state: z.enum(["starting", "waiting", "completed"]) }),
  z.strictObject({ tool: SigninToolSchema, state: z.literal("failed"), reason: IdentifierSchema }),
]);
export type SetupState = z.infer<typeof SetupStateSchema>;
export type SetupSigninProgress = z.infer<typeof SetupSigninProgressSchema>;
