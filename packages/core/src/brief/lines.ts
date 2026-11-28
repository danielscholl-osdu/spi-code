// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { TodayMemberStation } from "@spi-code/contracts";
import { todayWording as plain } from "@spi-code/contracts";
import { dueOf } from "../attention.js";
import { shortRepo, TEMPLATE_REPO } from "../config.js";
import type { CoreContext } from "../context.js";
import type { Facts } from "../facts.js";
import { itemEvidence, type ItemEvidence } from "../inspect/item-evidence.js";
import { prVerdict } from "../model/checks.js";
import type { Model } from "../model/index.js";
import type { ItemKind, QueueItem } from "../model/queue.js";
import type { SweepReads } from "../sweep/index.js";
import { age, plural, short } from "../util.js";
import type { FocusItem, Link } from "./index.js";
import { sentenceHeadline } from "./headline.js";
import type { LinkKind } from "./move.js";
import { pullsComplete } from "./repo-today.js";
import {
  type ClassifiedRolloutFork, classifyRolloutForks, type RolloutForkState, rolloutTally,
} from "./rollout.js";

export interface TodayDeadline {
  at: string;
  reason: string;
}

export interface TodayMember {
  id: string;
  ids: string[];
  fork: string;
  station?: TodayMemberStation;
  home?: "line" | "environment" | "engineering" | "upstream" | "security";
  subject?: string;
  primary?: Link & { kind: LinkKind };
  since?: string;
  age?: string;
  cause: string;
  effect: string;
  steps: string[];
  blockedBy?: string;
  deadline?: TodayDeadline;
  evidence: ItemEvidence;
}

export interface TodayLine {
  id: string;
  section: "blocked" | "waiting";
  subject: string;
  headline: string;
  proved?: string;
  cause: string;
  effect: string;
  steps: string[];
  deadline?: TodayDeadline;
  age?: string;
  rollout?: { withoutPr: string[]; tally?: { state: RolloutForkState; forks: string[] }[] };
  members: TodayMember[];
}

export function todaySources(
  model: Model,
  items: readonly FocusItem[],
  lines: readonly TodayLine[],
) {
  const sections = new Map<string, TodayLine["section"]>();
  for (const section of ["waiting", "blocked"] as const) {
    const members = lines.filter((line) => line.section === section).flatMap((line) => line.members);
    const ids = new Set(members.flatMap((m) => [m.id, ...m.ids, ...(m.blockedBy ? [m.blockedBy] : [])]));
    const urls = [
      ...members.flatMap((m) => [m.subject, m.primary?.url]),
      ...items.filter((i) => ids.has(i.id) || i.ids.some((id) => ids.has(id)))
        .flatMap((i) => [i.subject, ...i.evidence.map((e) => e.url)]),
      ...model.queue.items.filter((q) => ids.has(q.id)).flatMap((q) =>
        [q.url, ...q.cause.map((f) => f.url), ...q.effects.map((e) => e.url)]),
    ];
    for (const url of urls) if (url) sections.set(url, section);
  }
  return sections;
}

type Item = FocusItem & { attention?: string };
type PullReads = { facts: Pick<Facts, "github">; reads?: SweepReads };
type NonEmpty<T> = [T, ...T[]];
type ObjectMove = {
  item: Item;
  blocker?: Item;
  queued?: QueueItem;
  dependency?: string;
  member: TodayMember;
  section: TodayLine["section"];
};

function clock(at: string, context: CoreContext): string {
  if (context.timeStyle === "instant") return at;
  const date = new Date(at);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()];
  return `${day} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function deadlineOf(
  model: Model,
  ids: string[],
  now: Date,
  context: CoreContext,
): TodayDeadline | undefined {
  const queued = model.queue.items.filter((q) => ids.includes(q.id));
  const due = dueOf(queued, model, now);
  if (due)
    return { at: due.at, reason: `Before the next upstream sync, ${clock(due.at, context)}` };
  const rollout = model.rollout;
  const at = rollout?.schedule.template;
  if (queued.some((q) => q.kind === "rollout") && at && rollout.schedule.templateOpens > 0) {
    return {
      at,
      reason: `Dispatch before ${clock(at, context)}, when the scheduled sync opens all ${rollout.schedule.templateOpens} PRs at once`,
    };
  }
  return undefined;
}

/** The object's home, independent of the other items and sources its move carries. */
function homeOf(model: Model, item: Item, context: CoreContext): TodayMember["home"] {
  if (item.cls === "SECURITY") return "security";
  if (item.id === "stack:lanes" || item.id.startsWith("lane-deploy:")) return "line";
  const kind = model.queue.items.find((queued) => queued.id === item.id)?.kind;
  if (kind === "radar" || kind === "port") return "upstream";
  if (item.scope === "osdu-spi" || item.scope === TEMPLATE_REPO ||
    item.id.startsWith("template-pr:") || item.id === "rollout" || item.id === "template-set")
    return "engineering";
  if (item.scope === "Environment" || item.scope === shortRepo(context.stackRepo)) return "environment";
  if (model.lines.some((line) => line.fork.id === item.scope)) return "line";
  return undefined;
}

const MEMBER_STATION: Partial<Record<ItemKind, TodayMemberStation>> = Object.freeze({
  halt: "upstream", radar: "upstream", "sync-run": "upstream",
  gate1: "sync",
  conflict: "integration", cascade: "integration", "cascade-missed": "integration",
  labels: "integration", gate2: "integration", "lane-deploy": "integration", lanes: "integration",
  rollout: "template", "template-pr": "template", "template-red": "template",
  "template-set": "template", "template-run": "template",
});

function objectMove(
  model: Model,
  moves: NonEmpty<Item>,
  blocker: Item | undefined,
  now: Date,
  context: CoreContext,
): ObjectMove {
  // The source-bearing object, rather than the older upstream fact carried by that object.
  const item =
    moves.find((i) => i.subject && i.evidence.some((link) => link.url === i.subject)) ?? moves[0];
  const queued = model.queue.items.find((q) => q.id === item.id);
  const first = moves.find((i) => i.cls === "TOOLCHAIN");
  const ordered = first ? [first, ...moves.filter((i) => i !== first)] : moves;
  const ids = [...new Set([...ordered.flatMap((i) => i.ids), ...(blocker?.ids ?? [])])];
  const dependency =
    first &&
    model.queue.items
      .find((q) => q.id === first.id)
      ?.cause.find((fact) => fact.label === "value")
      ?.value.split(" ")[0];
  const primary =
    item.evidence.find((link) => link.url === item.subject) ??
    item.evidence.find((link) => link.kind !== undefined && link.kind !== "other");
  const since =
    queued?.since && Number.isFinite(Date.parse(queued.since)) ? queued.since : undefined;
  const fork = queued?.cause.find((fact) => fact.label === "fork")?.value ?? item.scope;
  const deadline = deadlineOf(model, ids, now, context);
  const steps = [...(blocker ? [blocker.next] : []), ...ordered.map((i) => i.next)].map(plain);
  const home = homeOf(model, item, context);
  const station = queued && MEMBER_STATION[queued.kind];
  const behind = !blocker && queued?.kind === "gate2" &&
    model.lines.find((line) => line.fork.id === fork)?.cascadePr?.pr.mergeState === "BEHIND" &&
    item.cls === "GATE";
  const member: TodayMember = {
    id: item.id,
    ids,
    fork,
    ...(station ? { station } : {}),
    ...(home ? { home } : {}),
    ...(item.subject ? { subject: item.subject } : {}),
    ...(primary?.kind ? { primary: { ...primary, kind: primary.kind } } : {}),
    ...(since ? { since, age: age(since, now) } : {}),
    cause: behind ? "The integration PR needs its branch updated, then approval."
      : plain(first?.cause ?? blocker?.cause ?? item.cause),
    effect: plain(item.effect),
    steps,
    ...(blocker ? { blockedBy: blocker.id } : {}),
    ...(deadline ? { deadline } : {}),
    evidence: itemEvidence(model, ids),
  };
  return {
    item,
    blocker,
    queued,
    dependency,
    member,
    section: (blocker?.rung ?? Math.min(...moves.map((i) => i.rung))) === 0 ? "blocked" : "waiting",
  };
}

/** The short cause a read proved: the step a sync run failed at, or the check a sync PR fails. */
function provedOf(model: Model, move: ObjectMove): string | undefined {
  const { queued, item, blocker, dependency } = move;
  if (blocker || dependency) return undefined;
  if (queued?.kind === "sync-run") {
    const reason = queued.cause.find(({ label }) => label === "reason")?.value;
    const step = reason && / › (.+)$/.exec(reason)?.[1];
    return step ? `at ${step}` : undefined;
  }
  if (queued?.kind === "gate1" && item.cls !== "GATE") {
    const pr = model.lines.find(({ fork }) => fork.id === item.scope)?.syncPr;
    const check = pr?.failures.find(({ hidden }) => !hidden)?.check;
    return check ? `fails ${check}` : undefined;
  }
  return undefined;
}

function groupKey(model: Model, move: ObjectMove): string {
  if (move.blocker) return `blocker:${move.blocker.id}:${move.queued?.kind ?? move.item.id}`;
  if (move.dependency)
    return `${move.queued?.kind === "radar" ? "toolchain" : "upgrade"}:${move.dependency}`;
  if (move.queued?.kind === "gate1" && move.item.cls === "GATE") return "sync-review";
  if (move.queued?.kind === "gate2") {
    const pr = model.lines.find((l) => l.fork.id === move.item.scope)?.cascadePr?.pr;
    if (pr && prVerdict(pr) !== "red" && move.item.cls === "GATE") return "release-approval";
  }
  return move.item.id;
}

function describe(
  model: Model,
  moves: NonEmpty<ObjectMove>,
): Pick<TodayLine, "subject" | "headline" | "cause" | "effect" | "steps"> {
  const move = moves[0];
  const { item, queued, blocker, dependency, member } = move;
  const n = moves.length;
  const subject = n > 1 ? plural(n, "fork") : member.fork;
  const steps = n > 1 && member.steps.length < 2 ? [] : member.steps;
  const base = { subject, cause: member.cause, effect: member.effect, steps };
  if (blocker) {
    const lanes = model.queue.items.find((q) => q.id === blocker.id);
    const rerun = lanes?.kind === "lanes" && lanes.judgement?.response !== "stop";
    return {
      ...base,
      headline:
        queued?.kind === "gate2"
          ? "Integration PR red: its deploy lane failed"
          : "sync PR waits for its deploy lane",
      cause: plain(blocker.cause),
      effect: `${plural(n, "PR")} cannot move until the failed lanes recover.`,
      steps: rerun
        ? [
            "Re-run the failed lanes once the others drain.",
            "Approve and merge each PR once it is green.",
          ]
        : member.steps,
    };
  }
  if (dependency && queued?.kind !== "radar")
    return {
      ...base,
      headline: `sync PR needs ${dependency} upgraded on the fork first`,
      cause: `The sync PRs carry upstream changes that require ${dependency} on the fork.`,
      effect: "The sync PRs wait for the fork's dependency upgrade.",
      steps: [`Upgrade ${dependency} in the fork's pom.xml.`, "Review and merge the sync PR."],
    };
  switch (queued?.kind) {
    case "halt":
      return {
        ...base,
        headline: `sync halted: no filter rule for ${queued.halt?.entries.join(", ") || "an upstream entry"}`,
      };
    case "sync-run":
      return {
        ...base,
        headline: queued.text === "Sync failed" || member.primary?.kind === "issue" ? queued.text : "sync failed",
      };
    case "cascade-missed":
      return { ...base, headline: queued.text };
    case "gate1":
      return {
        ...base,
        headline: item.cls === "GATE" ? "sync PR to review" : "sync PR has a failed check",
      };
    case "gate2": {
      if (
        moves.every((m) => {
          const pr = model.lines.find((l) => l.fork.id === m.item.scope)?.cascadePr?.pr;
          return m.item.cls === "GATE" && pr && prVerdict(pr) !== "red";
        })
      ) {
        const behind = moves.every((m) =>
          model.lines.find((l) => l.fork.id === m.item.scope)?.cascadePr?.pr.mergeState === "BEHIND",
        );
        const green = moves.every((m) => {
          const pr = model.lines.find((l) => l.fork.id === m.item.scope)?.cascadePr?.pr;
          return pr && prVerdict(pr) === "green";
        });
        return {
          ...base,
          cause: n > 1 ? "The Integration PRs need your approval." : base.cause,
          effect: n > 1 ? "Each PR merges upstream changes into the fork main." : base.effect,
          headline: behind
            ? "Integration PR needs its branch updated, then approval"
            : green
              ? "Integration PR green, ready to approve"
              : "Integration PR waits for approval",
        };
      }
      const pr = model.lines.find((l) => l.fork.id === item.scope)?.cascadePr;
      const check = pr?.failures[0]?.check;
      return {
        ...base,
        headline: check
          ? `Integration PR fails ${check}`
          : pr && prVerdict(pr.pr) === "green"
            ? "Integration PR green, ready to approve"
            : "Integration PR has a failed check",
      };
    }
    case "lane-deploy":
      return { ...base, headline: "lane deploy failed" };
    case "rollout":
      return {
        ...base,
        subject: plural(model.rollout?.forks.filter((f) => !f.onTarget).length ?? 0, "fork"),
        headline: `template ${short(model.rollout?.target.sha ?? "")} not synced yet`,
      };
    case "port":
      return {
        ...base,
        subject: "Upstream",
        headline: `${plural(
          item.ids.reduce(
            (count, id) =>
              count + (model.queue.items.find((q) => q.id === id)?.effects.length ?? 0),
            0,
          ),
          "upstream provider change",
        )} to port`,
      };
    case "main":
      return { ...base, headline: "main build failed" };
    case "cascade":
      return { ...base, headline: "cascade stopped" };
    case "conflict":
      return { ...base, headline: "sync has a merge conflict" };
    case "template-run":
      return { ...base, headline: "template sync failed" };
    case "access":
      return { ...base, headline: "fork image cannot be pulled" };
    case "radar":
      return {
        ...base,
        headline:
          item.cls === "TOOLCHAIN"
            ? "upstream changes need a toolchain upgrade"
            : "next sync has an entry without a filter rule",
      };
    default:
      return { ...base, headline: plain(item.title) };
  }
}

function rolloutMembers(
  model: Model, items: readonly Item[], lines: TodayLine[], now: Date,
  classified: readonly ClassifiedRolloutFork[], pulls?: PullReads,
) {
  const rollout = model.rollout;
  const line = lines.find(({ members }) => members.some(({ id }) => id === "rollout"));
  if (!rollout || line?.section !== "waiting") return;
  const operation = line.members.find(({ id }) => id === "rollout");
  const held = todaySources(model, items, lines.filter((other) => other !== line));
  const withPr = classified.filter(({ state }) => state === "to-review" || state === "checking");
  const members = withPr.flatMap(({ fork: { service, pr } }): TodayMember[] => {
    if (!pr || held.has(pr.url)) return [];
    held.set(pr.url, "waiting");
    const id = `rollout:${service}`;
    const opened = model.lines.find(({ fork }) => fork.id === service)?.templatePr?.pr;
    const since = opened?.url === pr.url && Number.isFinite(Date.parse(opened.createdAt))
      ? opened.createdAt : undefined;
    return [{
      id, ids: [id], fork: service, station: "template", home: "engineering",
      subject: pr.url, primary: { kind: "pr", label: `PR #${pr.number}`, url: pr.url },
      ...(since ? { since, age: age(since, now) } : {}),
      cause: "Review the template sync PR.", effect: "", steps: [],
      evidence: itemEvidence(model, ["rollout"]),
    }];
  });
  const withoutPr = classified
    .filter(({ fork, state }) =>
      (state === "to-dispatch" || state === "not-started") &&
      pulls && pullsComplete(fork.repo, pulls.facts, pulls.reads),
    )
    .map(({ fork }) => fork.service);
  const dispatch = classified.some(({ state }) => state === "to-dispatch");
  const tally = rolloutTally(classified);
  if (members.length) {
    line.subject = plural(members.length, "fork");
    line.rollout = { withoutPr, tally };
    line.members = members;
    if (dispatch) {
      lines.push({
        ...line,
        id: `${line.id}:template`,
        subject: "Template",
        rollout: { withoutPr, tally },
        members: operation ? [operation] : [],
      });
    }
    return;
  }
  if (dispatch) {
    line.subject = "Template";
    line.rollout = { withoutPr, tally };
    return;
  }
  lines.splice(lines.indexOf(line), 1);
}

function memberInFlight(model: Model, member: TodayMember, checking: ReadonlySet<string>): boolean {
  if (member.id.startsWith("rollout:")) return checking.has(member.id.slice("rollout:".length));
  const queued = model.queue.items.find((item) => item.id === member.id);
  if (queued?.rerun?.state === "in-flight") return true;
  const line = model.lines.find(({ fork }) => fork.id === member.fork);
  if (!line) return false;
  switch (queued?.kind) {
    case "gate1":
      return !!line.syncPr && prVerdict(line.syncPr.pr) === "pending";
    case "gate2":
      return !!line.cascadePr && prVerdict(line.cascadePr.pr) === "pending";
    case "template-pr":
    case "template-red":
      return !!line.templatePr && prVerdict(line.templatePr.pr) === "pending";
    default:
      return false;
  }
}

export interface TodayFlight {
  line: TodayLine;
  member: TodayMember;
}

export function todayLineFailing(model: Model, line: TodayLine): boolean {
  return line.members.some((member) => {
    const ids = new Set([member.id, ...member.ids]);
    return model.queue.items.some((item) => {
      if (!ids.has(item.id)) return false;
      switch (item.kind) {
        case "lanes":
        case "lane-deploy":
        case "main":
        case "sync-run":
        case "template-run":
        case "template-red":
        case "release-red":
          return true;
        case "gate1": {
          const pr = model.lines.find(({ fork }) => fork.id === member.fork)?.syncPr;
          return !!pr && prVerdict(pr.pr) === "red";
        }
        case "gate2": {
          const pr = model.lines.find(({ fork }) => fork.id === member.fork)?.cascadePr;
          return !!pr && prVerdict(pr.pr) === "red";
        }
        default:
          return false;
      }
    });
  });
}

function lineAge(line: TodayLine): number {
  const times = line.members.flatMap((member) =>
    member.since && Number.isFinite(Date.parse(member.since)) ? [Date.parse(member.since)] : [],
  );
  return times.length ? Math.min(...times) : Infinity;
}

export function orderTodayLines(model: Model, lines: readonly TodayLine[]): TodayLine[] {
  return [...lines].sort((a, b) => {
    const section = Number(a.section === "waiting") - Number(b.section === "waiting");
    if (section) return section;
    const aAt = a.deadline ? Date.parse(a.deadline.at) : NaN;
    const bAt = b.deadline ? Date.parse(b.deadline.at) : NaN;
    if (Number.isFinite(aAt) || Number.isFinite(bAt)) {
      if (!Number.isFinite(aAt)) return 1;
      if (!Number.isFinite(bAt)) return -1;
      return aAt - bAt || a.id.localeCompare(b.id);
    }
    const failed = Number(todayLineFailing(model, b)) - Number(todayLineFailing(model, a));
    if (failed) return failed;
    if (!todayLineFailing(model, a)) {
      const age = lineAge(a) - lineAge(b);
      if (age) return age;
    }
    return a.id.localeCompare(b.id);
  });
}

/** Today's operator-owned objects, grouped by shared situation, with no change to the rib briefing. */
export function todayProjection(
  model: Model,
  items: readonly Item[],
  now: Date | undefined,
  context: CoreContext,
  pulls?: PullReads,
): { lines: TodayLine[]; flights: TodayFlight[] } {
  now ??= context.clock.now();
  const byId = new Map(items.map((item) => [item.id, item]));
  const eligible = (item: Item) => item.actor === "operator" && item.attention !== "background";
  const governing = (item: Item): Item | undefined => {
    const seen = new Set([item.id]);
    let blocker = item.blockedBy ? byId.get(item.blockedBy) : undefined;
    if (item.blockedBy && !blocker) return undefined;
    while (blocker?.blockedBy) {
      if (seen.has(blocker.id) || !eligible(blocker)) return undefined;
      seen.add(blocker.id);
      blocker = byId.get(blocker.blockedBy);
      if (!blocker) return undefined;
    }
    return blocker && eligible(blocker) && !seen.has(blocker.id)
      ? blocker
      : !item.blockedBy && eligible(item)
        ? item
        : undefined;
  };
  const candidates = items.filter((item) =>
    (item.id !== "rollout" || model.rollout) && item.attention !== "background" && governing(item),
  );
  const blockers = new Set(candidates.flatMap((item) => (item.blockedBy ? [item.blockedBy] : [])));
  const objects = new Map<string, NonEmpty<Item>>();
  for (const item of candidates) {
    if (blockers.has(item.id)) continue;
    const key = item.subject ?? item.id;
    const object = objects.get(key);
    if (object) object.push(item);
    else objects.set(key, [item]);
  }
  const groups = new Map<string, NonEmpty<ObjectMove>>();
  for (const moves of objects.values()) {
    const blocked = moves.find((item) => item.blockedBy);
    const blocker = blocked ? governing(blocked) : undefined;
    const move = objectMove(model, moves, blocker, now, context);
    const key = `${move.section}:${groupKey(model, move)}`;
    const group = groups.get(key);
    if (group) group.push(move);
    else groups.set(key, [move]);
  }
  const lines = [...groups].map(([id, moves]): TodayLine => {
    moves.sort(
      (a, b) =>
        (a.member.since ? Date.parse(a.member.since) : Infinity) -
        (b.member.since ? Date.parse(b.member.since) : Infinity),
    );
    const members = moves.map((move) => move.member);
    const deadlines = members
      .flatMap((m) => (m.deadline ? [m.deadline] : []))
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const words = describe(model, moves);
    const proved = [...new Set(moves.map((move) => provedOf(model, move)))];
    return {
      id,
      section: moves[0].section,
      ...words,
      headline: sentenceHeadline(plain(words.headline)),
      ...(proved.length === 1 && proved[0] ? { proved: plain(proved[0]) } : {}),
      ...(members[0]?.age ? { age: members[0].age } : {}),
      ...(deadlines[0] ? { deadline: deadlines[0] } : {}),
      members,
    };
  });
  const classified = model.rollout ? classifyRolloutForks(model.rollout) : [];
  rolloutMembers(model, items, lines, now, classified, pulls);
  const checking = new Set(
    classified
      .flatMap(({ fork, state }) => (state === "checking" ? [fork.service] : [])),
  );
  const inFlight = (member: TodayMember) => memberInFlight(model, member, checking);
  const flights = lines.flatMap((line) =>
    line.members.filter(inFlight).map((member) => ({ line, member })),
  );
  const active = lines.flatMap((line) => {
    const members = line.members.filter((member) => !inFlight(member));
    if (!members.length) return [];
    if (line.subject.match(/^\d+ forks$/)) line.subject = plural(members.length, "fork");
    return [{ ...line, members }];
  });
  return { lines: orderTodayLines(model, active), flights };
}

export function todayLines(
  model: Model,
  items: readonly Item[],
  now: Date | undefined,
  context: CoreContext,
  pulls?: PullReads,
): TodayLine[] {
  return todayProjection(model, items, now, context, pulls).lines;
}

export function todayInFlight(
  model: Model,
  items: readonly Item[],
  now: Date | undefined,
  context: CoreContext,
): TodayFlight[] {
  return todayProjection(model, items, now, context).flights;
}
