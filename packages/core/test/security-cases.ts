// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseCodeAlert } from "../src/collect/security";
import type { ReadRecord } from "../src/evidence/index";
import type { Facts, RepoAlerts } from "../src/facts";
import type { SecuritySource } from "../src/security/index";
import { SWEEP_1116_NOW, sweep1116Context, sweep1116Facts, sweep1116Model } from "./sweep-1116";

type List = keyof RepoAlerts;
interface Case {
  absent?: [string, List][];
  retained?: string[];
  failed?: string;
  remove?: Record<string, Record<List, number[]>>;
  only?: Record<string, RepoAlerts>;
  /** Scanner fields given to code alerts by repository and number, as the collector reads them. */
  scanner?: Record<string, Record<string, Record<string, unknown>>>;
}

const CASES: Record<string, Case> = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/security-cases.json", import.meta.url)), "utf8"),
);
export type SecurityCase = "partial" | "retained" | "failed" | "clean" | "single";

/** The 16 Nov sweep with packages/core/test/fixtures/security-cases.json's edit applied. */
export function securityCase(name: SecurityCase): SecuritySource {
  const spec = CASES[name];
  if (!spec) throw new Error(`No security case ${name}`);
  const base = sweep1116Facts();
  const at = base.security.at as string;
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
    alerts.dependabot = alerts.dependabot?.filter((a) => !lists.dependabot.includes(a.number));
    alerts.code = alerts.code?.filter((a) => !lists.code.includes(a.number));
  }
  for (const [repo, byNumber] of Object.entries(spec.scanner ?? {})) {
    const alerts = data[repo];
    if (alerts?.code)
      alerts.code = alerts.code.map((a) => {
        const raw = byNumber[String(a.number)];
        return raw ? (parseCodeAlert({ ...a, ...raw }) ?? a) : a;
      });
  }
  const failing = (repo: string) =>
    spec.failed ?? (spec.retained?.includes(repo) ? "HTTP 502: Bad Gateway" : undefined);
  const security: ReadRecord[] = Object.keys(data).map((repo) => {
    const failure = failing(repo);
    return {
      source: repo,
      object: "security",
      observedAt: SWEEP_1116_NOW.toISOString(),
      completeness: { kind: "complete" },
      ...(failure ? { failure, retainedFrom: at } : {}),
    };
  });
  const facts: Facts = {
    ...base,
    security: { ...base.security, data, ...(spec.failed ? { error: spec.failed } : {}) },
  };
  return {
    model: sweep1116Model(facts),
    facts,
    reads: { security },
    context: sweep1116Context,
    now: SWEEP_1116_NOW,
  };
}

export function sweep1116Source(): SecuritySource {
  const facts = sweep1116Facts();
  return {
    model: sweep1116Model(facts),
    facts,
    reads: {},
    context: sweep1116Context,
    now: SWEEP_1116_NOW,
  };
}
