// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SecurityCount, SecurityLaneId, SecurityList, SecurityUnread } from "./contract.js";
import { closedFix, groupOf, NO_FILE, readOf } from "../brief/service-upstream.js";
import type { CoreContext } from "../context.js";
import type {
  CodeAlertFact,
  DependencyAlertFact,
  Facts,
  PastPrFact,
  RepoAlerts,
  Severity,
} from "../facts.js";
import type { Model } from "../model/index.js";
import { type DependencyPr, forkPaths, ownerOf, type Paths } from "../model/repos.js";
import type { SweepReads } from "../sweep/index.js";

export const LANES: readonly SecurityLaneId[] = Object.freeze(["spi", "upstream", "tests"]);
const LISTS: readonly SecurityList[] = Object.freeze(["dependabot", "code"]);

/** Whose move a path is, or a repository setting when the alert has no file. */
export type SecurityOwner = "spi" | "upstream" | "setting";

/** One open alert, classified once by its own path. */
export interface SecurityAlert {
  repository: string;
  list: SecurityList;
  lane: SecurityLaneId;
  /** The rule or package it belongs to in its lane. */
  key: string;
  /** Tooling or a repository setting, in the tests lane. */
  tooling: boolean;
  owner: SecurityOwner;
  severity?: Severity;
  high: boolean;
  /** The file or manifest; absent for a repository setting. */
  path?: string;
  number: number;
  url: string;
  createdAt: string;
  dependabot?: DependencyAlertFact;
  code?: CodeAlertFact;
  /** A Dependabot PR for this package and manifest, closed unmerged. */
  closedPr?: PastPrFact;
}

export interface SecurityRepository {
  /** Short name: the fork's id, or the program repository's name. */
  name: string;
  repo: string;
  program: boolean;
  url: string;
  read: Readonly<Record<SecurityList, boolean>>;
  /** Open Dependabot PRs. */
  openPrs: readonly DependencyPr[];
}

/** What every section is given: the alerts classified once and what was read. */
export interface SecurityInput {
  now: Date;
  alerts: readonly SecurityAlert[];
  repositories: readonly SecurityRepository[];
  unread: readonly SecurityUnread[];
  totals: Readonly<Record<SecurityLaneId, { total: SecurityCount; high: SecurityCount }>>;
}

export interface SecuritySource {
  model: Model;
  facts: Facts;
  reads: SweepReads;
  context: CoreContext;
  now: Date;
}

export const count = (n: number, atLeast: boolean): SecurityCount => ({ n, atLeast });

/** Whether a list of this kind was not read in some repository, so a count drawing on it is at least. */
export const unreadList = (input: Pick<SecurityInput, "repositories">, list: SecurityList) =>
  input.repositories.some((repository) => !repository.read[list]);

const heavy = (severity: Severity | undefined) => severity === "critical" || severity === "high";

const ownerAt = (path: string | undefined, paths: Paths): SecurityOwner =>
  !path ? "setting" : ownerOf(path, paths) === "upstream" ? "upstream" : "spi";

function codePath(alert: CodeAlertFact): string | undefined {
  return alert.path && alert.path.toLowerCase() !== NO_FILE ? alert.path : undefined;
}

function alertsOf(
  name: string,
  lists: RepoAlerts | undefined,
  paths: Paths,
  past: readonly PastPrFact[],
): SecurityAlert[] {
  const out: SecurityAlert[] = [];
  for (const a of lists?.dependabot ?? []) {
    const { group, tooling } = groupOf(a.manifest, paths, a.scope);
    const pr = closedFix(a, past);
    out.push({
      repository: name,
      list: "dependabot",
      lane: group,
      key: `${group}:dep:${a.package.toLowerCase()}`,
      tooling: !!tooling,
      owner: ownerAt(a.manifest, paths),
      severity: a.severity,
      high: heavy(a.severity),
      path: a.manifest,
      number: a.number,
      url: a.url,
      createdAt: a.createdAt,
      dependabot: a,
      ...(pr ? { closedPr: pr } : {}),
    });
  }
  for (const a of lists?.code ?? []) {
    const path = codePath(a);
    const { group, tooling } = groupOf(path, paths);
    out.push({
      repository: name,
      list: "code",
      lane: group,
      key: `${group}:code:${a.tool}:${a.rule}`,
      tooling: !!tooling,
      owner: ownerAt(path, paths),
      ...(a.severity ? { severity: a.severity } : {}),
      high: heavy(a.severity),
      ...(path ? { path } : {}),
      number: a.number,
      url: a.url,
      createdAt: a.createdAt,
      code: a,
    });
  }
  return out;
}

/** Every repository on the page with its alerts classified, and the lists not read this sweep. */
export function classify(source: SecuritySource): Omit<SecurityInput, "totals"> {
  const { model, facts, reads, context, now } = source;
  const rows = model.repositories.rows;
  const ordered = [...rows.filter((row) => row.group === "fork"), ...rows.filter((row) => row.group === "program")];
  const alerts: SecurityAlert[] = [];
  const repositories: SecurityRepository[] = [];
  const unread: SecurityUnread[] = [];
  for (const row of ordered) {
    const fork = context.fleet.forks.find((f) => f.repo === row.repo);
    const paths: Paths = fork
      ? forkPaths(fork, facts.radar.data?.filters, facts.template.data?.synced)
      : { owned: [], program: true };
    const lists = facts.security.data?.[row.repo];
    const records = reads.security?.filter((r) => r.source === row.repo && r.object === "security");
    const state = Object.fromEntries(
      LISTS.map((list) => {
        const held = lists?.[list] !== undefined;
        return [list, { held, ...readOf(facts.security, records, () => true, held) }];
      }),
    ) as Record<SecurityList, { held: boolean; read: boolean; at?: string }>;
    alerts.push(...alertsOf(row.name, lists, paths, facts.github.data?.repos[row.repo]?.pastPrs ?? []));
    repositories.push({
      name: row.name,
      repo: row.repo,
      program: row.group === "program",
      url: row.url,
      read: { dependabot: state.dependabot.read, code: state.code.read },
      openPrs: row.dependabot,
    });
    const missed = LISTS.filter((list) => !state[list].read);
    if (missed.length === 0) continue;
    const [only] = missed;
    const at = missed.map((list) => state[list].at).find((time) => time !== undefined);
    const [record] = records ?? [];
    unread.push({
      repository: row.name,
      ...(missed.length === 1 && only ? { list: only } : {}),
      retained: missed.some((list) => state[list].held),
      ...(at ? { at } : {}),
      ...(record ? { record } : {}),
    });
  }
  return { now, alerts, repositories, unread };
}
