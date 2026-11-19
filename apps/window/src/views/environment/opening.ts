// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  type EnvEvent,
  type EnvLane,
  type Link,
  type RepoLine,
  todayMembers,
  type ViewSnapshot,
} from "@spi-code/contracts";
import type { OpenSelection } from "../../app/navigation.js";
import {
  type BodyPlace,
  type OpenedContent,
  repositoryContent,
  todayContent,
} from "../../components/opened-body/content.js";
import { envelopesFor } from "../../store/evidence.js";
import { plainTitle } from "../../text.js";
import { borrowDetail } from "./borrows.js";
import { type Range, rangeOf, routeOf, within } from "./range.js";
import { eventKey, eventSpan, eventWhen } from "./timeline.js";

const ENVIRONMENT = { kind: "environment" } as const;
const STACK = "osdu-spi-stack";

export type EnvironmentOpening = {
  content: OpenedContent;
  /** How a Stack run started, as core read it. */
  trigger?: string;
  /** For a hold, the runs that ran while it held, each its own `event` selection. */
  during: { key: string; text: string }[];
  fork?: { id: string; label: string };
};

/** A run's name said once: "Smoke", not "Smoke · smoke". */
export function runName(lane: EnvLane, e: EnvEvent): string {
  return lane.label.toLowerCase() === e.label.trim().toLowerCase()
    ? lane.label
    : `${lane.label} · ${e.label}`;
}

function findEvent(snapshot: ViewSnapshot, key: string) {
  for (const lane of snapshot.briefing.environment.lanes)
    for (const e of lane.events) if (eventKey(lane, e) === key) return { lane, e };
  return undefined;
}

/** A popover's place: core's name for the Environment, then each part opened. */
function trail(snapshot: ViewSnapshot, ...parts: (string | undefined)[]): string {
  return [snapshot.briefing.environment.words?.place, ...parts].filter(Boolean).join(" \u203a ");
}

function span(e: EnvEvent, to: number): [number, number] {
  return [Date.parse(e.start), e.end ? Date.parse(e.end) : to];
}

function overlaps(a: [number, number], b: [number, number]) {
  return a[0] <= b[1] && b[0] <= a[1];
}

const READY_LANES = ["holds", "refresh", "upgrade"];

/** Each lane came from at least one successful, complete read observed after the run ended. */
function lanesReadOver(snapshot: ViewSnapshot, run: [number, number]): boolean {
  const { lanes } = snapshot.briefing.environment;
  return READY_LANES.every((id) => {
    const index = lanes.findIndex((lane) => lane.id === id);
    const reads = index < 0 ? [] : envelopesFor(snapshot, `/briefing/environment/lanes/${index}`);
    return (
      reads.length > 0 &&
      reads.every(
        ({ envelope }) =>
          (envelope.state === "fresh" || envelope.state === "stale") &&
          envelope.completeness.kind === "complete" &&
          envelope.observedAt !== undefined &&
          Date.parse(envelope.observedAt) >= run[1],
      )
    );
  });
}

/**
 * The running environment is ready now, the Held, refresh and upgrade lanes were read in full since
 * the run, the Held lane holds nothing over it, and no refresh or upgrade that touched it failed,
 * was cancelled or was still running meanwhile.
 */
function stayedReady(snapshot: ViewSnapshot, e: EnvEvent): boolean {
  const env = snapshot.briefing.environment;
  if (env.deployable !== "yes") return false;
  const to = Date.parse(env.to);
  const run = span(e, to);
  if (!lanesReadOver(snapshot, run)) return false;
  return !env.lanes.some(
    (lane) =>
      lane.id !== "smoke" &&
      lane.events.some(
        (other) => (lane.id === "holds" || other.state !== "ok") && overlaps(span(other, to), run),
      ),
  );
}

/** What the run meant for the running environment, in what SPI Code can prove. */
function meaning(snapshot: ViewSnapshot, e: EnvEvent): string | undefined {
  return e.meaningReady && stayedReady(snapshot, e) ? e.meaningReady : e.meaning;
}

/** The stack repository on GitHub, from a line the sweep read on it; unknown when it read none. */
export function stackRepository(snapshot: ViewSnapshot): string | undefined {
  const row = snapshot.briefing.repositories.rows.find(({ name }) => name === STACK);
  for (const line of row?.sections.flatMap(({ lines }) => lines) ?? []) {
    if (!line.url || !URL.canParse(line.url)) continue;
    const url = new URL(line.url);
    const [owner, repo] = url.pathname.split("/").filter(Boolean);
    if (url.hostname === "github.com" && owner && repo === STACK)
      return `${url.origin}/${owner}/${repo}`;
  }
  return undefined;
}

function memberOf(snapshot: ViewSnapshot, id: string | undefined) {
  if (!id) return undefined;
  return todayMembers(snapshot.briefing).find(
    ({ member }) => member.id === id || member.ids.includes(id),
  );
}

const itemsOf = (snapshot: ViewSnapshot) => [...snapshot.briefing.focus, ...snapshot.briefing.rest];

function eventOpening(
  snapshot: ViewSnapshot,
  key: string,
  range: Range,
): EnvironmentOpening | undefined {
  const found = findEvent(snapshot, key);
  if (!found) return undefined;
  const { lane, e } = found;
  const env = snapshot.briefing.environment;
  const { words } = env;
  const holdWords = lane.id === "holds" ? env.activity?.words : undefined;
  const place: BodyPlace = {
    label: trail(snapshot, range.label, holdWords ? env.activity?.label : lane.label),
    destination: routeOf(range),
    selection: { kind: "event", id: key },
  };
  const repository = lane.id === "holds" ? undefined : stackRepository(snapshot);
  const run: Link | undefined = repository
    ? {
        kind: "run",
        label: [lane.label, words?.run].filter(Boolean).join(" "),
        url: `${repository}/actions/runs/${e.id}`,
      }
    : undefined;
  const to = Date.parse(env.to);
  const during =
    lane.id === "holds"
      ? env.lanes
          .filter(({ id }) => id !== "holds")
          .flatMap((other) =>
            other.events
              .filter(
                (r) => within(range, r.start, r.end, to) && overlaps(span(r, to), span(e, to)),
              )
              .map((r) => ({
                key: eventKey(other, r),
                text: `${runName(other, r)} · ${r.detail}`,
              })),
          )
      : [];
  if (holdWords) {
    return {
      content: {
        title: `${holdWords.held} · ${e.label}`,
        place,
        subject: null,
        cause: [words?.from, eventSpan(e, new Date(to), words)].filter(Boolean).join(" "),
        ...(e.likely ? { effect: e.likely } : {}),
      },
      during,
    };
  }
  const trigger = e.trigger ? { trigger: e.trigger } : {};
  const effect = meaning(snapshot, e);
  const member = memberOf(snapshot, e.inspect);
  if (member) {
    const content = todayContent({
      ...member,
      items: itemsOf(snapshot),
      place,
      links: run ? [run] : [],
    });
    return { content: { ...content, title: plainTitle(content.title) }, during, ...trigger };
  }
  return {
    content: {
      title: runName(lane, e),
      place,
      subject: null,
      cause: `${e.detail} · ${eventSpan(e, new Date(to), words)}`,
      ...(effect ? { effect } : {}),
      ...(run ? { primary: run, links: [run] } : {}),
    },
    during,
    ...trigger,
  };
}

function itemOpening(snapshot: ViewSnapshot, id: string): EnvironmentOpening | undefined {
  const place: BodyPlace = {
    label: trail(snapshot),
    destination: ENVIRONMENT,
    selection: { kind: "item", id },
  };
  const items = itemsOf(snapshot);
  const member = memberOf(snapshot, id);
  if (member) {
    const content = todayContent({ ...member, items, place });
    return { content: { ...content, title: plainTitle(content.title) }, during: [] };
  }
  const item = items.find((item) => item.id === id);
  if (!item) return undefined;
  return {
    content: {
      title: plainTitle(item.title),
      place,
      subject: null,
      cause: plainTitle(item.cause),
      effect: plainTitle(item.effect),
      steps: item.next ? [plainTitle(item.next)] : [],
      ...(item.evidence[0] ? { primary: item.evidence[0] } : {}),
      links: item.evidence,
    },
    during: [],
  };
}

/** The pill for a repository line, typed by the kind core put in the line's id. */
function lineSource(line: RepoLine): Link | undefined {
  if (!line.url) return undefined;
  const kind = line.id?.split(":")[0];
  return {
    label: plainTitle(line.text),
    url: line.url,
    ...(kind === "issue" || kind === "pr" ? { kind } : {}),
  };
}

function repositoryLineOpening(snapshot: ViewSnapshot, id: string): EnvironmentOpening | undefined {
  const row = snapshot.briefing.repositories.rows.find(({ name }) => name === STACK);
  for (const section of row?.sections ?? []) {
    const entry = section.lines.find((line) => line.id === id);
    if (!entry) continue;
    const source = lineSource(entry);
    const content = repositoryContent({
      entry: { ...entry, text: plainTitle(entry.text) },
      lines: snapshot.briefing.lines ?? [],
      items: itemsOf(snapshot),
      place: {
        label: trail(snapshot, snapshot.briefing.environment.words?.repository, section.title),
        destination: ENVIRONMENT,
        selection: { kind: "repository-line", id },
      },
      ...(source ? { source } : {}),
      ...(snapshot.briefing.today ? { canWait: snapshot.briefing.today.canWait } : {}),
    });
    return { content: { ...content, title: plainTitle(content.title) }, during: [] };
  }
  return undefined;
}

/** What opens over the Environment for the open selection: a run or hold, an item, a stack repository line. */
export function environmentOpening(
  snapshot: ViewSnapshot | undefined,
  open: OpenSelection | null,
  shown?: Range,
): EnvironmentOpening | undefined {
  if (!snapshot || !open) return undefined;
  const range = shown ?? rangeOf(snapshot.briefing.environment);
  switch (open.kind) {
    case "event":
      return eventOpening(snapshot, open.id, range);
    case "activity": {
      const { activity, to, words } = snapshot.briefing.environment;
      const segment = activity?.segments.find(({ start }) => start === open.id);
      if (!activity || !segment?.title) return undefined;
      return {
        content: {
          title: segment.title,
          place: {
            label: trail(snapshot, activity.label),
            destination: routeOf(range),
            selection: open,
          },
          subject: null,
          cause: eventWhen(segment, new Date(to), words),
          ...(segment.kind === "estimated" ? { effect: activity.words.estimatedNote } : {}),
        },
        during: [],
      };
    }
    case "borrow": {
      const { borrows, to, words } = snapshot.briefing.environment;
      const borrow = borrows?.find(({ id }) => id === open.id);
      if (!borrow) return undefined;
      const place: BodyPlace = {
        label: trail(snapshot, words?.forks),
        destination: routeOf(range),
        selection: open,
      };
      return {
        content: {
          title: borrow.fork,
          place,
          subject: null,
          cause: [borrow.branch, borrowDetail(borrow, Date.parse(to))].filter(Boolean).join(" · "),
          ...(borrow.overlap ? { effect: borrow.overlap } : {}),
          links: borrow.links,
        },
        during: [],
        fork: { id: borrow.fork, label: borrow.homeLabel ?? borrow.fork },
      };
    }
    case "item":
      return itemOpening(snapshot, open.id);
    case "repository-line":
      return repositoryLineOpening(snapshot, open.id);
    default:
      return undefined;
  }
}
