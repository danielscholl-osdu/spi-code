// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import {
  SecurityCountSchema,
  SecurityPillSchema,
  SecurityRuleKeySchema,
  SecurityWordsSchema,
} from "./base.js";

/** A rule in an opened repository: a pill that opens it in By rule, listed by file when it has many alerts here. */
export const SecurityRepoRuleSchema = z.strictObject({
  key: SecurityRuleKeySchema,
  title: z.string(),
  words: SecurityWordsSchema,
  files: z.array(
    z.strictObject({
      path: z.string(),
      words: SecurityWordsSchema,
      alerts: z.array(SecurityPillSchema),
    }),
  ),
});

export const SecurityRepoRowSchema = z.strictObject({
  repository: z.string(),
  /** A program repository opens on GitHub; a fork opens its service page. */
  program: z.boolean(),
  url: z.string(),
  /** False when a list of this repository was not read: marked ⌀. */
  read: z.boolean(),
  alerts: SecurityCountSchema,
  high: z.int().nonnegative(),
  /** Its alerts across the whole page. */
  page: SecurityWordsSchema,
  top: SecurityWordsSchema,
  rules: z.array(SecurityRepoRuleSchema),
});

export const SecurityByRepositorySchema = z.strictObject({
  /** The largest repository in this lane: the bars' scale. */
  barMax: z.int().nonnegative(),
  rows: z.array(SecurityRepoRowSchema),
  /** The repositories with nothing in this lane, on one line. */
  clean: SecurityWordsSchema,
});

export type SecurityRepoRule = z.infer<typeof SecurityRepoRuleSchema>;
export type SecurityRepoRow = z.infer<typeof SecurityRepoRowSchema>;
export type SecurityByRepository = z.infer<typeof SecurityByRepositorySchema>;
