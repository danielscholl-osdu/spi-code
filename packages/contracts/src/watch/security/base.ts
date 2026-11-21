// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";

/** Whose move it is: shipped SPI code, shipped upstream code, or tests, tooling and settings. */
export const SecurityLaneIdSchema = z.enum(["spi", "upstream", "tests"]);
export const SecurityListSchema = z.enum(["dependabot", "code"]);
export const SecuritySeveritySchema = z.enum(["critical", "high", "medium", "low"]);

/** Drawn with ≥ when an unread list could change it; a count from lists all read is exact. */
export const SecurityCountSchema = z.strictObject({
  n: z.int().nonnegative(),
  atLeast: z.boolean(),
});

/** Words drawn in order. A count is never written into a string; code is a rule id, path or version. */
export const SecurityWordsSchema = z.array(
  z.union([z.string(), SecurityCountSchema, z.strictObject({ code: z.string() })]),
);

/** A rule or package in one lane, keyed as alertRows keys its rows: `spi:dep:<package>`, `tests:code:<tool>:<rule>`. */
export const SecurityRuleKeySchema = z.string().regex(/^(spi|upstream|tests):(dep|code):.+$/);

/** A rule's own subject for Ask about this and its context chip: this prefix, then its key. */
export const SECURITY_RULE_SUBJECT = "security-rule:";

/** A mark that leaves the app: an alert or a fix PR on GitHub. */
export const SecurityPillSchema = z.strictObject({
  label: z.string(),
  url: z.string(),
  /** High or critical; drawn bold. */
  heavy: z.boolean(),
  /** Its tooltip and accessible name, naming the repository. */
  name: z.string(),
});

export type SecurityLaneId = z.infer<typeof SecurityLaneIdSchema>;
export type SecurityList = z.infer<typeof SecurityListSchema>;
export type SecuritySeverity = z.infer<typeof SecuritySeveritySchema>;
export type SecurityCount = z.infer<typeof SecurityCountSchema>;
export type SecurityWords = z.infer<typeof SecurityWordsSchema>;
export type SecurityRuleKey = z.infer<typeof SecurityRuleKeySchema>;
export type SecurityPill = z.infer<typeof SecurityPillSchema>;
