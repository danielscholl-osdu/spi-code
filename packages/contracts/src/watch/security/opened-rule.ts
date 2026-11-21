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

export const SecurityAdvisorySchema = z.strictObject({
  /** The CVE or GHSA id, drawn bold. */
  id: z.string(),
  /** Its severity and summary. */
  words: SecurityWordsSchema,
  /** Its first patched version and how many alerts it raised. */
  fix: SecurityWordsSchema,
});

/** A package's advisories in order: the first shown, the rest behind a disclosure. */
export const SecurityAdvisoriesSchema = z.strictObject({
  preview: z.array(SecurityAdvisorySchema).min(1),
  rest: z.array(SecurityAdvisorySchema),
  /** "N more advisories" and "Fewer advisories"; absent when there is no rest. */
  disclosure: z.strictObject({ more: SecurityWordsSchema, fewer: SecurityWordsSchema }).optional(),
});

export const SecurityOpenedRuleSchema = z.strictObject({
  facts: z.array(
    z.strictObject({
      label: z.string(),
      words: SecurityWordsSchema,
      /** The package's advisories, drawn as this fact's body. */
      advisories: SecurityAdvisoriesSchema.optional(),
    }),
  ),
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
export type SecurityAdvisory = z.infer<typeof SecurityAdvisorySchema>;
export type SecurityAdvisories = z.infer<typeof SecurityAdvisoriesSchema>;
export type SecurityOpenedRule = z.infer<typeof SecurityOpenedRuleSchema>;
