// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SecurityPane } from "@spi-code/contracts";
import {
  buildModel,
  builtInFleet,
  type CodeAlertFact,
  createContext,
  emptyFacts,
  type Facts,
  fleetOf,
  parseRollout,
  type ReadRecord,
  type RepoAlerts,
  securityPane,
} from "@spi-code/core";

type List = keyof RepoAlerts;
interface Case {
  absent?: [string, List][];
  retained?: string[];
  failed?: string;
  remove?: Record<string, Record<List, number[]>>;
  only?: Record<string, RepoAlerts>;
}

export type SecurityFixture = "1116" | "partial" | "retained" | "failed" | "clean" | "single";
export const SECURITY_FIXTURES: readonly SecurityFixture[] = [
  "1116",
  "partial",
  "retained",
  "failed",
  "clean",
  "single",
];

const core = (path: string) =>
  fileURLToPath(new URL(`../../../core/test/fixtures/${path}`, import.meta.url));
const json = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8"));

export const securityFixturePath = (name: SecurityFixture) =>
  fileURLToPath(
    new URL(`../../../../fixtures/watch/generated/security/${name}.json`, import.meta.url),
  );

/** The 16 Nov sweep's pane, with core's security-cases.json edit of the same name applied. */
export function securityFixture(name: SecurityFixture): SecurityPane {
  return securitySweep(name).pane;
}

/** The pane with the security read records a sweep of that case would save; 1116 read every repository. */
export function securitySweep(
  name: SecurityFixture,
  scanned: (alert: CodeAlertFact) => CodeAlertFact = (alert) => alert,
): {
  pane: SecurityPane;
  records: ReadRecord[];
  now: Date;
} {
  const base: Facts = { ...emptyFacts(), ...json<Partial<Facts>>(core("upstream-1116.json")) };
  const now = new Date(base.sweep?.at ?? "");
  const spec: Case =
    name === "1116" ? {} : (json<Record<string, Case>>(core("security-cases.json"))[name] ?? {});
  const at = base.security.at ?? "";
  const held = base.security.data ?? {};
  const data: Record<string, RepoAlerts> = spec.only
    ? {
        ...Object.fromEntries(
          Object.keys(held).map((repo) => [repo, { dependabot: [], code: [] }]),
        ),
        ...spec.only,
      }
    : structuredClone(held);
  for (const [repo, list] of spec.absent ?? []) delete data[repo]?.[list];
  for (const [repo, lists] of Object.entries(spec.remove ?? {})) {
    const alerts = data[repo];
    if (!alerts) continue;
    if (alerts.dependabot)
      alerts.dependabot = alerts.dependabot.filter((a) => !lists.dependabot.includes(a.number));
    if (alerts.code) alerts.code = alerts.code.filter((a) => !lists.code.includes(a.number));
  }
  for (const alerts of Object.values(data)) if (alerts.code) alerts.code = alerts.code.map(scanned);
  const failing = (repo: string) =>
    spec.failed ?? (spec.retained?.includes(repo) ? "HTTP 502: Bad Gateway" : undefined);
  const security: ReadRecord[] =
    name === "1116"
      ? []
      : Object.keys(data).map((repo) => {
          const failure = failing(repo);
          return {
            source: repo,
            object: "security",
            observedAt: now.toISOString(),
            completeness: { kind: "complete" },
            ...(failure ? { failure, retainedFrom: at } : {}),
          };
        });
  const facts: Facts = {
    ...base,
    security: { ...base.security, data, ...(spec.failed ? { error: spec.failed } : {}) },
  };
  const { rollout } = parseRollout(readFileSync(core("rib-59d6895/rollout.json"), "utf8"));
  const context = createContext({
    fleet: fleetOf(builtInFleet(core("upstream-services.json"))),
    ...(rollout ? { rollout } : {}),
    clock: { now: () => now },
  });
  const model = buildModel(facts, now, {}, context);
  const pane = securityPane({ model, facts, reads: { security }, context, now });
  const records: ReadRecord[] =
    name === "1116"
      ? Object.keys(data).map((repo) => ({
          source: repo,
          object: "security",
          observedAt: now.toISOString(),
          completeness: { kind: "complete" },
        }))
      : security;
  return { pane, records, now };
}
