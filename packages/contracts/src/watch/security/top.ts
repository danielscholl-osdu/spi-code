// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import {
  SecurityCountSchema,
  SecurityLaneIdSchema,
  SecurityRuleKeySchema,
  SecurityWordsSchema,
} from "./base.js";

export const SecurityPageSchema = z.strictObject({
  /** Open alerts by scanner, in GitHub's terms. */
  totals: SecurityWordsSchema,
  headline: SecurityWordsSchema,
  /** The lists not read, named once; empty when every list was read. */
  banner: SecurityWordsSchema,
  /** The lane the page opens on. */
  opens: SecurityLaneIdSchema,
  /** The longest lane's alerts: the three bars' one scale. */
  barMax: z.int().nonnegative(),
  /** The hatched stub's tooltip and accessible name; empty when every list was read. */
  stub: SecurityWordsSchema,
  legend: z.strictObject({
    high: z.string(),
    rest: z.string(),
    /** Absent when every list was read. */
    unread: z.string().optional(),
  }),
});

export const SecurityBlockSchema = z.strictObject({
  /** One rule for a block of its own; every rule in the block the rest of a lane share. */
  rules: z.array(SecurityRuleKeySchema).min(1),
  alerts: SecurityCountSchema,
  /** High or critical, the solid part from the block's left. */
  high: z.int().nonnegative(),
  /** A divider at each boundary between its rules, as fractions of the block from its left, in order. */
  dividers: z.array(z.number().gt(0).lt(1)),
  /** Its tooltip and accessible name. */
  name: SecurityWordsSchema,
});

export const SecurityFigureSchema = z.strictObject({
  label: z.string(),
  who: z.string(),
  /** Beside the lane total: how many are high or critical. */
  high: SecurityWordsSchema,
  blocks: z.array(SecurityBlockSchema),
  /** Said once in the bar of a lane with nothing; empty otherwise. */
  empty: SecurityWordsSchema,
});

export type SecurityPage = z.infer<typeof SecurityPageSchema>;
export type SecurityBlock = z.infer<typeof SecurityBlockSchema>;
export type SecurityFigure = z.infer<typeof SecurityFigureSchema>;
