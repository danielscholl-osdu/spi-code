// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { ObservedAtSchema } from "./evidence.js";

const PullSchema = z.strictObject({ number: z.int().positive(), url: z.string() });
const SeveritySchema = z.enum(["critical", "high", "medium", "low"]);

/** Read this sweep, or not; `at` is when the rows shown were read, absent when none ever were. */
const ReadFields = { read: z.boolean(), at: ObservedAtSchema.optional() };

const PortMrSchema = z.strictObject({
  iid: z.int().positive(),
  title: z.string(),
  url: z.string(),
  mergedAt: ObservedAtSchema,
  trees: z.array(z.string()),
});
const OpenMrSchema = z.strictObject({
  iid: z.int().positive(),
  title: z.string(),
  url: z.string(),
  author: z.string().optional(),
  updatedAt: ObservedAtSchema,
});
const CommitSchema = z.strictObject({ sha: z.string(), title: z.string(), url: z.string() });

const OpenListSchema = z
  .strictObject({
    total: z.int().nonnegative(),
    shown: z.array(OpenMrSchema),
    drafts: z.int().nonnegative(),
    idle: z.int().nonnegative(),
  })
  .refine(({ total, shown, drafts, idle }) => shown.length + drafts + idle === total, {
    message: "Open upstream does not account for its total",
  });

export const ServiceUpstreamSchema = z.strictObject({
  /** Provider changes to port; null when not read this sweep. */
  count: z.int().nonnegative().nullable(),
  toPort: z.strictObject({ ...ReadFields, mrs: z.array(PortMrSchema).optional() }),
  nextSync: z.strictObject({
    ...ReadFields,
    queue: z
      .strictObject({
        behind: z.int().nonnegative(),
        head: z.string().optional(),
        held: z.strictObject({ count: z.int().positive(), pr: PullSchema }).optional(),
        next: z.array(CommitSchema),
      })
      .optional(),
  }),
  open: z.strictObject({ ...ReadFields, list: OpenListSchema.optional() }),
});

const AlertSchema = z.strictObject({
  number: z.int().positive(),
  severity: SeveritySchema.optional(),
  ruleSeverity: z.string().optional(),
  url: z.string(),
  path: z.string().optional(),
  closedPr: PullSchema.optional(),
});
const AlertRowSchema = z.strictObject({
  id: z.string(),
  source: z.enum(["dependabot", "code"]),
  group: z.enum(["spi", "upstream", "tests"]),
  tooling: z.literal(true).optional(),
  severity: SeveritySchema.optional(),
  title: z.string(),
  /** Dependabot: the version that fixes every alert in the row; null when one has none. */
  fix: z.string().nullable().optional(),
  detail: z.string().optional(),
  alerts: z.array(AlertSchema).min(1),
});

export const ServiceSecuritySchema = z.strictObject({
  /** Alerts in shipped code; null unless both lists were read this sweep. */
  count: z.int().nonnegative().nullable(),
  dependabot: z.strictObject(ReadFields),
  code: z.strictObject(ReadFields),
  rows: z.array(AlertRowSchema),
});

export const ServiceUpstreamSecuritySchema = z.strictObject({
  upstream: ServiceUpstreamSchema,
  security: ServiceSecuritySchema,
});

export type ServiceUpstream = z.infer<typeof ServiceUpstreamSchema>;
export type ServiceSecurity = z.infer<typeof ServiceSecuritySchema>;
export type ServiceAlertRow = z.infer<typeof AlertRowSchema>;
export type ServiceUpstreamSecurity = z.infer<typeof ServiceUpstreamSecuritySchema>;
