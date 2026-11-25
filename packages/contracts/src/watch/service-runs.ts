// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { IdentifierSchema, ObservedAtSchema } from "./evidence.js";

const RunSchema = z.strictObject({
  id: z.int().positive(),
  workflowId: z.int().positive(),
  name: IdentifierSchema,
  path: IdentifierSchema.optional(),
  branch: IdentifierSchema.optional(),
  attempt: z.int().positive(),
  status: IdentifierSchema,
  conclusion: z.string().optional(),
  createdAt: ObservedAtSchema,
  startedAt: ObservedAtSchema.optional(),
  updatedAt: ObservedAtSchema.optional(),
  url: z.url({ protocol: /^https$/, hostname: /^github\.com$/ }),
  result: IdentifierSchema,
  tone: z.enum(["error", "success", "work", "neutral"]),
});

const LabelSchema = z.strictObject({
  result: RunSchema.shape.result,
  tone: RunSchema.shape.tone,
  at: ObservedAtSchema,
  branch: IdentifierSchema.optional(),
});

/** A view saved before strips carried a label names no branch, so it reads its latest run on any branch. */
function unscopedLabel(runs: readonly z.infer<typeof RunSchema>[]): z.infer<typeof LabelSchema> {
  const { result, tone, startedAt, createdAt } = runs[runs.length - 1] as z.infer<typeof RunSchema>;
  return { result, tone, at: startedAt ?? createdAt };
}

export const ServiceRunsSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("unread"), count: z.null() }),
  z.strictObject({
    kind: z.literal("read"),
    count: z.int().nonnegative(),
    cut: z.boolean(),
    workflows: z.array(
      z
        .strictObject({
          id: z.int().positive(),
          name: IdentifierSchema,
          runs: z.array(RunSchema).min(1),
          label: LabelSchema.optional(),
          automation: z.literal(true).optional(),
        })
        .transform(({ label, ...workflow }) => ({
          ...workflow,
          label: label ?? unscopedLabel(workflow.runs),
        })),
    ),
    failing: z.array(
      z.strictObject({
        run: RunSchema.partial({ workflowId: true }),
        job: IdentifierSchema.optional(),
        step: IdentifierSchema.optional(),
        main: z
          .strictObject({
            id: RunSchema.shape.id,
            attempt: RunSchema.shape.attempt,
            url: RunSchema.shape.url,
            failedAt: ObservedAtSchema.optional(),
          })
          .optional(),
      }),
    ),
  }),
]);
