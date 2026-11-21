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
  /** Its tooltip and accessible name. */
  name: SecurityWordsSchema,
  /** Its alerts here as pills when they are few; empty when they are listed by file. */
  alerts: z.array(SecurityPillSchema),
  files: z.array(
    z.strictObject({
      path: z.string(),
      words: SecurityWordsSchema,
      alerts: z.array(SecurityPillSchema),
      /** The pill that expands this file's alerts in place; absent when each alert has its own pill. */
      more: SecurityWordsSchema.optional(),
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
  /** Under its name: how many are high or critical, and which list was not read; empty when neither. */
  sub: SecurityWordsSchema,
  /** Its alerts across the whole page. */
  page: SecurityWordsSchema,
  /** The tooltip of its alerts across the page, by scanner. */
  pageName: SecurityWordsSchema,
  top: SecurityWordsSchema,
  rules: z.array(SecurityRepoRuleSchema),
  /** The line an opened row ends with when a list was not read; empty otherwise. */
  unread: SecurityWordsSchema,
});

export const SecurityByRepositorySchema = z.strictObject({
  columns: z.strictObject({ repository: z.string(), alerts: z.string(), top: z.string() }),
  /** The largest repository in this lane: the bars' scale. */
  barMax: z.int().nonnegative(),
  rows: z.array(SecurityRepoRowSchema),
  /** The repositories with nothing in this lane, on one line. */
  clean: SecurityWordsSchema,
  /** The line cut to its first names, with the disclosure that draws all of it; absent when it is short. */
  cleanShort: z.strictObject({ words: SecurityWordsSchema, more: SecurityWordsSchema }).optional(),
});

export type SecurityRepoRule = z.infer<typeof SecurityRepoRuleSchema>;
export type SecurityRepoRow = z.infer<typeof SecurityRepoRowSchema>;
export type SecurityByRepository = z.infer<typeof SecurityByRepositorySchema>;
