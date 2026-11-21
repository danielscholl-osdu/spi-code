// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SecurityLane, SecurityLaneId, SecurityPane } from "./contract.js";
import { securityByRepository } from "./by-repo.js";
import { securityByRule } from "./by-rule.js";
import { classify, count, LANES, type SecurityInput, type SecuritySource, unreadList } from "./classify.js";
import { securityFigure } from "./figure.js";
import { securityOpenedRule } from "./opened-rule.js";
import { securityPage } from "./page.js";

export {
  count,
  LANES,
  type SecurityAlert,
  type SecurityInput,
  type SecurityRepository,
  type SecuritySource,
  unreadList,
} from "./classify.js";

const EMPTY_LANE = {
  figure: { label: "", who: "", high: [], blocks: [], empty: [] },
  byRule: {
    summary: [],
    columns: { worst: "", rule: "", alerts: "", fix: "" },
    heading: [],
    tickMax: 0,
    barMax: 0,
    rules: [],
  },
  byRepository: { columns: { repository: "", alerts: "", top: "" }, barMax: 0, rows: [], clean: [] },
} as const satisfies Omit<SecurityLane, "id" | "total" | "high">;

const EMPTY_PAGE = {
  totals: [],
  headline: [],
  banner: [],
  opens: "spi",
  barMax: 0,
  stub: [],
  legend: { high: "", rest: "" },
} as const satisfies SecurityPane["page"];

const VIEWS = { rule: "By rule", repository: "By repository" } as const;

function lane(input: SecurityInput, id: SecurityLaneId): SecurityLane {
  const byRule = securityByRule(input, id);
  return {
    id,
    ...input.totals[id],
    figure: securityFigure(input, id),
    byRule: { ...byRule, rules: byRule.rules.map((rule) => ({ ...rule, opened: securityOpenedRule(input, rule) })) },
    byRepository: securityByRepository(input, id),
  };
}

/** The Security place: every open alert classified once by its own path, then each section over them. */
export function securityPane(source: SecuritySource): SecurityPane {
  const classified = classify(source);
  const short = classified.unread.length > 0;
  const tally = (alerts: SecurityInput["alerts"]) => ({
    total: count(alerts.length, short),
    high: count(alerts.filter((alert) => alert.high).length, short),
  });
  const input: SecurityInput = {
    ...classified,
    totals: {
      spi: tally(classified.alerts.filter((alert) => alert.lane === "spi")),
      upstream: tally(classified.alerts.filter((alert) => alert.lane === "upstream")),
      tests: tally(classified.alerts.filter((alert) => alert.lane === "tests")),
    },
  };
  const read = classified.repositories.some(({ read: lists }) => lists.dependabot || lists.code);
  const by = (list: "dependabot" | "code") =>
    count(classified.alerts.filter((alert) => alert.list === list).length, unreadList(input, list));
  return {
    read,
    repositories: classified.repositories.map(({ name, program, url }) => ({ name, program, url })),
    unread: [...classified.unread],
    alerts: {
      total: count(classified.alerts.length, short),
      dependabot: by("dependabot"),
      code: by("code"),
    },
    page: read ? securityPage(input) : EMPTY_PAGE,
    views: VIEWS,
    lanes: LANES.map((id) => (read ? lane(input, id) : { id, ...input.totals[id], ...EMPTY_LANE })),
  };
}
