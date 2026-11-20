// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { SecurityPillSchema, SecurityRuleKeySchema, SecurityWordsSchema } from "./base.js";

/** One line of Where: a repository's files or manifests with their pills, or a list it could not read. */
export const SecurityWhereSchema = z.strictObject({
  repository: z.string(),
  /** The repository's first line, which carries its name and count. */
  first: z.boolean(),
  /** False for the line that says this repository's list was not read. */
  read: z.boolean(),
  count: SecurityWordsSchema,
  /** Its files, manifests or setting. */
  files: SecurityWordsSchema,
  /** What patches these alerts, when it differs between the rule's manifests. */
  needs: SecurityWordsSchema,
  alerts: z.array(SecurityPillSchema),
  /** Open and closed fix PRs. */
  prs: z.array(SecurityPillSchema),
  /** The pill that expands a long line in place; absent when every alert has its own pill. */
  more: z.string().optional(),
});

export const SecurityOpenedRuleSchema = z.strictObject({
  facts: z.array(z.strictObject({ label: z.string(), words: SecurityWordsSchema })),
  /** The scanner's one-line help and CWE, when the sweep read them. */
  help: z.string().optional(),
  cwe: z.string().optional(),
  where: z.array(SecurityWhereSchema),
  /** The same rule or package in the other lanes. */
  also: z.array(z.strictObject({ key: SecurityRuleKeySchema, words: SecurityWordsSchema })),
  /** The fork Ask about this is scoped to; absent when the rule has no one fork. */
  ask: z.strictObject({ fork: z.string() }).optional(),
});

export type SecurityWhere = z.infer<typeof SecurityWhereSchema>;
export type SecurityOpenedRule = z.infer<typeof SecurityOpenedRuleSchema>;
