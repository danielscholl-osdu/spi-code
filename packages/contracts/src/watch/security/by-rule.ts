// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import {
  SecurityCountSchema,
  SecurityListSchema,
  SecurityRuleKeySchema,
  SecuritySeveritySchema,
  SecurityWordsSchema,
} from "./base.js";
import { SecurityOpenedRuleSchema } from "./opened-rule.js";

/** One repository on a rule's strip; every repository on the page has one, in the pane's order. */
export const SecurityTickSchema = z.strictObject({
  repository: z.string(),
  /** False when this repository's list was not read: the tick is hatched. */
  read: z.boolean(),
  alerts: z.int().nonnegative(),
  high: z.int().nonnegative(),
  name: SecurityWordsSchema,
});

export const SecurityRuleRowSchema = z.strictObject({
  key: SecurityRuleKeySchema,
  list: SecurityListSchema,
  /** Absent for a rule that carries no severity. */
  worst: SecuritySeveritySchema.optional(),
  /** The scanner's own title. */
  title: z.string(),
  sub: SecurityWordsSchema,
  ticks: z.array(SecurityTickSchema),
  /** The line under the strip. */
  spread: SecurityWordsSchema,
  /** The strip's accessible name. */
  strip: SecurityWordsSchema,
  alerts: SecurityCountSchema,
  high: z.int().nonnegative(),
  fix: SecurityWordsSchema,
  age: SecurityWordsSchema,
  prs: SecurityWordsSchema,
  /** The repositories it sits in, by short name. */
  repositories: z.array(z.string()),
  opened: SecurityOpenedRuleSchema,
});

export const SecurityByRuleSchema = z.strictObject({
  summary: SecurityWordsSchema,
  /** The strip column's heading. */
  heading: SecurityWordsSchema,
  /** The largest count one repository holds for one rule in this lane: the ticks' scale. */
  tickMax: z.int().nonnegative(),
  /** The largest rule in this lane: the count bars' scale. */
  barMax: z.int().nonnegative(),
  rules: z.array(SecurityRuleRowSchema),
});

export type SecurityTick = z.infer<typeof SecurityTickSchema>;
export type SecurityRuleRow = z.infer<typeof SecurityRuleRowSchema>;
export type SecurityByRule = z.infer<typeof SecurityByRuleSchema>;
