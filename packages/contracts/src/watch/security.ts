// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { ObservedAtSchema, ReadRecordSchema } from "./evidence.js";
import { SecurityCountSchema, SecurityLaneIdSchema, SecurityListSchema } from "./security/base.js";
import { SecurityByRepositorySchema } from "./security/by-repo.js";
import { SecurityByRuleSchema } from "./security/by-rule.js";
import { SecurityFigureSchema, SecurityPageSchema } from "./security/top.js";

export * from "./security/base.js";
export * from "./security/by-repo.js";
export * from "./security/by-rule.js";
export * from "./security/opened-rule.js";
export * from "./security/top.js";
export * from "./security/words.js";

/**
 * A repository whose lists were not all read this sweep.
 *
 * | The list this sweep                         | Its alerts         | Read |
 * |---------------------------------------------|--------------------|------|
 * | absent: hidden, 403 or 404, or never read   | none counted       | no   |
 * | retained from an earlier sweep: read failed | counted (retained) | no   |
 * | read and empty                              | zero               | yes  |
 *
 * Any unread list makes every lane total and the page's totals at least.
 */
export const SecurityUnreadSchema = z.strictObject({
  repository: z.string(),
  /** The one list not read; absent when neither was, so the repository is named alone. */
  list: SecurityListSchema.optional(),
  /** Alerts from an earlier read are counted. */
  retained: z.boolean(),
  /** When the alerts counted were read. */
  at: ObservedAtSchema.optional(),
  record: ReadRecordSchema.optional(),
});

export const SecurityLaneSchema = z.strictObject({
  id: SecurityLaneIdSchema,
  total: SecurityCountSchema,
  /** High or critical. */
  high: SecurityCountSchema,
  figure: SecurityFigureSchema,
  byRule: SecurityByRuleSchema,
  byRepository: SecurityByRepositorySchema,
});

const LANE_ORDER = SecurityLaneIdSchema.options;

export const SecurityPaneSchema = z
  .strictObject({
    /** False when no list was read this sweep; the sections are then empty. */
    read: z.boolean(),
    /** Every repository on the page: the forks, then the program repositories. */
    repositories: z.array(
      z.strictObject({ name: z.string(), program: z.boolean(), url: z.string() }),
    ),
    unread: z.array(SecurityUnreadSchema),
    alerts: z.strictObject({
      total: SecurityCountSchema,
      dependabot: SecurityCountSchema,
      code: SecurityCountSchema,
    }),
    page: SecurityPageSchema,
    /** The By rule / By repository switch's words. */
    views: z.strictObject({ rule: z.string(), repository: z.string() }),
    lanes: z.array(SecurityLaneSchema),
  })
  .refine(({ lanes }) => lanes.map(({ id }) => id).join() === LANE_ORDER.join(), {
    message: "Security lanes are spi, upstream and tests, in that order",
  })
  .refine(
    ({ alerts, lanes }) =>
      alerts.dependabot.n + alerts.code.n === alerts.total.n &&
      lanes.reduce((n, lane) => n + lane.total.n, 0) === alerts.total.n,
    { message: "Security lanes do not account for the open alerts" },
  );

export type SecurityUnread = z.infer<typeof SecurityUnreadSchema>;
export type SecurityLane = z.infer<typeof SecurityLaneSchema>;
export type SecurityPane = z.infer<typeof SecurityPaneSchema>;
