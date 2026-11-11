// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { StationSubstate } from "../model/substate.js";
import { stationSubstateOf } from "../model/substate.js";
import { shortRepo } from "../config.js";
import type { ReadRecord } from "../evidence/index.js";
import type { Facts } from "../facts.js";
import type { Model } from "../model/index.js";
import { runResult, stoppedAttempts } from "../model/stack.js";
import type { WorkRow } from "../model/work.js";
import { names, plural, span, stamp } from "../util.js";
import {
  clockOf,
  NOT_READ,
  type PlaceReading,
  placeReading,
  type ReadingGroup,
  type ReadingItem,
  type ReadingTile,
} from "./index.js";

export interface EnvironmentReadingInput<T extends ReadingItem> {
  model: Model;
  items: readonly T[];
  facts: Pick<Facts, "approvals" | "runs" | "radar">;
  // The lifecycle area's read records; all of them are about the environment.
  lifecycle: readonly ReadRecord[];
  // Every read record the sweep kept; the reading takes the stack repository's own.
  reads: readonly ReadRecord[];
  stackRepo: string;
  now: Date;
}

const SUBSTATE_RANK: Readonly<Record<StationSubstate, number>> = Object.freeze({
  stopped: 0,
  "waiting-on-person": 1,
  "waiting-on-clock": 2,
  "in-progress": 3,
  ready: 4,
});

const SUBSTATE_WORDS: Readonly<Record<StationSubstate, string>> = Object.freeze({
  stopped: "Stopped",
  "waiting-on-person": "Waiting on you",
  "waiting-on-clock": "Waiting on the clock",
  "in-progress": "Deploying",
  ready: "Clear",
});

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

function headlineOf(model: Model, now: Date): string {
  const stack = model.stack;
  const version = stack.running?.version ?? stack.declared;
  const subject = version ?? "The environment";
  if (stack.inflight) {
    const run = stack.inflight.run;
    const what = `${run.kind}${run.target && run.target !== version ? ` to ${run.target}` : ""}`;
    return `${subject} is not deployable while ${article(what)} ${what} runs.`;
  }
  if (stack.deployable.state === "no") return `${subject} is held in maintenance with no run in flight.`;
  if (stack.deployable.state === "yes") {
    const green = stamp(stack.running?.at ?? stack.lastGreen?.updatedAt, now);
    return `${subject} is deployable${green ? `, green since ${green}` : ""}.`;
  }
  if (!stack.history.held) return `The environment is ${NOT_READ}.`;
  const last = stoppedAttempts(stack).at(-1);
  if (last) return `${subject}: the last ${last.run.kind} ${runResult(last.run)}, so deployability is unclear.`;
  return version
    ? `No run in the window says whether ${version} is deployable.`
    : `Deployability is ${NOT_READ}.`;
}

function versionTile(model: Model): ReadingTile {
  const { running, declared, latest, landed } = model.stack;
  if (!running) {
    return declared
      ? { label: "Version", value: declared, counts: `declared · running version ${NOT_READ}` }
      : { label: "Version", value: NOT_READ, counts: "running version" };
  }
  const lag = span(landed?.lagMs);
  return {
    label: "Version",
    value: running.version,
    counts: [
      "running",
      latest === running.version ? "the latest release" : latest ? `latest release ${latest}` : undefined,
      declared && declared !== running.version ? `declares ${declared}` : undefined,
      lag ? `landed ${lag} after its release` : undefined,
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

function laneTile(model: Model, facts: EnvironmentReadingInput<ReadingItem>["facts"]): ReadingTile {
  const forks = model.stack.forks;
  if (!forks) return { label: "Lane", value: NOT_READ, counts: "fork deploys to the environment" };
  const states = model.lines.flatMap((line) => {
    const lane = line.stations.find((s) => s.id === "lane");
    return lane ? [{ fork: line.fork.id, substate: stationSubstateOf(lane, line, facts) }] : [];
  });
  const worst = states.reduce<StationSubstate>(
    (w, s) => (SUBSTATE_RANK[s.substate] < SUBSTATE_RANK[w] ? s.substate : w),
    "ready",
  );
  const passed = forks.newest.filter((f) => f.passed).length;
  const which = worst === "ready" ? [] : states.filter((s) => s.substate === worst).map((s) => s.fork);
  return {
    label: "Lane",
    value: SUBSTATE_WORDS[worst],
    counts: [
      "fork lanes",
      which.length > 3 ? plural(which.length, "fork") : which.length > 0 ? names(which) : undefined,
      `newest deploy passed on ${passed} of ${forks.newest.length}`,
      forks.noLane.length > 0 ? `${forks.noLane.length} never deployed` : undefined,
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

function openIssues(row: WorkRow): number {
  return Object.values(row.issues).reduce((n, list) => n + list.length, 0);
}

function openPrs(row: WorkRow): number {
  return Object.values(row.prs).reduce((n, list) => n + list.length, 0);
}

function repoTile(row: WorkRow): ReadingTile {
  const label = "Stack repository";
  if (!row.read) return { label, value: NOT_READ, counts: "open issues and pull requests" };
  const prs = openPrs(row);
  const issues = openIssues(row);
  const bugs = row.issues.bug.length;
  const unread = row.unreadPrs + row.unreadIssues;
  return {
    label,
    value: String(prs + issues),
    counts: [
      "open",
      `${plural(issues, "issue")}${bugs > 0 ? ` (${plural(bugs, "bug")})` : ""}`,
      plural(prs, "pull request"),
      unread > 0 ? `${unread} ${NOT_READ}` : undefined,
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

// The stack repository's open work: every pull request, pipeline ones included, then its bugs.
function repoLine(row: WorkRow): string | undefined {
  if (!row.read) return undefined;
  const open = [
    ...row.prs.people,
    ...row.prs.bots,
    ...row.prs.pipeline,
    ...row.issues.bug,
    ...row.issues.enhancement,
    ...row.issues.automation,
    ...row.issues.other,
  ];
  const [lead, ...more] = open;
  if (!lead) return undefined;
  return `Open in ${row.name}: ${lead.title} #${lead.number}${more.length > 0 ? `, and ${more.length} more` : ""}.`;
}

const isCut = (read: ReadRecord): boolean => read.completeness.kind === "cut";
const isFailed = (read: ReadRecord): boolean => read.failure !== undefined;

function environmentQualifier(reads: readonly ReadRecord[]): string | undefined {
  const cut = reads.some(isCut);
  const failed = reads.filter(isFailed).length;
  const failure = failed === 1 ? "a read failed" : `${failed} reads failed`;
  if (cut && failed > 0)
    return `GitHub truncated a read of the environment and ${failure}, so this reading could be missing something.`;
  if (cut) return "GitHub truncated a read of the environment, so this reading could be missing something.";
  if (failed > 0)
    return `${failure.charAt(0).toUpperCase()}${failure.slice(1)} for the environment, so this reading could be missing something.`;
  return undefined;
}

function aboutStack(read: ReadRecord, stackRepo: string): boolean {
  return (
    read.source === stackRepo ||
    read.object === stackRepo ||
    read.object.includes(`${stackRepo}/`)
  );
}

// The environment place: the deployable version and when it went green, the fork lanes'
// worst state, and the stack repository's open work.
export function environmentReading<T extends ReadingItem>(
  input: EnvironmentReadingInput<T>,
): PlaceReading<T> {
  const { model, items, facts, lifecycle, reads, stackRepo, now } = input;
  const scopes = new Set(["Environment", shortRepo(stackRepo)]);
  const bite = (i: T): string | undefined => i.due?.at;
  const tier = (i: T): number => (i.rung === 0 ? 0 : bite(i) ? 1 : i.rung === 1 ? 2 : 3);
  const groupOf = (i: T): string =>
    i.rung === 0
      ? "Stopped"
      : bite(i)
        ? `Before ${clockOf(bite(i))}`
        : i.rung === 1
          ? "Needs a decision"
          : "Ready to move";
  const time = (i: T): number => (tier(i) === 1 ? Date.parse(bite(i) as string) : 0);
  const own = items
    .filter((i) => scopes.has(i.scope) && i.id !== "stack:lanes" && !i.id.startsWith("lane-deploy:"))
    .map((item, index) => ({ item, index }))
    .sort((a, b) => tier(a.item) - tier(b.item) || time(a.item) - time(b.item) || a.index - b.index)
    .map(({ item }) => item);
  const groups: ReadingGroup<T>[] = [];
  for (const item of own) {
    const group = groupOf(item);
    const found = groups.find((g) => g.group === group);
    if (found) (found.items as T[]).push(item);
    else groups.push({ group, items: [item] });
  }
  const evidence = [...new Set([...lifecycle, ...reads.filter((r) => aboutStack(r, stackRepo))])];
  const qualifier = environmentQualifier(evidence);
  const row = model.work.stack;
  const extra = repoLine(row);
  return placeReading({
    membership: true,
    headline: headlineOf(model, now),
    ...(qualifier ? { qualifier } : {}),
    tiles: [versionTile(model), laneTile(model, facts), repoTile(row)],
    groups,
    ...(extra ? { extra } : {}),
  });
}
