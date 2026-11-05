// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import type { ReadRecord } from "../evidence/index.js";

export const readRecordSchema: z.ZodType<ReadRecord> = z.strictObject({
  source: z.string().min(1),
  object: z.string().min(1),
  observedAt: z.iso.datetime({ offset: true }),
  completeness: z.union([
    z.strictObject({ kind: z.literal("complete") }),
    z.strictObject({
      kind: z.literal("cut"), reason: z.string().min(1),
      read: z.int().nonnegative(), total: z.int().nonnegative(),
    }).refine(({ read, total }) => read <= total, "Read count exceeds total"),
  ]),
  failure: z.string().min(1).optional(),
  retainedFrom: z.iso.datetime({ offset: true }).optional(),
  inferred: z.boolean().optional(),
});
