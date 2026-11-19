// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { TodayFleet, ViewSnapshot } from "@spi-code/contracts";
import { restatesHeadline } from "../components/opened-body/content.js";
import { plainTitle } from "../text.js";
import { instantsIn, timedText, when } from "../time.js";
import { activityView } from "../views/environment/activity.js";
import { borrowInRange, borrowWhen } from "../views/environment/borrows.js";
import { runName } from "../views/environment/opening.js";
import { daysOf, lastOf, rangeOf, WEEK, within } from "../views/environment/range.js";
import { eventSpan, eventText, eventWhen, eventWord } from "../views/environment/timeline.js";
import { releaseSectionCases } from "../views/releases/reachability.test-helper.js";
import { readFork } from "../views/today/Forks.js";
import { ageInOneUnit } from "../views/today/parts.js";
import {
  lensFields,
  RETIRED_SERVICE_READING,
  RETIRED_SERVICE_REPOSITORY,
} from "./lens-fields.test-helper.js";
import type { Destination, Registry } from "./navigation.js";
import { placeFreshCases } from "./place-reachability.test-helper.js";

export type Selector = string | ((root: ParentNode) => Element | null | undefined);

/** A signed-off place a field's home starts from: Today, the strip, Forks, a place. */
export type Start = { name: string; surface: string; route: Destination };

/** Where a field lives: its start, then at most one click on a visible target. */
export type Home = {
  name: string;
  start: Start;
  step?: Selector;
  /** The wall clock pinned before the home renders, for a home that draws times against it. */
  clock?: number;
};

/** What a click on the drawn field opens: a place, or the row's body in place. */
export type Opens = { click: Selector } & ({ place: Destination } | { opened: string });

export type Reach = {
  pointer: string;
  value: string;
  home: Home;
  selector: Selector;
  attribute?: string;
  contains?: boolean;
  blank?: boolean;
  /** The field's value as this surface shows it, when it shares its element with other text. */
  read?: (element: Element) => string;
  /** Folds a surface's own wording of the field before two surfaces are compared. */
  canon?: (value: string) => string;
  exempt?: string;
  /** The surface draws only `value`, a prefix of the leaf; `tail` renders nowhere, named by `reason`. */
  partial?: { tail: string; reason: string };
  opens?: Opens;
};

/** Exact index-free leaf patterns, so a new leaf elsewhere never inherits the exemption. */
export type Exemption = {
  patterns: readonly string[];
  reason: string;
  when?: (value: unknown, leaf: { pointer: string; snapshot: Leaves }) => boolean;
  /** A contract field core doesn't fill yet: no fixture leaf has to use it, so it's never stale. */
  pending?: true;
};

type Leaves = Pick<ViewSnapshot, "briefing" | "releases" | "services">;
type Lane = ViewSnapshot["briefing"]["environment"]["lanes"][number];
type Event = Lane["events"][number];
type Repo = ViewSnapshot["briefing"]["repositories"]["rows"][number];
/** The Activity row as each range draws it: 24 h, 7 days, and each of its days. */
const activitiesOf = (env: Leaves["briefing"]["environment"]) =>
  [rangeOf(env), rangeOf(env, WEEK), ...daysOf(env).map(({ key }) => rangeOf(env, key))].map(
    (range) => activityView(env, range.from, range.to, range.week),
  );

const at = (pointer: string) => `[data-pointer="${pointer}"]`;
const quote = (value: string) => JSON.stringify(value);
const lastWord = (value: string) => value.trim().split(/\s+/).pop() ?? "";
const nextSync = (value: string) => value.replace(/^Next sync /, "");
const subText = (value: string) => timedText(plainTitle(value), { hint: false });
const pinDeployable = (element: Element) => {
  const state = element.getAttribute("aria-description")?.split(": ")[1]?.split(". ")[0] ?? "";
  if (state === "Ready") return "yes";
  return state.startsWith("Maintenance") ? "no" : "unknown";
};
const NOTES_STATE: Readonly<Record<string, string>> = {
  Approved: "approved",
  Draft: "draft",
  "No notes yet": "none",
  "Notes file invalid": "invalid",
};
const ownText = (element: Element) =>
  [...element.childNodes]
    .filter((node) => node.nodeType === 3)
    .map((node) => node.textContent ?? "")
    .join("")
    .trim();

const start = (name: string, route: Destination, surface: string = route.kind): Start => ({
  name,
  surface,
  route,
});

export const STARTS = {
  today: start("Today", { kind: "today" }),
  strip: start("Footer sweep", { kind: "today" }, "strip"),
  forks: start("Today", { kind: "today", tab: "forks" }),
  upstream: start("Upstream", { kind: "upstream" }),
  environment: start("Environment", { kind: "environment" }),
  environmentWeek: start("Environment, 7 days", { kind: "environment", range: WEEK }),
  environmentDay: (day: string) =>
    start(`Environment, ${day}`, { kind: "environment", range: day }, "environment"),
  engineering: start("Template", { kind: "engineering-system" }),
  releases: start("Releases", { kind: "releases" }),
  security: start("Security", { kind: "security" }),
  service: (id: string) => start(`Service ${id}`, { kind: "service", id }),
  release: (month: string) => start(`Release ${month}`, { kind: "release", month }),
} as const;

const PLACE_STARTS: Record<string, (id?: string) => Start> = {
  upstream: () => STARTS.upstream,
  environment: () => STARTS.environment,
  engineering: () => STARTS.engineering,
  releases: () => STARTS.releases,
  security: () => STARTS.security,
};
const SELECTABLE_PLACES = new Set(["upstream", "environment", "engineering"]);
/** A place's own heading, which differs from its start's name only for a service. */
const placeLabel = (from: Start) => (from.route.kind === "service" ? from.route.id : from.name);

function home(name: string, from: Start, step?: Selector): Home {
  return { name, start: from, ...(step ? { step } : {}) };
}

const TODAY = home("Today", STARTS.today);
const STRIP = home("Footer sweep", STARTS.strip);
const PINS = home("Pinned", STARTS.today);
const FORKS = home("Today, Forks", STARTS.forks);
const UNFOLDED = home("Today, Forks unfolded", STARTS.forks, ".forks-fold");

/** The lens-field homes t1k.189 ruled, opened the way lens-retirement.test.tsx opens them. */
function lensHome(name: string): Home {
  const [place = "", target] = name.split(" · ");
  const from = place.startsWith("Service ")
    ? STARTS.service(place.slice(8))
    : place === "Environment"
      ? STARTS.environment
      : place === "Template"
        ? STARTS.engineering
        : place === "Today"
          ? STARTS.today
          : STARTS.upstream;
  const step =
    target === "Stack runs"
      ? '[data-part="runs"] > summary'
      : target === "Stack repository"
        ? '[data-part="repository"] > summary'
        : target === "Details"
          ? ".template-details > summary"
          : target === "Repository"
            ? '[data-section="repository"] > summary'
            : target === "Upstream sync Detail"
              ? "[data-service-detail='upstream']"
              : undefined;
  return home(name, from, step);
}

function overlaps(hold: Event, e: Event) {
  const end = (x: Event) => (x.end === undefined ? Number.POSITIVE_INFINITY : Date.parse(x.end));
  return Date.parse(e.start) <= end(hold) && end(e) >= Date.parse(hold.start);
}

const popoverField = (index: number, part: "dt" | "dd") =>
  `.popover-fields > div:nth-child(${index + 1}) > ${part}`;

/** Every Briefing and Releases field the window draws, each at its home surface. */
export function reachCases(snapshot: ViewSnapshot): Reach[] {
  const { briefing, releases } = snapshot;
  const cases: Reach[] = placeFreshCases(snapshot);
  const add = (
    pointer: string,
    value: unknown,
    where: Home,
    selector: Selector,
    extra: Partial<Reach> = {},
  ) => {
    cases.push({ pointer, value: String(value), home: where, selector, ...extra });
  };
  for (const row of lensFields(snapshot)) {
    const { lens: _, home: name, ...field } = row;
    cases.push({ ...field, home: lensHome(name) });
  }

  const { template } = briefing.repositories;
  const engineeringDetails = lensHome("Template · Details");
  const templateFact = at("/briefing/repositories/template");
  if (template)
    for (const [key, selector] of [
      ["label", ".inbox-fact-label"],
      ["figure", ".inbox-fact-figure"],
      ["sub", ".inbox-fact-sub"],
    ] as const)
      add(
        `/briefing/repositories/template/${key}`,
        template[key],
        engineeringDetails,
        `${templateFact} ${selector}`,
        { ...(key === "label" ? { canon: lastWord } : {}) },
      );
  const running = briefing.environment.facts.findIndex(({ label }) => label === "Running");
  const runningFact = briefing.environment.facts[running];
  if (runningFact && runningFact.figure !== "?") {
    const environment = '[data-sidebar-row="environment"]';
    add(`/briefing/environment/facts/${running}/figure`, runningFact.figure, PINS, environment, {
      attribute: "aria-description",
      contains: true,
    });
    add("/briefing/environment/deployable", briefing.environment.deployable, PINS, environment, {
      read: pinDeployable,
    });
  }
  if (briefing.nextSyncAt) {
    add(
      "/briefing/nextSyncAt",
      briefing.nextSyncAt,
      home("Upstream", STARTS.upstream),
      ".place-group[aria-label^='Before '] > h3 time",
      { attribute: "dateTime" },
    );
  }
  add(
    "/briefing/sweptAt",
    briefing.sweptAt,
    STRIP,
    "[data-slot=sidebar-footer] [data-sweep-line] time",
    {
      attribute: "dateTime",
    },
  );

  cases.push(...tableCases(snapshot), ...lowerCases(snapshot));

  const readings = snapshot.readings.flatMap(({ anchor, content }) => {
    const place = PLACE_STARTS[anchor.kind];
    if (!content || !place) return [];
    const from = place("id" in anchor ? anchor.id : undefined);
    return [
      {
        kind: anchor.kind,
        name: placeLabel(from),
        from,
        ids: new Set(content.items.map(({ id }) => id)),
        groups: new Map(content.items.map(({ id, group }) => [id, group])),
      },
    ];
  });
  const themeHead = (index: number) =>
    `li.upstream-theme${at(`/briefing/themes/${index}`)} button.upstream-theme-head`;

  const items = [
    ...briefing.focus.map((item, index) => [`/briefing/focus/${index}`, item] as const),
    ...briefing.rest.map((item, index) => [`/briefing/rest/${index}`, item] as const),
  ];
  for (const [pointer, item] of items) {
    const title = plainTitle(item.title);
    const id = quote(item.id);
    for (const reading of readings.filter(({ ids }) => ids.has(item.id))) {
      const where = home(reading.from.name, reading.from);
      const li = `section.place[aria-label=${quote(reading.name)}] li.place-item[data-item-id=${id}]`;
      add(`${pointer}/title`, title, where, `${li} .place-item-title`, { canon: nextSync });
      add(`${pointer}/rung`, `P${item.rung}`, where, `${li} .place-rank`);
      add(`${pointer}/scope`, item.scope, where, `${li} .place-scope`);
      if (item.sub) add(`${pointer}/sub`, subText(item.sub), where, `${li} .place-item-sub`);
      if (item.next) add(`${pointer}/next`, plainTitle(item.next), where, `${li} .place-item-next`);
      const group = reading.groups.get(item.id) ?? "";
      if (item.due && instantsIn(group).includes(Date.parse(item.due.at))) {
        const heading = (root: ParentNode) =>
          root.querySelector(li)?.closest(".place-group")?.querySelector(":scope > h3 time");
        add(`${pointer}/due/at`, item.due.at, where, heading, { attribute: "dateTime" });
        add(
          `${pointer}/due/before`,
          subText(`Before ${item.due.before}`),
          where,
          `${li} .place-item-content`,
          { attribute: "title" },
        );
      } else if (item.due) {
        const time = `${li} .place-item-meta time`;
        add(`${pointer}/due/at`, item.due.at, where, time, { attribute: "dateTime" });
        add(`${pointer}/due/before`, `Before ${item.due.before}`, where, time);
      }
      if (item.owned) add(`${pointer}/owned`, "Owned", where, `${li} .place-owned`);
    }
    if (item.id === "rollout") {
      const row = '[data-part="rollout"] .inbox-row';
      add(`${pointer}/rung`, `P${item.rung}`, engineeringDetails, `${row} .inbox-priority`);
      add(`${pointer}/scope`, item.scope, engineeringDetails, `${row} .inbox-scope`);
      add(`${pointer}/title`, title, engineeringDetails, `${row} .inbox-row-title`, {
        canon: nextSync,
      });
      add(`${pointer}/cls`, item.cls, engineeringDetails, `${row} .inbox-class`);
      if (item.sub)
        add(`${pointer}/sub`, plainTitle(item.sub), engineeringDetails, `${row} .inbox-sub`);
      item.more?.forEach((entry, index) => {
        const div = `dl.template-detail${at(`${pointer}/more`)} > div:nth-child(${index + 1})`;
        add(`${pointer}/more/${index}/label`, entry.label, engineeringDetails, `${div} > dt`);
        add(
          `${pointer}/more/${index}/text`,
          subText(entry.text),
          engineeringDetails,
          `${div} > dd`,
        );
      });
    }

    const reading = readings.find(
      ({ kind, ids }) => SELECTABLE_PLACES.has(kind) && ids.has(item.id),
    );
    const theme = briefing.themes.findIndex(({ inspect }) => inspect === item.id);
    const opener = reading
      ? {
          from: reading.from,
          step: `section.place[aria-label=${quote(reading.name)}] [data-selection-id=${id}]`,
        }
      : theme >= 0
        ? {
            from: STARTS.upstream,
            step: `li.upstream-theme${at(`/briefing/themes/${theme}`)} button.upstream-theme-item`,
          }
        : undefined;
    if (!opener) continue;
    const opened = home(`${opener.from.name} · Popover ${item.id}`, opener.from, opener.step);
    add(`${pointer}/cls`, item.cls, opened, "", {
      exempt: "Z3: the popover tells the reading, not core's class",
    });
    const member = (briefing.lines ?? []).some(({ members }) =>
      members.some((m) => m.id === item.id || m.ids.includes(item.id)),
    );
    const heading = timedText(plainTitle(item.title), { hint: false });
    for (const [key, selector] of [
      ["cause", ".popover .opened-body > p:not([class])"],
      ["effect", ".popover .opened-body-effect"],
      ["next", ".popover .opened-body-step"],
    ] as const) {
      const value = timedText(plainTitle(item[key]), { hint: false });
      if (!value) continue;
      const exempt = member
        ? "Z3: a Today member's popover tells the member's reading, not the item's"
        : key === "cause" && restatesHeadline(value, heading)
          ? "Z3: the popover drops a cause that restates its title"
          : key === "effect" && /^Nothing (?:else )?waits(?: on it)?[.!]?$/i.test(value)
            ? "Z3: the popover drops an effect that says nothing waits"
            : undefined;
      add(`${pointer}/${key}`, value, opened, selector, exempt ? { exempt } : {});
    }
  }

  briefing.themes.forEach((theme, index) => {
    const pointer = `/briefing/themes/${index}`;
    const where = home(`Upstream · Popover theme:${theme.id}`, STARTS.upstream, themeHead(index));
    add(`${pointer}/title`, theme.title, where, ".popover h3");
    if (theme.next)
      add(`${pointer}/next`, plainTitle(theme.next), where, ".popover .opened-body-step");
    let offset = 0;
    for (const list of ["certain", "possible"] as const) {
      theme[list].forEach((fork, at) => {
        add(`${pointer}/${list}/${at}/fork`, fork.fork, where, popoverField(offset + at, "dt"));
        add(
          `${pointer}/${list}/${at}/state`,
          timedText(`${list} · ${fork.state}`, { hint: false }),
          where,
          popoverField(offset + at, "dd"),
        );
      });
      offset += theme[list].length;
    }
    theme.exposed.forEach((fork, at) => {
      add(`${pointer}/exposed/${at}`, fork, where, popoverField(offset + at, "dt"));
    });
  });

  const environment = briefing.environment;
  const runs = lensHome("Environment · Stack runs");
  add(
    "/briefing/environment/headline",
    subText(environment.headline),
    runs,
    at("/briefing/environment/headline"),
  );
  const environmentHome = home("Environment", STARTS.environment);
  const now = new Date(Date.parse(environment.to));
  const to = now.getTime();
  const base = "/briefing/environment";
  const status = environment.status;
  if (status) {
    add(`${base}/status/state`, status.state, environmentHome, ".env-status", {
      attribute: "data-state",
    });
    add(`${base}/status/label`, status.label, environmentHome, ".env-status-label");
    if (status.length)
      add(
        `${base}/status/length`,
        status.length,
        environmentHome,
        ".env-status > span:nth-child(2)",
      );
    if (status.reason)
      add(`${base}/status/reason`, subText(status.reason), environmentHome, ".env-status small");
    status.live?.forEach(({ id, fork }, index) => {
      add(
        `${base}/status/live/${index}/fork`,
        fork,
        environmentHome,
        `.env-status [data-opens=${quote(`borrow~${id}`)}]`,
      );
    });
  }
  if (environment.line)
    add(`${base}/line`, subText(environment.line), environmentHome, ".env-line");
  if (environment.forksNote)
    add(`${base}/forksNote`, environment.forksNote, environmentHome, ".env-forks-note");
  // Each field at the first range that draws it: 24 h, then 7 days, then the day that holds it.
  const days = daysOf(environment);
  const ranges = [
    { range: rangeOf(environment), from: STARTS.environment },
    ...(environment.activity
      ? [
          { range: rangeOf(environment, WEEK), from: STARTS.environmentWeek },
          ...days.map(({ key }) => ({
            range: rangeOf(environment, key),
            from: STARTS.environmentDay(key),
          })),
        ]
      : []),
  ];
  const drawn = new Set<string>();
  const first = (key: string) => !drawn.has(key) && !!drawn.add(key);
  const popover = ".popover .opened-body";
  if (environment.activity) {
    const week = home("Environment, 7 days", STARTS.environmentWeek);
    const heading = (day: string) => `.env-day-heading[data-day=${quote(day)}]`;
    if (days[0])
      add(`${base}/from`, environment.from, week, heading(days[0].key), {
        attribute: "data-from",
      });
    environment.days?.forEach(({ day, from }, index) => {
      add(`${base}/days/${index}/day`, day, week, heading(day), { attribute: "data-day" });
      add(`${base}/days/${index}/from`, from, week, heading(day), { attribute: "data-from" });
    });
  }
  for (const { range, from: rangeStart } of ranges) {
    const place = home(rangeStart.name, rangeStart);
    const opened = (what: string, step: string) => ({
      ...home(`${rangeStart.name} · ${what}`, rangeStart, step),
      clock: to,
    });
    const activity = activityView(environment, range.from, range.to, range.week);
    if (activity && environment.activity) {
      const pointer = `${base}/activity`;
      if (first("activity-label"))
        add(`${pointer}/label`, activity.label, place, ".env-activity .env-lane-label");
      activity.summary.forEach(({ part }) => {
        if (!first(`summary:${part}`)) return;
        add(
          `${pointer}/words/${part}`,
          activity.words[part],
          place,
          `.env-activity-summary [data-part=${quote(part)}]`,
          { contains: true },
        );
      });
      activity.legend.forEach(([mark, label]) => {
        if (!(mark in activity.words) || !first(`legend:${mark}`)) return;
        add(`${pointer}/words/${mark}`, label, place, `[data-legend=${quote(mark)}]`);
      });
      environment.activity.segments.forEach((segment, index) => {
        if (!segment.title || !activity.segments.some((visible) => visible.segment === segment))
          return;
        if (!first(`activity:${segment.start}`)) return;
        const part = `${pointer}/segments/${index}`;
        const bar = `[data-opens=${quote(`activity~${segment.start}`)}]`;
        const where = opened(`activity ${segment.start}`, bar);
        add(`${part}/kind`, segment.kind, place, bar, { attribute: "data-mark" });
        add(`${part}/title`, segment.title, where, `${popover} h3`);
        add(`${part}/start`, eventWhen(segment, now), where, `${popover} > p`);
        add(`${part}/end`, eventWhen(segment, now), where, `${popover} > p`);
        if (segment.kind === "estimated")
          add(
            `${pointer}/words/estimatedNote`,
            activity.words.estimatedNote,
            where,
            `${popover} .opened-body-effect`,
          );
      });
    }
    environment.borrows?.forEach((borrow, index) => {
      if (range.week || !borrowInRange(borrow, range.from, range.to)) return;
      if (!first(`borrow:${borrow.id}`)) return;
      const pointer = `${base}/borrows/${index}`;
      const bar = `[data-borrow=${quote(borrow.id)}]`;
      const where = opened(`borrow ${borrow.id}`, bar);
      const words = { contains: true };
      add(`${pointer}/fork`, borrow.fork, where, `${popover} h3`);
      if (borrow.branch) add(`${pointer}/branch`, borrow.branch, where, `${popover} > p`, words);
      add(`${pointer}/result`, borrow.result, where, `${popover} > p`, words);
      const span = borrowWhen(borrow, to);
      add(`${pointer}/start`, span, where, `${popover} > p`, words);
      if (borrow.end) add(`${pointer}/end`, span, where, `${popover} > p`, words);
      if (borrow.estimated)
        add(`${pointer}/estimated`, "true", place, bar, { attribute: "data-estimated" });
      if (borrow.overlap)
        add(`${pointer}/overlap`, borrow.overlap, where, `${popover} .opened-body-effect`);
      borrow.links.forEach(({ label, kind, url }, link) => {
        const pill = `${popover} a[href=${quote(url)}]`;
        add(`${pointer}/links/${link}/label`, label, where, pill, words);
        if (kind)
          add(`${pointer}/links/${link}/kind`, kind, where, pill, { attribute: "data-kind" });
        add(`${pointer}/links/${link}/url`, url, where, pill, { attribute: "href" });
      });
    });
    environment.lanes.forEach((lane, laneIndex) => {
      const pointer = `/briefing/environment/lanes/${laneIndex}`;
      const row = `.env-row[data-lane=${quote(lane.id)}]`;
      const activityHold = activity && lane.id === "holds" ? activity : undefined;
      if (!activityHold && first(`lane:${lane.id}`)) {
        add(`${pointer}/label`, lane.label, place, `${row} .env-lane-label`, { contains: true });
        if (lane.cadence) add(`${pointer}/cadence`, lane.cadence, place, `${row} .env-cadence`);
      }
      const last = lastOf(lane, range);
      const lastPointer =
        last && last === lane.last
          ? `${pointer}/last`
          : `${pointer}/lasts/${lane.lasts?.indexOf(last as NonNullable<Lane["lasts"]>[number])}`;
      if (last && first(lastPointer)) {
        add(`${lastPointer}/text`, last.text, place, `${row} .env-last`, { contains: true });
        if (last.note) add(`${lastPointer}/note`, last.note, place, `${row} .env-last-note`);
        if (last.late)
          add(`${lastPointer}/late`, "true", place, `${row} .env-last-note`, {
            attribute: "data-late",
          });
      }
      lane.missed?.forEach((slot, index) => {
        if (!within(range, slot, slot, to) || !first(`missed:${pointer}:${slot}`)) return;
        add(`${pointer}/missed/${index}`, slot, place, `${row} [data-missed=${quote(slot)}]`, {
          attribute: "data-missed",
        });
      });
      lane.events.forEach((e, index) => {
        if (!within(range, e.start, e.end, to)) return;
        if (activityHold && !activityHold.holds.includes(e)) return;
        if (!first(`event:${lane.id}:${e.id}`)) return;
        const event = `${pointer}/events/${index}`;
        const bar = `button[data-event=${quote(`${lane.id}:${e.id}`)}]`;
        if (e.byHand) add(`${event}/byHand`, "true", place, bar, { attribute: "data-by-hand" });
        if (range.week)
          add(`${event}/label`, e.label, place, bar, { attribute: "aria-label", contains: true });
        else
          add(
            `${event}/label`,
            eventText(e),
            place,
            `${bar} ${activityHold ? ".env-hold-label" : ".env-event-label"}`,
            { contains: !!activityHold },
          );
        add(`${event}/state`, eventWord[e.state], place, bar, {
          ...(activityHold
            ? {
                read: (element: Element) =>
                  element.getAttribute("data-mark") === "maintenance" ? "held" : "",
              }
            : { attribute: "aria-label", contains: true }),
        });
        add(`${event}/start`, eventWhen(e, now), place, bar, {
          attribute: "aria-label",
          contains: true,
        });
        if (e.end)
          add(`${event}/end`, eventWhen(e, now), place, bar, {
            attribute: "aria-label",
            contains: true,
          });
        const where = opened(`popover ${lane.id}:${e.id}`, bar);
        const title = activityHold ? `${activityHold.words.held} · ${e.label}` : runName(lane, e);
        add(`${event}/label`, title, where, `${popover} h3`, {
          canon: (value) => (value === title || value === eventText(e) ? e.label : value),
        });
        if (e.detail && !activityHold)
          add(`${event}/detail`, e.detail, where, `${popover} > p`, { contains: true });
        if (e.likely) add(`${event}/likely`, e.likely, where, `${popover} .opened-body-effect`);
        if (activityHold)
          add(`${base}/activity/words/held`, activityHold.words.held, where, `${popover} h3`, {
            contains: true,
          });
        // The popover says when the event ran without its length, which the bar's name carries.
        const ran = (element: Element) =>
          activityHold
            ? (element.textContent ?? "").replace(/^From /, "")
            : (element.textContent ?? "").split(" · ").slice(1).join(" · ");
        const length = { read: ran, canon: (value: string) => value.split(" · ")[0] ?? value };
        add(`${event}/start`, eventSpan(e, now), where, `${popover} > p`, length);
        if (e.end) add(`${event}/end`, eventSpan(e, now), where, `${popover} > p`, length);
        if (lane.id !== "holds") return;
        let offset = 0;
        environment.lanes
          .filter(({ id }) => id !== "holds")
          .forEach((other) => {
            const otherIndex = environment.lanes.indexOf(other);
            other.events.forEach((run, runIndex) => {
              if (!within(range, run.start, run.end, to) || !overlaps(e, run)) return;
              const runPointer = `/briefing/environment/lanes/${otherIndex}/events/${runIndex}`;
              add(
                `${runPointer}/detail`,
                run.detail,
                where,
                `.popover-rows > button:nth-child(${offset + 1})`,
                { contains: true },
              );
              offset += 1;
            });
          });
      });
    });
  }

  briefing.repositories.rows.forEach((repo, index) => {
    repositoryCases(repo, `/briefing/repositories/rows/${index}`, add);
  });

  const releasesPlace = home("Releases", STARTS.releases);
  const ofName = (element: Element) => (element.textContent ?? "").replace(/^SPI /, "");
  releases.lines.forEach((line, index) => {
    const pointer = `/releases/lines/${index}`;
    const row = `tr${at(pointer)}`;
    const month = home(`Release ${line.month}`, STARTS.release(line.month));
    const page = `div${at(pointer)}`;
    add(`${pointer}/name`, line.name, releasesPlace, `${row} button.release-name`, {
      read: ofName,
    });
    add(`${pointer}/notes`, line.notes, releasesPlace, `${row} .notes-chip`, {
      attribute: "data-notes",
    });
    add(`${pointer}/headline`, line.headline, releasesPlace, `${row} td:nth-child(3)`);
    add(`${pointer}/stateText`, line.stateText, releasesPlace, `${row} td:nth-child(4)`);
    const place = ".release-page > section.place";
    const notesTile = `${place} .place-tile:nth-child(1)`;
    add(`${pointer}/name`, line.name, month, "main header h1", { read: ofName });
    add(`${pointer}/headline`, line.headline, month, `${place} .place-headline`);
    add(`${pointer}/notes`, line.notes, month, `${notesTile} .place-tile-value`, {
      read: (element) => NOTES_STATE[element.textContent ?? ""] ?? "",
    });
    add(`${pointer}/stateText`, line.stateText, month, `${notesTile} .place-tile-counts`);
    line.stats.forEach((stat, at) => {
      const fact = `${page} .pane-fact:nth-child(${at + 1})`;
      add(`${pointer}/stats/${at}/short`, stat.short, month, `${fact} .pane-fact-short`);
      add(`${pointer}/stats/${at}/figure`, stat.figure, month, `${fact} strong`);
      add(`${pointer}/stats/${at}/label`, stat.label, month, `${fact} > div`);
      add(`${pointer}/stats/${at}/anchor`, stat.anchor, month, fact, { attribute: "data-anchor" });
    });
    line.keyChanges.forEach((change, at) => {
      add(
        `${pointer}/keyChanges/${at}`,
        change,
        month,
        `${page} section[aria-label="Key changes"] li:nth-child(${at + 1})`,
      );
    });
  });

  cases.push(...releaseSectionCases(snapshot, releasesPlace));

  // A queue item the service page's reading drew, with no other home, is exempted leaf by leaf.
  const serviceOf = new Map(
    snapshot.readings.flatMap(({ anchor, content }) =>
      anchor.kind === "service"
        ? (content?.items ?? []).map(({ id }) => [id, anchor.id] as const)
        : [],
    ),
  );
  const owners = items.flatMap(([pointer, item]) => {
    const service =
      serviceOf.get(item.id) ??
      (item.cls === "PORT" ? item.ids.find((id) => id.startsWith("port:"))?.slice(5) : undefined);
    return service ? [{ pointer, service }] : [];
  });
  for (const leaf of coverage(snapshot, cases).uncovered) {
    const owner = owners.find(({ pointer }) => leaf.startsWith(`${pointer}/`));
    if (owner)
      cases.push({
        pointer: leaf,
        value: "",
        home: home(`Service ${owner.service} · Reading`, STARTS.service(owner.service)),
        selector: "",
        exempt: RETIRED_SERVICE_READING,
      });
  }
  return cases;
}

function repositoryCases(
  repo: Repo,
  pointer: string,
  addCase: (
    pointer: string,
    value: unknown,
    where: Home,
    selector: Selector,
    extra?: Partial<Reach>,
  ) => void,
) {
  const service = repo.name !== "osdu-spi" && repo.name !== "osdu-spi-stack";
  const add: typeof addCase = (pointer, value, where, selector, extra = {}) =>
    addCase(pointer, value, where, selector, {
      ...extra,
      ...(service ? { exempt: RETIRED_SERVICE_REPOSITORY } : {}),
    });
  type Section = Repo["sections"][number];
  type Line = Section["lines"][number];
  const everySection = repo.name === "osdu-spi-stack";
  const drawn = repo.sections
    .map((section, index) => ({ section, index }))
    .filter(({ section }) => everySection || section.lines.length > 0);
  const sectionAt = (container: string, index: number) => (root: ParentNode) =>
    root.querySelectorAll(container)[drawn.findIndex((entry) => entry.index === index)];
  const within =
    (section: (root: ParentNode) => Element | undefined, selector: string) => (root: ParentNode) =>
      section(root)?.querySelector(selector);
  const lineAt =
    (section: (root: ParentNode) => Element | undefined, lines: string, index: number) =>
    (root: ParentNode) =>
      section(root)?.querySelectorAll(lines)[index];
  const part =
    (line: (root: ParentNode) => Element | undefined, selector: string) => (root: ParentNode) =>
      line(root)?.querySelector(selector);

  let where: Home;
  let sub: Selector;
  let note: Selector;
  let section: (index: number) => (root: ParentNode) => Element | undefined;
  let title: (section: (root: ParentNode) => Element | undefined) => Selector;
  let count: (section: (root: ParentNode) => Element | undefined) => Selector;
  let line: (
    section: (root: ParentNode) => Element | undefined,
    index: number,
  ) => (root: ParentNode) => Element | undefined;
  let parts: {
    tag: string;
    text: string;
    sub: string;
    upstream: (line: Line) => Partial<Reach> & { selector: string };
  };
  if (repo.name === "osdu-spi") {
    where = lensHome("Template · Details");
    const lead = `.template-repo-lead${at(pointer)}`;
    sub = `${lead} .template-line-sub`;
    note = "p.template-note";
    section = (index) => sectionAt(".template-repo-section", index);
    title = (s) => (root) => {
      const h3 = s(root)?.querySelector("h3");
      return h3 ?? undefined;
    };
    count = (s) => within(s, "h3 .inbox-section-count");
    line = (s, index) => lineAt(s, "ul.template-lines > li", index);
    parts = {
      tag: ".template-line-tag",
      text: ".template-line-text",
      sub: ".template-line-sub",
      upstream: () => ({ selector: ":scope", attribute: "data-upstream" }),
    };
  } else if (repo.name === "osdu-spi-stack") {
    where = lensHome("Environment · Stack repository");
    sub = (root) => root.querySelector(`${at(`${pointer}/title`)} + p.env-muted`);
    note = '[data-part="repository"] .env-part-body > p.env-muted:last-child';
    section = (index) => sectionAt(".env-repo-section", index);
    title = (s) => within(s, "h3");
    count = (s) => within(s, "h3 > small");
    line = (s, index) => lineAt(s, ".env-repo-line", index);
    parts = {
      tag: ".env-repo-tag",
      text: ".env-repo-line-text",
      sub: ".env-repo-line-text + small",
      upstream: () => ({ selector: "small:last-child" }),
    };
  } else {
    where = lensHome(`Service ${repo.name} · Repository`);
    const scope = '[data-section="repository"]';
    sub = `${scope} [aria-label=${quote(`${repo.name} repository`)}] .service-row-sub`;
    note = `${scope} p.service-empty`;
    section = (index) => sectionAt(`${scope} .service-repo-section`, index);
    title = (s) => within(s, ".repo-section-title > span:first-child");
    count = (s) => within(s, ".repo-section-title > span:nth-child(2)");
    line = (s, index) => lineAt(s, ".service-row", index);
    parts = {
      tag: ".service-tag",
      text: ".service-row-title",
      sub: ".service-row-sub",
      upstream: () => ({ selector: ".service-row-body", attribute: "data-upstream" }),
    };
  }
  if (repo.sub) add(`${pointer}/sub`, plainTitle(repo.sub), where, sub);
  if (repo.note) add(`${pointer}/note`, repo.note, where, note);
  drawn.forEach(({ section: entry, index }) => {
    const s = section(index);
    const base = `${pointer}/sections/${index}`;
    const titled = title(s);
    add(`${base}/title`, entry.title, where, titled, {
      read: (element) =>
        (element.tagName === "H3" ? ownText(element) : (element.textContent ?? "")).trim(),
    });
    add(`${base}/count`, entry.count, where, count(s), { contains: true });
    if (entry.rest) add(`${base}/rest`, entry.rest, where, count(s), { contains: true });
    entry.lines.forEach((value, at) => {
      const l = line(s, at);
      const linePointer = `${base}/lines/${at}`;
      add(`${linePointer}/tag`, value.tag, where, part(l, parts.tag));
      add(`${linePointer}/text`, plainTitle(value.text), where, part(l, parts.text));
      if (value.sub) add(`${linePointer}/sub`, plainTitle(value.sub), where, part(l, parts.sub));
      if (value.upstream) {
        const { selector, ...extra } = parts.upstream(value);
        add(
          `${linePointer}/upstream`,
          extra.attribute ? "true" : "upstream",
          where,
          (root) => (selector === ":scope" ? l(root) : l(root)?.querySelector(selector)),
          extra,
        );
      }
    });
  });
}

type Add = (
  pointer: string,
  value: unknown,
  where: Home,
  selector: Selector,
  extra?: Partial<Reach>,
) => void;

/** Each focus and rest item, with its pointer. */
export function briefingItems(briefing: ViewSnapshot["briefing"]) {
  return [
    ...briefing.focus.map((item, index) => [`/briefing/focus/${index}`, item] as const),
    ...briefing.rest.map((item, index) => [`/briefing/rest/${index}`, item] as const),
  ];
}

/** A member's row: its line's own row when it is the only member, else its sub-row. */
export const memberRow = (line: string, member: number, single: boolean) =>
  single
    ? `tr.today-row:not(.today-row--sub)${at(line)}`
    : `tr.today-row--sub${at(`${line}/members/${member}`)}`;

/** Today's Blocked and Waiting on you: each line's row, and a sub-row per member of a group. */
export function tableCases(snapshot: ViewSnapshot): Reach[] {
  const cases: Reach[] = [];
  const add: Add = (pointer, value, where, selector, extra = {}) => {
    cases.push({ pointer, value: String(value), home: where, selector, ...extra });
  };
  const items = briefingItems(snapshot.briefing);
  (snapshot.briefing.lines ?? []).forEach((line, index) => {
    const pointer = `/briefing/lines/${index}`;
    const head = `tr.today-row:not(.today-row--sub)${at(pointer)}`;
    const single = line.members.length === 1 && !line.rollout;
    add(`${pointer}/id`, line.id, TODAY, head, { attribute: "data-line-id" });
    add(
      `${pointer}/section`,
      line.section,
      TODAY,
      (root) => root.querySelector(head)?.closest("section"),
      { attribute: "data-section" },
    );
    add(`${pointer}/subject`, line.subject, TODAY, `${head} .today-fork-name`);
    add(`${pointer}/headline`, plainTitle(line.headline), TODAY, `${head} .today-row-what button`);
    if (line.rollout) {
      const item = items.find(([, entry]) => entry.id === "rollout");
      if (item?.[1].origin)
        add(`${item[0]}/origin`, item[1].origin, TODAY, head, {
          attribute: "data-origin",
          opens: {
            click: `${head} .today-row-what button`,
            opened: `${head}[data-open] + tr .opened-body`,
          },
        });
    }
    line.rollout?.withoutPr.forEach((fork, at_) => {
      const open = home("Today, rollout", STARTS.today, `${head} .today-row-what button`);
      add(
        `${pointer}/rollout/withoutPr/${at_}`,
        fork,
        open,
        `${head} + tr .today-rollout-detail span`,
        {
          contains: true,
        },
      );
    });
    if (line.age)
      add(`${pointer}/age`, ageInOneUnit(line.age), TODAY, `${head} .today-row-age-text`);
    if (line.deadline)
      add(
        `${pointer}/deadline/reason`,
        plainTitle(timedText(line.deadline.reason, { hint: false })),
        TODAY,
        `${head} .today-row-clock`,
        {
          attribute: "aria-label",
        },
      );
    line.members.forEach((member, at_) => {
      const base = `${pointer}/members/${at_}`;
      const row = memberRow(pointer, at_, single);
      add(`${base}/id`, member.id, TODAY, row, { attribute: "data-item-id" });
      const fork = single ? line.subject : member.fork;
      const opens = {
        click: `${row} .today-row-what button`,
        opened: `${row}[data-open] + tr.today-row-body .opened-body`,
      };
      for (const [item, entry] of items) {
        if (entry.id !== member.id && !member.ids.includes(entry.id)) continue;
        if (entry.origin)
          add(`${item}/origin`, entry.origin, TODAY, row, {
            attribute: "data-origin",
            contains: true,
            opens,
          });
        if (entry.scope === fork)
          add(`${item}/scope`, entry.scope, TODAY, `${row} .today-fork-name`, { opens });
      }
      if (member.age)
        add(`${base}/age`, ageInOneUnit(member.age), TODAY, `${row} .today-row-age-text`);
      if (member.station)
        add(`${base}/station`, member.station, TODAY, row, { attribute: "data-station" });
      if (member.primary)
        add(`${base}/primary/url`, member.primary.url, TODAY, `${row} .today-row-open a`, {
          attribute: "href",
        });
    });
  });
  return cases;
}

const LOWER_DESTINATIONS: Readonly<Record<string, Destination>> = {
  line: STARTS.forks.route,
  environment: { kind: "environment" },
  engineering: { kind: "engineering-system" },
  upstream: { kind: "upstream" },
  releases: { kind: "releases" },
  security: { kind: "security" },
};

const ACTIVITY = home("Today, Activity", STARTS.today, '[data-today-tab="activity"]');

/** Moving without you and Last 24 hours on Activity, each row's fields and the place it opens; the fleet flow and Can wait on Yours. */
export function lowerCases(snapshot: ViewSnapshot): Reach[] {
  const today = snapshot.briefing.today;
  if (!today) return [];
  const cases: Reach[] = [];
  const add: Add = (pointer, value, where, selector, extra = {}) => {
    cases.push({ pointer, value: String(value), home: where, selector, ...extra });
  };
  const base = "/briefing/today";
  const row = (section: string, id: string) =>
    `[data-section="${section}"] tr.today-row--place[data-row=${quote(id)}]`;
  const place = (
    pointer: string,
    tr: string,
    key: string,
    id: string,
    label: string,
    to: string,
  ) => {
    const button = `${tr} .today-row-fork button`;
    const destination = LOWER_DESTINATIONS[to];
    add(`${pointer}/${key}`, id, ACTIVITY, tr, { attribute: "data-row" });
    add(`${pointer}/label`, label, ACTIVITY, button, {
      ...(destination ? { opens: { click: button, place: destination } } : {}),
    });
    add(`${pointer}/place`, to, ACTIVITY, tr, { attribute: "data-place" });
  };
  type Count = NonNullable<
    ViewSnapshot["briefing"]["today"]
  >["history"]["rows"][number]["counts"][number];
  const counts = (pointer: string, tr: string, list: readonly Count[]) =>
    list.forEach((count, at) => {
      if (count.count === 0) return;
      const span = `${tr} .today-count[data-kind=${quote(count.kind)}]`;
      const leaf = `${pointer}/counts/${at}`;
      add(`${leaf}/count`, count.count, ACTIVITY, span, {
        read: (element) => (element.textContent ?? "").split(" ")[0] ?? "",
      });
      add(`${leaf}/label`, count.label, ACTIVITY, span, {
        read: (element) => (element.textContent ?? "").split(" ").slice(1).join(" "),
      });
      add(`${leaf}/kind`, count.kind, ACTIVITY, span, { attribute: "data-kind" });
      add(`${leaf}/tone`, count.tone, ACTIVITY, span, { attribute: "data-tone" });
      count.names.forEach((name, i) => {
        add(`${leaf}/names/${i}`, name, ACTIVITY, span, { attribute: "title", contains: true });
      });
    });
  today.moving.forEach((entry, index) => {
    const pointer = `${base}/moving/${index}`;
    const tr = row("moving", entry.id);
    place(pointer, tr, "id", entry.id, entry.label, entry.place);
    if (entry.at)
      add(`${pointer}/at`, entry.at, ACTIVITY, `${tr} .today-row-when time`, {
        attribute: "dateTime",
      });
    else add(`${pointer}/time`, entry.time, ACTIVITY, `${tr} .today-row-when`);
    const words = `${tr} .today-row-moving`;
    add(`${pointer}/count`, entry.count, ACTIVITY, words, { attribute: "data-count" });
    entry.names.forEach((name, at) => {
      add(`${pointer}/names/${at}`, name, ACTIVITY, words, { attribute: "title", contains: true });
    });
  });
  const { history } = today;
  const head = '[data-section="history"] .today-section-head';
  const basis = (element: Element) => {
    const text = element.textContent ?? "";
    if (text.startsWith("Since you last looked")) return "seen";
    if (text.startsWith("Since ")) return "history-short";
    return text.startsWith("24 hours to ") ? "stale" : "fallback";
  };
  add(`${base}/history/basis`, history.basis, ACTIVITY, head, { read: basis });
  if (history.basis === "seen" || history.basis === "history-short")
    add(`${base}/history/from`, history.from, ACTIVITY, `${head} time`, { attribute: "dateTime" });
  if (history.asOf && history.basis !== "seen" && history.basis !== "history-short")
    add(`${base}/history/asOf`, history.asOf, ACTIVITY, `${head} time`, { attribute: "dateTime" });
  history.rows.forEach((entry, index) => {
    const pointer = `${base}/history/rows/${index}`;
    const tr = row("history", entry.workflow);
    place(pointer, tr, "workflow", entry.workflow, entry.label, entry.place);
    counts(pointer, tr, entry.counts);
  });
  fleetCases(today, add);
  forkCases(today, snapshot.services, add);
  causeCases(today, add);
  return cases;
}

type Summary = NonNullable<ViewSnapshot["briefing"]["today"]>;

/** A figure's word as its count: "None open" and "Sync current" read 0. */
const figureCount = (element: Element) => {
  const text = element.textContent ?? "";
  return text.match(/^(\d+)/)?.[1] ?? (/^(None|Sync current|⌀ not read)/.test(text) ? "0" : text);
};
const ENVIRONMENT_STATES: Readonly<Record<string, string>> = {
  green: "ready",
  stopped: "maintenance",
  unread: "unread",
};

/** The fleet flow on Yours: each station's and door's figure, the forks behind it, and where it opens. */
function fleetCases(today: Summary, add: Add) {
  const { fleet } = today;
  if (!fleet) return;
  const base = "/briefing/today/fleet";
  const forks = (pointer: string, selector: string, lists: Record<string, readonly string[]>) => {
    for (const [key, list] of Object.entries(lists))
      list.forEach((fork, at) => {
        add(`${pointer}/${key}/${at}`, fork, TODAY, selector, {
          attribute: "title",
          contains: true,
        });
      });
  };
  fleet.stations.forEach((figure, index) => {
    const pointer = `${base}/stations/${index}`;
    const station = `[data-station=${quote(figure.id)}]`;
    add(`${pointer}/id`, figure.id, TODAY, station, { attribute: "data-station" });
    if (figure.id === "main")
      add(`${pointer}/count`, figure.count, TODAY, station, {
        read: (element) =>
          (element.textContent ?? "").match(/(\d+) green/)?.[1] ??
          figureCount(element.querySelector(".flow-word") ?? element),
      });
    else
      add(`${pointer}/count`, figure.count, TODAY, `${station} .flow-word`, { read: figureCount });
    const {
      forks: counted,
      notRead,
      stopped,
      red,
      inProgress,
      waitingOnClock,
      waitingOnPerson,
    } = figure;
    forks(pointer, station, {
      forks: counted,
      notRead,
      stopped,
      red,
      inProgress,
      waitingOnClock,
      waitingOnPerson,
    });
  });
  fleet.doors.forEach((figure, index) => {
    const pointer = `${base}/doors/${index}`;
    const door = `[data-door=${quote(figure.id)}]`;
    add(`${pointer}/id`, figure.id, TODAY, door, { attribute: "data-door" });
    add(`${pointer}/count`, figure.count, TODAY, `${door} .flow-door-word`, { read: figureCount });
    forks(pointer, door, { forks: figure.forks, notRead: figure.notRead });
    const { target } = figure;
    if (!target) return;
    add(`${pointer}/target/kind`, target.kind, TODAY, door, {
      read: (element) => (element.hasAttribute("aria-pressed") ? "station" : "cause"),
    });
    if (target.kind === "station")
      add(`${pointer}/target/station`, target.station, TODAY, door, { attribute: "data-target" });
    else
      add(`${pointer}/target/row`, target.row, TODAY, door, {
        attribute: "data-target",
        opens: {
          click: door,
          opened: `tr.today-row--cause[data-row=${quote(target.row)}][data-open]`,
        },
      });
  });
  if (fleet.nextSyncAt)
    add(
      `${base}/nextSyncAt`,
      `next sync ${when(fleet.nextSyncAt)}`,
      TODAY,
      '[data-station="upstream"] .flow-line',
    );
  const environment = '[data-station="environment"]';
  add(`${base}/environment/state`, fleet.environment.state, TODAY, environment, {
    read: (element) => ENVIRONMENT_STATES[element.getAttribute("data-state") ?? ""] ?? "",
  });
  if (fleet.environment.version)
    add(
      `${base}/environment/version`,
      fleet.environment.version,
      TODAY,
      `${environment} .flow-line`,
    );
}

/** Can wait on Yours: a row per cause, and in its opened body the forks, packages and rules. */
function causeCases(today: Summary, add: Add) {
  const { causes } = today;
  if (!causes) return;
  const base = "/briefing/today/causes";
  causes.rows.forEach((cause, index) => {
    const pointer = `${base}/rows/${index}`;
    const tr = `tr.today-row--cause[data-row=${quote(cause.id)}]`;
    const open = home(`Today, Can wait ${cause.id}`, STARTS.today, `${tr} .today-row-what button`);
    const body = `${tr} + tr.today-row-body`;
    add(`${pointer}/id`, cause.id, TODAY, tr, { attribute: "data-row" });
    add(`${pointer}/kind`, cause.kind, TODAY, tr, { attribute: "data-cause" });
    add(`${pointer}/headline`, plainTitle(cause.headline), TODAY, `${tr} .today-row-what button`, {
      opens: { click: `${tr} .today-row-what button`, opened: `${body} .today-cause-pills` },
    });
    const groupUnread = cause.forks.some(({ group }) => group === undefined || group === "unknown");
    const legacy = cause.forks.some(({ group }) => group === undefined);
    const countUnread = cause.count === 0 && (groupUnread || causes.notRead[cause.kind].length > 0);
    add(`${pointer}/count`, cause.count, TODAY, `${tr} .today-row-age`, {
      read: (element) => (element.textContent ?? "").match(/(\d+) \S+$/)?.[1] ?? "",
      blank: legacy || countUnread,
    });
    add(`${pointer}/forkCount`, legacy ? 0 : cause.forkCount, TODAY, tr, {
      attribute: "data-fork-count",
    });
    if (cause.place)
      add(`${pointer}/place`, cause.place, TODAY, `${tr} .today-row-place`, {
        attribute: "data-place",
      });
    const programOnly = cause.forks.every(({ group }) => group === "program");
    cause.forks.forEach(({ fork, group, notRead }, at) => {
      const shelf = programOnly
        ? ".today-cause-repositories"
        : group !== "fork"
          ? ".today-cause-outside"
          : notRead
            ? ".today-cause-unread"
            : ".today-cause-forks";
      const chip = `${body} ${shelf} [data-cause-entry="${at}"]`;
      add(`${pointer}/forks/${at}/fork`, fork, open, chip, {
        read: (element) => (element.textContent ?? "").split(" ")[0] ?? "",
      });
      if (group)
        add(`${pointer}/forks/${at}/group`, group, open, chip, {
          read: () => group,
        });
      if (notRead)
        add(`${pointer}/forks/${at}/notRead`, notRead, open, chip, {
          read: (element) => String(!!element.closest(".today-cause-unread")),
        });
    });
    if (cause.remainder)
      for (const section of ["blocked", "waiting"] as const) {
        const count = cause.remainder[section];
        add(`${pointer}/remainder/${section}`, count, open, `${body} .today-cause-body`, {
          read: (element) =>
            element.querySelector(`[data-remainder=${section}]`)?.textContent?.split(" ")[0] ?? "",
          blank: count === 0,
        });
      }
    cause.packages?.forEach((entry, at) => {
      const li = `${body} .today-cause-packages li:nth-child(${at + 1})`;
      const leaf = `${pointer}/packages/${at}`;
      add(`${leaf}/ecosystem`, entry.ecosystem, open, li, { contains: true });
      add(`${leaf}/name`, entry.name, open, li, { contains: true });
      entry.forks.forEach((fork, i) => {
        add(`${leaf}/forks/${i}`, fork, open, li, { contains: true });
      });
    });
    if (cause.rules)
      for (const which of ["mostAlerts", "mostForks"] as const)
        for (const key of ["name", "count"] as const)
          add(
            `${pointer}/rules/${which}/${key}`,
            cause.rules[which][key],
            open,
            `${body} .today-cause-rules`,
            { contains: true },
          );
  });
  for (const [kind, forks] of Object.entries(causes.notRead))
    forks.forEach((fork, at) => {
      const row = causes.rows.find((cause) => cause.kind === kind);
      add(
        `${base}/notRead/${kind}/${at}`,
        fork,
        TODAY,
        row
          ? `tr.today-row--cause[data-row=${quote(row.id)}] .today-row-gaps`
          : `[data-unread=${quote(kind)}]`,
        row ? { attribute: "title", contains: true } : { contains: true },
      );
    });
}

/** The focus or rest item a leaf belongs to. */
function itemAt(pointer: string, { briefing }: Leaves) {
  const [, list, index] = pointer.match(/^\/briefing\/(focus|rest)\/(\d+)\//) ?? [];
  return list === "focus" || list === "rest" ? briefing[list][Number(index)] : undefined;
}

const FLEET = "/briefing/today/fleet";
const FOLD_FIGURES = `${FLEET}/forks/rest`;

function unreadRestForks(fleet: TodayFleet, services: ViewSnapshot["services"]) {
  return new Set(
    fleet.forks.rest.forks.filter(
      (fork) =>
        readFork(fleet, fork, services?.find(({ service }) => service === fork)?.home).unread,
    ),
  );
}

function forkCases(today: Summary, services: ViewSnapshot["services"], add: Add) {
  const fleet = today.fleet;
  if (!fleet) return;
  const { yours, stopped, rest } = fleet.forks;
  const unread = unreadRestForks(fleet, services);
  const forkCase = (pointer: string, fork: string, group: string, where: Home) => {
    const row = `[data-fork-group=${group}] tr[data-fork=${quote(fork)}]`;
    add(
      pointer,
      fork,
      where,
      `${row} th button`,
      where === UNFOLDED
        ? {}
        : {
            opens: {
              click: `${row} button[aria-expanded]`,
              opened: `${row} + tr[data-open-fork=${quote(fork)}]`,
            },
          },
    );
  };
  for (const [index, fork] of yours.entries())
    forkCase(`${FLEET}/forks/yours/${index}`, fork, "yours", FORKS);
  for (const [index, fork] of stopped.entries())
    add(`${FLEET}/forks/stopped/${index}`, fork, FORKS, "[data-today-tab=forks] .today-tab-count", {
      attribute: "title",
      contains: true,
    });
  for (const [index, fork] of rest.forks.entries()) {
    const isUnread = unread.has(fork);
    forkCase(
      `${FOLD_FIGURES}/forks/${index}`,
      fork,
      isUnread ? "unread" : "quiet",
      isUnread ? FORKS : UNFOLDED,
    );
  }
  for (const [kind, figures] of [
    ["stations", rest.stations],
    ["doors", rest.doors],
  ] as const)
    figures.forEach(({ id, count, forks }, index) => {
      if (!foldCount(kind, id, count, forks, unread)) return;
      add(
        `${FOLD_FIGURES}/${kind}/${index}/count`,
        count,
        FORKS,
        `.forks-fold [data-hold=${quote(id)}]`,
        {
          read: (element) => (element.textContent ?? "").split(" ")[0] ?? "",
        },
      );
    });
}

function foldCount(
  kind: string,
  id: string,
  count: number,
  forks: readonly string[],
  unread: Set<string>,
) {
  return (
    count > 0 &&
    (kind === "doors" || id === "sync" || id === "integration") &&
    !forks.some((fork) => unread.has(fork))
  );
}

/** Item leaves Today draws at the item's place rather than on Today itself, each with its reason. */
export const AT_PLACE: Readonly<Record<string, Exemption>> = {
  "row-names-forks": {
    patterns: ["/briefing/focus/#/scope", "/briefing/rest/#/scope"],
    reason:
      "spicode-djg.10: a Today row names the forks it covers (13 forks), not core's scope; the template rollout's scope shows at Template",
    when: (_value, { pointer, snapshot }) => {
      const item = itemAt(pointer, snapshot);
      return (snapshot.briefing.lines ?? []).some(
        ({ subject, members, rollout }) =>
          (rollout && item?.id === "rollout") ||
          members.some(
            ({ id, ids, fork }) =>
              item !== undefined &&
              (id === item.id || ids.includes(item.id)) &&
              (members.length === 1 ? subject : fork) !== item.scope,
          ),
      );
    },
  },
};

/** Leaves the window draws nowhere by design, each with the reason or the bead that owns it. */
export const EXEMPTIONS: Readonly<Record<string, Exemption>> = {
  "legacy-line": {
    patterns: ["/briefing/places/#/fresh/itemIds/#"],
    reason:
      "D5: Forks shows Service Home station words and the current Yours rows after the Line sheet retired",
    when: (_value, { pointer, snapshot }) =>
      snapshot.briefing.places?.[Number(pointer.split("/")[3])]?.place === "line",
    pending: true,
  },
  "fold-readings": {
    patterns: [`${FOLD_FIGURES}/doors/#/count`, `${FOLD_FIGURES}/stations/#/count`],
    reason:
      "The fold summarizes open PRs on hidden forks, excluding zero counts and visible unread forks",
    when: (_value, { pointer, snapshot }) => {
      const fleet = snapshot.briefing.today?.fleet;
      if (!fleet) return false;
      const parts = pointer.split("/");
      const kind = parts.at(-3) === "doors" ? "doors" : "stations";
      const figure = fleet.forks.rest[kind][Number(parts.at(-2))];
      return (
        !!figure &&
        !foldCount(
          kind,
          figure.id,
          figure.count,
          figure.forks,
          unreadRestForks(fleet, snapshot.services),
        )
      );
    },
    pending: true,
  },
  "fold-figure-detail": {
    patterns: [
      ...[
        "id",
        "forks/#",
        "notRead/#",
        "stopped/#",
        "red/#",
        "inProgress/#",
        "waitingOnClock/#",
        "waitingOnPerson/#",
      ].map((field) => `${FOLD_FIGURES}/stations/#/${field}`),
      ...["id", "forks/#", "notRead/#"].map((field) => `${FOLD_FIGURES}/doors/#/${field}`),
    ],
    reason:
      "The fold gives PR totals. Figure keys and membership are in the fleet flow and individual Forks rows",
    pending: true,
  },
  "today-join": {
    patterns: ["/briefing/repositories/rows/#/sections/#/lines/#/onToday/rel"],
    reason:
      "spicode-djg.25: a line's source or companion join to its Today member is marked alike; rel names which",
  },
  "can-wait-piles": {
    patterns: [
      "id",
      "label",
      "place",
      "notRead/#",
      ...["count", "kind", "label", "tone", "names/#", "urls/#"].map((leaf) => `counts/#/${leaf}`),
    ].map((leaf) => `/briefing/today/canWait/#/${leaf}`),
    reason:
      "spicode-mw0.12: Today's Can wait draws core's causes; the piles stay only as the opened body's counted Can wait URLs",
  },
  "cause-objects": {
    patterns: [
      "forks/#/count",
      ...["id", "url", "label", "age", "count"].map((leaf) => `forks/#/objects/#/${leaf}`),
    ].map((leaf) => `/briefing/today/causes/rows/#/${leaf}`),
    reason:
      "spicode-mw0.12: a cause's fork pill names the fork and what it holds, and opens the service page row holding its objects",
  },
  "today-moving-time": {
    patterns: ["/briefing/today/moving/#/time"],
    reason:
      "spicode-djg.10: a moving row with an instant draws `at` through the window's clock; core's words show only without one",
    when: (_value, { pointer, snapshot }) =>
      snapshot.briefing.today?.moving[Number(pointer.split("/")[4])]?.at !== undefined,
  },
  "today-history-window": {
    patterns: ["/briefing/today/history/from"],
    reason:
      "spicode-djg.10: the heading names a fallback window Last 24 hours, and a stale one by the time it runs to",
    when: (_value, { snapshot }) =>
      !["seen", "history-short"].includes(snapshot.briefing.today?.history.basis ?? ""),
  },
  "today-history-gaps": {
    patterns: ["/briefing/today/history/rows/#/notRead/#"],
    reason:
      "spicode-djg.10: a workflow's unread forks are its not read count, named on hover; Evidence lists the reads",
  },
  "today-ready-release": {
    patterns: [
      "/releases/today/ready/#/name",
      "/releases/today/ready/#/number",
      "/releases/today/ready/#/url",
    ],
    reason:
      "spicode-djg.10: Can wait's ready to merge count names the ready release PR, from the same queue",
  },
  "today-horizon": {
    patterns: [
      ...["nextSyncCount", "heldCount", "heldPrCount", "currentForkCount"].map(
        (leaf) => `/briefing/horizon/compact/${leaf}`,
      ),
      ...[
        "upstream/count",
        "upstream/text",
        "nextSync/at",
        "nextSync/count",
        "nextSync/services/#",
        "nextSync/text",
        "held/count",
        "held/prs/#/service",
        "held/prs/#/pr/number",
        "held/prs/#/pr/url",
        "held/prs/#/pr/inspect",
        "held/services/#",
        "held/text",
        "forks/services/#",
        "forks/text",
        "wontLand/#/service",
        "wontLand/#/reason",
        "wontLand/#/count",
        "wontLand/#/text",
      ].map((leaf) => `/briefing/horizon/stages/${leaf}`),
      ...[
        "id",
        "kind",
        "token",
        "services/#/service",
        "services/#/stage",
        "services/#/at",
        "services/#/pr/number",
        "services/#/pr/url",
        "services/#/pr/inspect",
        "needsYou",
        "mark",
        "verb",
        "itemIds/#",
        "text",
      ].map((leaf) => `/briefing/horizon/cards/#/${leaf}`),
      ...["needYouCards", "toWatchCards", "surfaceItems", "text"].map(
        (leaf) => `/briefing/horizon/counts/${leaf}`,
      ),
      ...["itemIds/#", "count", "services/#/service", "services/#/count", "text"].map(
        (leaf) => `/briefing/horizon/owed/${leaf}`,
      ),
    ],
    reason:
      "spicode-djg.10: Today no longer draws On the horizon (X7); each item it held is a row on Today or listed at its place (PS-19)",
  },
  "today-place-cards": {
    patterns: [
      ...["place", "mark", "tone", "figure", "line", "reason", "caveat", "areas/#"].map(
        (leaf) => `/briefing/places/#/${leaf}`,
      ),
      ...["unread/areas/#", "itemIds/#"].map((leaf) => `/briefing/places/#/${leaf}`),
      ...[
        "kind",
        "slots/#/service",
        "slots/#/state",
        "slots/#/origin",
        "slots/#/text",
        "stopped/#",
        "horizon/count",
        "horizon/text",
        "lanes/#/lane",
        "lanes/#/state",
        "lanes/#/green",
        "lanes/#/total",
        "lanes/#/text",
        "greenSince",
        "target",
        "columns/#/service",
        "columns/#/count",
        "columns/#/text",
        "program/count",
        "program/text",
      ].map((leaf) => `/briefing/places/#/visual/${leaf}`),
    ],
    reason:
      "spicode-djg.10: Today no longer draws place cards (X8); the sidebar and each place's head carry their status, and a new item keeps its chip at its place",
  },
  "today-releases": {
    patterns: [
      "/releases/today/versions/#/text",
      "/releases/today/versions/#/state",
      "/releases/today/platform/text",
      "/releases/today/readyLine",
      "/releases/today/unread/areas/#",
    ],
    reason:
      "spicode-djg.10: Today no longer draws Releases (X7); Releases draws each version and the platform from their own fields, and Can wait counts the release PRs",
  },
  "today-member-home": {
    patterns: ["/briefing/lines/#/members/#/home"],
    reason:
      "Core's routing key for place head counts and steppers; members.test.tsx checks the partition on every fixture",
  },
  "today-lines": {
    patterns: [
      "/briefing/lines/#/cause",
      "/briefing/lines/#/deadline/at",
      "/briefing/lines/#/effect",
      "/briefing/lines/#/members/#/cause",
      "/briefing/lines/#/members/#/deadline/at",
      "/briefing/lines/#/members/#/deadline/reason",
      "/briefing/lines/#/members/#/effect",
      "/briefing/lines/#/members/#/evidence/areas/#",
      "/briefing/lines/#/members/#/evidence/attributed",
      "/briefing/lines/#/members/#/fork",
      "/briefing/lines/#/members/#/ids/#",
      "/briefing/lines/#/members/#/primary/kind",
      "/briefing/lines/#/members/#/primary/label",
      "/briefing/lines/#/members/#/since",
      "/briefing/lines/#/members/#/steps/#",
      "/briefing/lines/#/members/#/subject",
      "/briefing/lines/#/steps/#",
    ],
    reason:
      "spicode-djg.9: these line fields show only in a row's opened body (spicode-djg.8), or are core's join keys",
  },
  transport: {
    patterns: [
      "/briefing/focus/#/id",
      "/briefing/focus/#/ids/#",
      "/briefing/focus/#/evidence/#/url",
      "/briefing/rest/#/id",
      "/briefing/rest/#/ids/#",
      "/briefing/rest/#/evidence/#/url",
      "/briefing/themes/#/id",
      "/briefing/themes/#/inspect",
      "/briefing/themes/#/certain/#/url",
      "/briefing/themes/#/possible/#/url",
      "/briefing/themes/#/possible/#/inspect",
      "/briefing/flow/inspect",
      "/briefing/flow/rows/#/inspect",
      "/briefing/flow/also/#/inspect",
      "/briefing/environment/lanes/#/id",
      "/briefing/environment/lanes/#/events/#/id",
      "/briefing/environment/borrows/#/id",
      "/briefing/repositories/first",
      "/briefing/repositories/rows/#/id",
      "/briefing/repositories/rows/#/sections/#/lines/#/id",
      "/briefing/repositories/rows/#/sections/#/lines/#/url",
      "/briefing/repositories/rows/#/sections/#/lines/#/onToday/id",
      "/releases/lines/#/id",
    ],
    reason: "Transport: ids, inspect ids and links the window keys rows and opens Detail with",
  },
  styling: {
    patterns: [
      "/briefing/focus/#/attention",
      "/briefing/rest/#/attention",
      "/briefing/themes/#/tone",
      "/briefing/flow/tiles/#/tone",
      "/briefing/flow/rows/#/ready/tone",
      "/briefing/flow/rows/#/plan/tone",
      "/briefing/flow/rows/#/plan/kind",
      "/briefing/flow/rows/#/line/#/tone",
      "/briefing/flow/rows/#/next/tone",
      "/briefing/flow/rows/#/next/strong",
      "/briefing/environment/facts/#/tone",
      "/briefing/repositories/template/tone",
      "/briefing/repositories/facts/#/tone",
      "/briefing/repositories/rows/#/tone",
      "/briefing/repositories/rows/#/cells/changes/tone",
      "/briefing/repositories/rows/#/cells/dependabot/tone",
      "/briefing/repositories/rows/#/cells/issues/tone",
      "/briefing/repositories/rows/#/cells/issues/fade",
      "/briefing/repositories/rows/#/cells/vulnerabilities/tone",
      "/briefing/repositories/rows/#/cells/codeScanning/tone",
      "/briefing/repositories/rows/#/sections/#/lines/#/tone",
      "/releases/lines/#/open",
    ],
    reason: "Styling and grouping metadata, drawn as tone, order or a data attribute",
  },
  "empty-run": {
    patterns: ["/briefing/ambient/inProgress/items", "/briefing/ambient/inProgress/text"],
    reason: "An empty In progress run draws no heading and no 0 count (today-design 'Calm first')",
    when: (value) => value === 0 || value === "0 in 0",
  },
  "item-chips": {
    patterns: ["/briefing/focus/#/age", "/briefing/rest/#/age"],
    reason:
      "Only a Needs you card draws an item's own age chip; a decision, a horizon card and an Ambient line carry their own figures (today-design 'Words and visuals')",
    when: (_value, { pointer, snapshot }) => itemAt(pointer, snapshot)?.attention !== "interrupt",
  },
  "empty-failing-run": {
    patterns: ["/briefing/ambient/failing/items", "/briefing/ambient/failing/text"],
    reason: "A run with no lines draws nothing, never an empty heading (today-design 'Calm first')",
  },
  "releases-reading": {
    patterns: ["/releases/reading"],
    reason: "Read state: ReleaseMonth words it as its status line, not as a field",
  },
  verb: {
    patterns: ["/briefing/focus/#/verb", "/briefing/rest/#/verb"],
    reason:
      "Only a Needs you card draws an item's verb; the rest wait for actions to ship (PS-04, CO-05; spicode-t1k.56)",
    when: (_value, { pointer, snapshot }) => itemAt(pointer, snapshot)?.attention !== "interrupt",
  },
  "unset-flag": {
    patterns: ["/briefing/focus/#/owned", "/briefing/rest/#/owned", "/briefing/flow/next/quiet"],
    reason: "An unset flag draws nothing",
    when: (value) => value === false,
  },
  axis: {
    patterns: ["/briefing/environment/to"],
    reason: "The 24-hour timeline's right edge and reference clock",
  },
  "environment-activity-words": {
    patterns: ["borrow", "unknown", "missed", "byHand"].map(
      (field) => `/briefing/environment/activity/words/${field}`,
    ),
    reason:
      "No range of the recorded week has a single borrow, an unknown end, a missed nightly or a manual run.",
    when: (_value, { pointer, snapshot }) => {
      const word = pointer.split("/").at(-1);
      return activitiesOf(snapshot.briefing.environment).every(
        (activity) =>
          !activity?.summary.some(({ part }) => part === word) &&
          !activity?.legend.some(([mark]) => mark === word),
      );
    },
  },
  "environment-activity-partition": {
    patterns: ["kind", "start", "end"].map(
      (field) => `/briefing/environment/activity/segments/#/${field}`,
    ),
    reason:
      "The partition measures maintenance and idle time in the summary. The row labels the whole hold and long idle gaps.",
    when: (_value, { pointer, snapshot }) => {
      const index = Number(/segments\/(\d+)/.exec(pointer)?.[1]);
      const kind = snapshot.briefing.environment.activity?.segments[index]?.kind;
      return kind === "maintenance" || kind === "idle";
    },
  },
  "environment-held-lane": {
    patterns: [
      "/briefing/environment/lanes/#/label",
      "/briefing/environment/lanes/#/events/#/detail",
    ],
    reason:
      "The Held lane feeds Detail and legacy snapshots. The Activity row opens holds on the place.",
    when: (_value, { pointer, snapshot }) => {
      const env = snapshot.briefing.environment;
      const index = Number(/lanes\/(\d+)/.exec(pointer)?.[1]);
      return !!env.activity && env.lanes[index]?.id === "holds";
    },
  },
  "environment-last-range": {
    patterns: ["from", "to"].map((field) => `/briefing/environment/lanes/#/lasts/#/${field}`),
    reason: "Transport: the range a lane's last run stands for, matched against the drawn range",
  },
  "environment-live-selection": {
    patterns: ["/briefing/environment/status/live/#/id"],
    reason: "Transport: the deployment id opens the live borrow",
    pending: true,
  },
  "environment-legacy-facts": {
    patterns: [
      "/briefing/environment/facts/#/label",
      "/briefing/environment/facts/#/figure",
      "/briefing/environment/facts/#/sub",
    ],
    reason:
      "The default briefing keeps the legacy tile fields. The app draws the facts line and the sidebar uses the running version.",
    when: (_value, { pointer, snapshot }) => {
      const [, index, field] = /facts\/(\d+)\/(\w+)/.exec(pointer) ?? [];
      const fact = snapshot.briefing.environment.facts[Number(index)];
      return field !== "figure" || fact?.label !== "Running" || fact.figure === "?";
    },
  },
  "lens-button": {
    patterns: ["/briefing/flow/plan/button"],
    reason:
      "The retired Flow lens's button label; Stack runs draws its own control (spicode-t1k.189)",
  },
  "item-moves": {
    patterns: [
      "/briefing/focus/#/actor",
      "/briefing/rest/#/actor",
      "/briefing/focus/#/subject",
      "/briefing/rest/#/subject",
      "/briefing/focus/#/evidence/#/kind",
      "/briefing/rest/#/evidence/#/kind",
    ],
    reason:
      "spicode-djg.1: who moves next, the subject and link kinds are core's; Today groups by them in spicode-djg.6 and draws link kinds in spicode-djg.7",
  },
  "evidence-label": {
    patterns: ["/briefing/focus/#/evidence/#/label", "/briefing/rest/#/evidence/#/label"],
    reason: "spicode-t1k.218: item evidence links render on no surface",
  },
  "since-undrawn": {
    patterns: [
      "/briefing/since/basis",
      "/briefing/since/from",
      "/briefing/since/asOf",
      "/briefing/since/rows/#/workflow",
      "/briefing/since/rows/#/label",
      "/briefing/since/rows/#/countText",
      "/briefing/since/rows/#/slots/#/service",
      "/briefing/since/rows/#/slots/#/state",
      "/briefing/since/rows/#/slots/#/text",
      "/briefing/since/rows/#/slots/#/origin",
    ],
    reason:
      "spicode-f0s.47: briefing.since stays in the contract and no surface draws it (PS-03; spicode-eib ruling R2)",
  },
  "today-row-item": {
    patterns: ["/briefing/focus/#/verb", "/briefing/focus/#/age"],
    reason:
      "spicode-djg.9: an Interrupt on Today is its line's row, with no verb (X1) and its object's age (S)",
    when: (_value, { pointer, snapshot }) => {
      const item = snapshot.briefing.focus[Number(pointer.split("/")[3])];
      return (
        item?.attention === "interrupt" &&
        !!snapshot.briefing.lines?.some(({ members }) => members.some(({ id }) => id === item.id))
      );
    },
  },
  "today-decisions": {
    patterns: [
      "/briefing/decisions/items",
      "/briefing/decisions/text",
      "/briefing/decisions/groups/#/id",
      "/briefing/decisions/groups/#/theme",
      "/briefing/decisions/groups/#/itemIds/#",
      "/briefing/decisions/groups/#/verb",
      "/briefing/decisions/groups/#/text",
      "/briefing/decisions/groups/#/scope/#/service",
      "/briefing/decisions/groups/#/scope/#/pr/number",
      "/briefing/decisions/groups/#/scope/#/pr/url",
      "/briefing/decisions/groups/#/scope/#/pr/inspect",
    ],
    reason:
      "spicode-djg.9: Blocked and Waiting on you replace Decisions waiting; core's lines group the same items (X1, X2)",
  },
  verdict: {
    patterns: ["/briefing/verdict/text", "/briefing/verdict/mark"],
    reason: "spicode-djg.10: Today's lede is the date only (X3); it draws no verdict",
  },
  "briefing-voice": {
    patterns: ["/briefing/headline", "/briefing/summary", "/briefing/doctor/state"],
    reason: "spicode-t1k.219: the briefing headline, summary and doctor have no home yet",
  },
  "route-key": {
    patterns: ["/releases/lines/#/month"],
    reason: "The key the window routes a release month's place by (#release/<month>)",
  },
};

/** Rows that share one home, one click and one target, so each opener is clicked once. */
export function openerCases(rows: readonly Reach[]) {
  const groups = new Map<string, Map<Selector | undefined, Reach[]>>();
  for (const row of rows) {
    const { click, ...target } = row.opens ?? { click: undefined };
    const key = JSON.stringify([row.home.name, target]);
    const clicks = groups.get(key) ?? new Map<Selector | undefined, Reach[]>();
    groups.set(key, clicks.set(click, [...(clicks.get(click) ?? []), row]));
  }
  return [...groups.values()]
    .flatMap((clicks) => [...clicks.values()])
    .map((rows) => ({ name: `${rows[0]?.pointer} via ${String(rows[0]?.opens?.click)}`, rows }));
}

/** Every primitive leaf under /briefing and /releases, with its index-free pattern. */
export function leaves(snapshot: Pick<ViewSnapshot, "briefing" | "releases">) {
  const out: { pointer: string; pattern: string; value: unknown }[] = [];
  const walk = (value: unknown, pointer: string) => {
    if (Array.isArray(value))
      for (const [index, entry] of value.entries()) walk(entry, `${pointer}/${index}`);
    else if (value !== null && typeof value === "object")
      for (const [key, entry] of Object.entries(value)) walk(entry, `${pointer}/${key}`);
    else out.push({ pointer, pattern: pointer.replace(/\/\d+(?=\/|$)/g, "/#"), value });
  };
  walk(snapshot.briefing, "/briefing");
  walk(snapshot.releases, "/releases");
  return out;
}

/**
 * Leaves with no case or exemption, cases that point at no leaf, exemption patterns no leaf uses,
 * exemptions on a leaf a case draws, and leaves only partly drawn: each with the tail no surface
 * shows and the bead that owns it.
 */
export function coverage(
  snapshot: Leaves,
  cases: readonly Reach[],
  exemptions: Readonly<Record<string, Exemption>> = EXEMPTIONS,
) {
  const all = leaves(snapshot);
  const pointers = new Set(cases.map(({ pointer }) => pointer));
  const used = new Set<string>();
  const drawn: string[] = [];
  const uncovered = all
    .filter(({ pointer, pattern, value }) => {
      const name = Object.entries(exemptions).find(
        ([, exemption]) =>
          exemption.patterns.includes(pattern) &&
          (exemption.when?.(value, { pointer, snapshot }) ?? true),
      )?.[0];
      if (pointers.has(pointer)) {
        if (name) drawn.push(`${name} ${pointer}`);
        return false;
      }
      if (name) used.add(`${name} ${pattern}`);
      return !name;
    })
    .map(({ pointer }) => pointer);
  const values = new Map(all.map(({ pointer, value }) => [pointer, String(value)]));
  const partial = [...pointers].flatMap((pointer) => {
    const rows = cases.filter((row) => row.pointer === pointer);
    if (!rows.every(({ partial }) => partial)) return [];
    const parts = new Set(
      rows.map(({ value, partial }) => `${value}|${partial?.tail}|${partial?.reason}`),
    );
    const [row] = rows;
    if (!row?.partial || parts.size > 1) return [{ pointer, misfit: [...parts] }];
    const full = values.get(pointer) ?? "";
    const fits =
      row.partial.tail !== "" &&
      full.startsWith(row.value) &&
      full.endsWith(row.partial.tail) &&
      row.value.length + row.partial.tail.length < full.length;
    return [
      fits
        ? { pointer, tail: row.partial.tail, reason: row.partial.reason }
        : { pointer, misfit: [...parts] },
    ];
  });
  return {
    uncovered,
    stray: [...pointers].filter((pointer) => !values.has(pointer)),
    drawn,
    stale: Object.entries(exemptions).flatMap(([name, { patterns, pending }]) =>
      pending
        ? []
        : patterns.map((pattern) => `${name} ${pattern}`).filter((entry) => !used.has(entry)),
    ),
    partial,
  };
}

/** Routes the window draws no Briefing or Releases field on, each with its reason. */
export const ROUTE_EXEMPTIONS: Readonly<Record<string, string>> = {
  security:
    "Security draws its own reading; on the 6 Nov sweep it holds no Briefing item, and its tiles are not Briefing fields",
  evidence:
    "Evidence draws reads, areas and not-read lists about Briefing items, never a Briefing field as the home of one",
  service:
    "spicode-mw0.6: a service page draws its fork's home (services[].home), never a Briefing field",
};

/** Every registry route, and the strip, less those a case or a named exemption covers. */
export function uncoveredRoutes(
  registry: Registry,
  cases: readonly Reach[],
  exemptions: Readonly<Record<string, string>> = ROUTE_EXEMPTIONS,
) {
  const surfaces = new Set(
    cases.filter(({ exempt }) => !exempt).map(({ home }) => home.start.surface),
  );
  return [...Object.keys(registry.views), ...(registry.strip ? ["strip"] : [])].filter(
    (route) => !surfaces.has(route) && !(route in exemptions),
  );
}
