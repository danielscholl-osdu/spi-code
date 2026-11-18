// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { IdentifierSchema, ObservedAtSchema } from "./evidence.js";

const RunSchema = z.strictObject({
  id: z.int().positive(),
  workflowId: z.int().positive(),
  name: IdentifierSchema,
  attempt: z.int().positive(),
  status: IdentifierSchema,
  conclusion: z.string().optional(),
  createdAt: ObservedAtSchema,
  startedAt: ObservedAtSchema.optional(),
  url: z.url({ protocol: /^https$/, hostname: /^github\.com$/ }),
  result: IdentifierSchema,
  tone: z.enum(["error", "success", "work", "neutral"]),
});

export const ServiceRunsSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("unread"), count: z.null() }),
  z.strictObject({
    kind: z.literal("read"),
    count: z.int().nonnegative(),
    cut: z.boolean(),
    workflows: z.array(
      z.strictObject({
        id: z.int().positive(),
        name: IdentifierSchema,
        runs: z.array(RunSchema).min(1),
      }),
    ),
    failing: z.array(
      z.strictObject({
        run: RunSchema,
        job: IdentifierSchema.optional(),
        step: IdentifierSchema.optional(),
      }),
    ),
  }),
]);
