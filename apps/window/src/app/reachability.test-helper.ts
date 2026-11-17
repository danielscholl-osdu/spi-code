// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { InspectResult, ViewSnapshot } from "@spi-code/contracts";
import { inScope } from "../components/sidebar/attention.js";
import { selectionRows } from "../panels/selection-rows.js";
import { plainTitle } from "../text.js";
import { instantsIn, timedText } from "../time.js";
import { openHold } from "../views/environment/hold.js";
import { heldLaneRead } from "../views/environment/lead.js";
import { runName } from "../views/environment/opening.js";
import { eventSpan, eventText, eventWhen, eventWord } from "../views/environment/timeline.js";
import { releaseSectionCases } from "../views/releases/reachability.test-helper.js";
import { ageInOneUnit } from "../views/today/Table.js";
import { lensFields } from "./lens-fields.test-helper.js";
import type { Destination, Registry } from "./navigation.js";
import { placeFreshCases } from "./place-reachability.test-helper.js";
import { treeServices } from "./queue.js";

export type Selector = string | ((root: ParentNode) => Element | null | undefined);

/** A signed-off place a field's home starts from: Today, the strip, the Line sheet, a place. */
export type Start = { name: string; surface: string; route: Destination };

/**
 * Where a field lives: its start, then at most one click on a visible target. A Detail home also
 * carries the host's answer, and its click is the row that names it.
 */
export type Home = {
  name: string;
  start: Start;
  step?: Selector;
  detail?: InspectResult;
  /** The wall clock pinned before the home renders, for a home that draws times against it. */
  clock?: number;
};

/** What a click on the drawn field opens: the item's Detail, a place, or the row's body in place. */
export type Opens = { click: Selector } & (
  | { detail: string }
  | { place: Destination }
  | { opened: string }
);

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

type Leaves = Pick<ViewSnapshot, "briefing" | "releases">;
type Lane = ViewSnapshot["briefing"]["environment"]["lanes"][number];
type Event = Lane["events"][number];
type Repo = ViewSnapshot["briefing"]["repositories"]["rows"][number];

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
  line: start("Line sheet", { kind: "line" }, "sheet"),
  upstream: start("Upstream", { kind: "upstream" }),
  environment: start("Environment", { kind: "environment" }),
  engineering: start("Engineering system", { kind: "engineering-system" }),
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
  service: (id = "") => STARTS.service(id),
};
const SELECTABLE_PLACES = new Set(["upstream", "environment", "engineering", "service"]);
/** A place's own heading, which differs from its start's name only for a service. */
const placeLabel = (from: Start) => (from.route.kind === "service" ? from.route.id : from.name);

function home(name: string, from: Start, step?: Selector, detail?: InspectResult): Home {
  return { name, start: from, ...(step ? { step } : {}), ...(detail ? { detail } : {}) };
}

const TODAY = home("Today", STARTS.today);
const STRIP = home("Footer sweep", STARTS.strip);
const PINS = home("Pinned", STARTS.today);
const LINE = home("Line sheet", STARTS.line);
const LINE_UNFOLDED = home("Line sheet, unfolded", STARTS.line, ".line-fold");

/** The lens-field homes t1k.189 ruled, opened the way lens-retirement.test.tsx opens them. */
function lensHome(name: string): Home {
  const [place = "", target] = name.split(" · ");
  const from = place.startsWith("Service ")
    ? STARTS.service(place.slice(8))
    : place === "Environment"
      ? STARTS.environment
      : place === "Engineering system"
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

/**
 * The router's Detail answers on the recorded sweep (fixtures/watch/inspect-1106.json) by id, which
 * packages/host/src/watch/parity.test.ts pins to the router field for field: the feed Detail
 * draws here is the host's.
 */
type DetailFeed = Readonly<Record<string, InspectResult>>;

function overlaps(hold: Event, e: Event) {
  const end = (x: Event) => (x.end === undefined ? Number.POSITIVE_INFINITY : Date.parse(x.end));
  return Date.parse(e.start) <= end(hold) && end(e) >= Date.parse(hold.start);
}

/** While a hold is open the Maintenance tile leads; the Running fact's run is the Stack runs headline. */
const MAINTENANCE_LEADS = "Maintenance leads in the Running fact's place while a hold is open";

const detailField = (field: string) => `.inspector dd[data-field="${field}"]`;
const related = (index: number, part: "dt" | "dd") =>
  `.inspector-related > div:nth-child(${index + 1}) > ${part}`;

/** Every Briefing and Releases field the window draws, each at its home surface. */
export function reachCases(snapshot: ViewSnapshot, feed: DetailFeed): Reach[] {
  const { briefing, releases } = snapshot;
  const answer = (id: string) => {
    const result = feed[id];
    if (!result)
      throw new Error(`No host Detail answer for ${id} in fixtures/watch/inspect-1106.json`);
    return result;
  };
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
  const services = treeServices(snapshot.tree);
  const rows = selectionRows(snapshot);

  for (const row of lensFields(snapshot)) {
    const { lens: _, home: name, ...field } = row;
    cases.push({ ...field, home: lensHome(name) });
  }

  const { template } = briefing.repositories;
  const engineeringDetails = lensHome("Engineering system · Details");
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
    for (const service of services) {
      if (!inScope(item, `service:${service}`, services)) continue;
      if (!rows.some((row) => row.kind === "queue" && row.id === item.id)) continue;
      const where = home(
        `Service ${service} · Attention`,
        STARTS.service(service),
        '[data-section="attention"] > summary',
      );
      const row = `[data-section="attention"] .service-row[data-selection-id=${id}]`;
      add(`${pointer}/rung`, `P${item.rung}`, where, `${row} .service-priority`);
      add(`${pointer}/title`, title, where, `${row} .service-row-title`, {
        read: ownText,
        canon: nextSync,
      });
      add(`${pointer}/cls`, item.cls, where, `${row} .service-class`);
      if (item.sub) add(`${pointer}/sub`, subText(item.sub), where, `${row} .service-row-sub`);
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
    const detail = home(
      `${opener.from.name} · Detail ${item.id}`,
      opener.from,
      opener.step,
      answer(item.id),
    );
    add(`${pointer}/cls`, item.cls, detail, '.inspector [data-field="class"]');
    const grouped = item.cls === "PORT" && item.ids.length > 1;
    for (const key of ["cause", "effect", "next"] as const)
      if (plainTitle(item[key]))
        add(`${pointer}/${key}`, timedText(plainTitle(item[key])), detail, detailField(key), {
          ...(grouped && key !== "next"
            ? { exempt: "spicode-t1k.216: a grouped port's Detail tells its first fork only" }
            : {}),
        });
  }

  briefing.themes.forEach((theme, index) => {
    const pointer = `/briefing/themes/${index}`;
    const where = home(
      `Upstream · Detail theme:${theme.id}`,
      STARTS.upstream,
      themeHead(index),
      answer(`theme:${theme.id}`),
    );
    add(`${pointer}/title`, theme.title, where, detailField("cause"));
    if (theme.sub) add(`${pointer}/sub`, theme.sub, where, detailField("effect"));
    if (theme.next) add(`${pointer}/next`, plainTitle(theme.next), where, detailField("next"));
    if (theme.when) add(`${pointer}/when`, timedText(theme.when), where, detailField("why"));
    let offset = 0;
    for (const list of ["certain", "possible"] as const) {
      theme[list].forEach((fork, at) => {
        add(`${pointer}/${list}/${at}/fork`, fork.fork, where, related(offset + at, "dd"));
        add(
          `${pointer}/${list}/${at}/state`,
          timedText(`${list} · ${fork.state}`),
          where,
          related(offset + at, "dt"),
        );
      });
      offset += theme[list].length;
    }
    theme.exposed.forEach((fork, at) => {
      add(`${pointer}/exposed/${at}`, fork, where, related(offset + at, "dd"));
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
  if (environment.note)
    add("/briefing/environment/note", environment.note, runs, at("/briefing/environment/note"));
  const environmentHome = home("Environment", STARTS.environment);
  const environmentPlace = 'section.place[aria-label="Environment"]';
  const held = heldLaneRead(snapshot) && openHold(snapshot);
  environment.facts.forEach((fact, index) => {
    const pointer = `/briefing/environment/facts/${index}`;
    const tile = `${environmentPlace} .place-tile:nth-child(${index + 1})`;
    const lead = held && index === 0 ? { exempt: MAINTENANCE_LEADS } : {};
    add(`${pointer}/label`, fact.label, environmentHome, `${tile} dt`, lead);
    add(`${pointer}/figure`, fact.figure, environmentHome, `${tile} .place-tile-value`, lead);
    add(`${pointer}/sub`, subText(fact.sub), environmentHome, `${tile} .place-tile-counts`, lead);
  });
  const now = new Date(Date.parse(environment.to));
  environment.lanes.forEach((lane, laneIndex) => {
    const pointer = `/briefing/environment/lanes/${laneIndex}`;
    const row = `.env-row[data-lane=${quote(lane.id)}]`;
    add(`${pointer}/label`, lane.label, environmentHome, `${row} .env-lane-label`);
    lane.events.forEach((e, index) => {
      const event = `${pointer}/events/${index}`;
      const bar = `button.env-event[data-event=${quote(`${lane.id}:${e.id}`)}]`;
      add(`${event}/label`, eventText(e), environmentHome, `${bar} .env-event-label`);
      add(`${event}/state`, eventWord[e.state], environmentHome, bar, {
        attribute: "aria-label",
        contains: true,
      });
      add(`${event}/start`, eventWhen(e, now), environmentHome, bar, {
        attribute: "aria-label",
        contains: true,
      });
      if (e.end)
        add(`${event}/end`, eventWhen(e, now), environmentHome, bar, {
          attribute: "aria-label",
          contains: true,
        });
      const where = {
        ...home(`Environment · popover ${lane.id}:${e.id}`, STARTS.environment, bar),
        clock: now.getTime(),
      };
      const popover = ".popover .opened-body";
      const title = runName(lane, e);
      add(`${event}/label`, title, where, `${popover} h3`, {
        canon: (value) => (value === title || value === eventText(e) ? e.label : value),
      });
      if (e.detail) add(`${event}/detail`, e.detail, where, `${popover} > p`, { contains: true });
      // The popover says when the event ran without its length, which the bar's name carries.
      const ran = (element: Element) =>
        (element.textContent ?? "").split(" \u00b7 ").slice(1).join(" \u00b7 ");
      const length = { read: ran, canon: (value: string) => value.split(" \u00b7 ")[0] ?? value };
      add(`${event}/start`, eventSpan(e, now), where, `${popover} > p`, length);
      if (e.end) add(`${event}/end`, eventSpan(e, now), where, `${popover} > p`, length);
      if (lane.id !== "holds") return;
      let offset = 0;
      environment.lanes
        .filter(({ id }) => id !== "holds")
        .forEach((other) => {
          const otherIndex = environment.lanes.indexOf(other);
          other.events.forEach((run, runIndex) => {
            if (!overlaps(e, run)) return;
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

  briefing.repositories.rows.forEach((repo, index) => {
    repositoryCases(repo, `/briefing/repositories/rows/${index}`, add);
  });

  for (const [index, flow] of briefing.flow.rows.entries()) {
    const stations = snapshot.stations.find(({ service }) => service === flow.fork)?.stations;
    const station = stations?.find(({ id }) => id === "upstream");
    if (!station || !/^\S+ behind/.test(station.text)) continue;
    const quiet = stations?.every(
      ({ substate }) => substate !== "stopped" && substate !== "waiting-on-person",
    );
    add(
      `/briefing/flow/rows/${index}/behind`,
      flow.behind,
      quiet ? LINE_UNFOLDED : LINE,
      `tr[data-service=${quote(flow.fork)}] td[data-station="upstream"] button`,
      { read: (element) => /(\S+) behind/.exec(element.textContent ?? "")?.[1] ?? "" },
    );
  }

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
  return cases;
}

function repositoryCases(
  repo: Repo,
  pointer: string,
  add: (
    pointer: string,
    value: unknown,
    where: Home,
    selector: Selector,
    extra?: Partial<Reach>,
  ) => void,
) {
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
    where = lensHome("Engineering system · Details");
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
    const single = line.members.length === 1;
    add(`${pointer}/id`, line.id, TODAY, head, { attribute: "data-line-id" });
    add(
      `${pointer}/section`,
      line.section,
      TODAY,
      (root) => root.querySelector(head)?.closest("section"),
      { attribute: "data-section" },
    );
    add(`${pointer}/subject`, line.subject, TODAY, `${head} .today-row-fork button`);
    add(`${pointer}/headline`, plainTitle(line.headline), TODAY, `${head} .today-row-what button`);
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
        click: `${row} .today-row-fork button`,
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
          add(`${item}/scope`, entry.scope, TODAY, `${row} .today-row-fork button`, { opens });
      }
      if (member.age)
        add(`${base}/age`, ageInOneUnit(member.age), TODAY, `${row} .today-row-age-text`);
      if (member.primary)
        add(`${base}/primary/url`, member.primary.url, TODAY, `${row} .today-row-open a`, {
          attribute: "href",
        });
    });
  });
  return cases;
}

const LOWER_DESTINATIONS: Readonly<Record<string, Destination>> = {
  line: { kind: "line" },
  environment: { kind: "environment" },
  engineering: { kind: "engineering-system" },
  upstream: { kind: "upstream" },
  releases: { kind: "releases" },
  security: { kind: "security" },
};

/** Can wait, Moving without you and Last 24 hours: each row's fields, and the place it opens. */
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
    add(`${pointer}/${key}`, id, TODAY, tr, { attribute: "data-row" });
    add(`${pointer}/label`, label, TODAY, button, {
      ...(destination ? { opens: { click: button, place: destination } } : {}),
    });
    add(`${pointer}/place`, to, TODAY, tr, { attribute: "data-place" });
  };
  type Count = NonNullable<ViewSnapshot["briefing"]["today"]>["canWait"][number]["counts"][number];
  const counts = (pointer: string, tr: string, list: readonly Count[]) =>
    list.forEach((count, at) => {
      if (count.count === 0) return;
      const span = `${tr} .today-count[data-kind=${quote(count.kind)}]`;
      const leaf = `${pointer}/counts/${at}`;
      add(`${leaf}/count`, count.count, TODAY, span, {
        read: (element) => (element.textContent ?? "").split(" ")[0] ?? "",
      });
      add(`${leaf}/label`, count.label, TODAY, span, {
        read: (element) => (element.textContent ?? "").split(" ").slice(1).join(" "),
      });
      add(`${leaf}/kind`, count.kind, TODAY, span, { attribute: "data-kind" });
      add(`${leaf}/tone`, count.tone, TODAY, span, { attribute: "data-tone" });
      count.names.forEach((name, i) => {
        add(`${leaf}/names/${i}`, name, TODAY, span, { attribute: "title", contains: true });
      });
    });
  today.canWait.forEach((pile, index) => {
    const pointer = `${base}/canWait/${index}`;
    const tr = row("can-wait", pile.id);
    place(pointer, tr, "id", pile.id, pile.label, pile.place);
    counts(pointer, tr, pile.counts);
    pile.notRead.forEach((gap, at) => {
      add(`${pointer}/notRead/${at}`, gap, TODAY, `${tr} .today-row-gaps`, {
        attribute: "title",
        contains: true,
      });
    });
  });
  today.moving.forEach((entry, index) => {
    const pointer = `${base}/moving/${index}`;
    const tr = row("moving", entry.id);
    place(pointer, tr, "id", entry.id, entry.label, entry.place);
    if (entry.at)
      add(`${pointer}/at`, entry.at, TODAY, `${tr} .today-row-when time`, {
        attribute: "dateTime",
      });
    else add(`${pointer}/time`, entry.time, TODAY, `${tr} .today-row-when`);
    const words = `${tr} .today-row-moving`;
    add(`${pointer}/count`, entry.count, TODAY, words, { attribute: "data-count" });
    entry.names.forEach((name, at) => {
      add(`${pointer}/names/${at}`, name, TODAY, words, { attribute: "title", contains: true });
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
  add(`${base}/history/basis`, history.basis, TODAY, head, { read: basis });
  if (history.basis === "seen" || history.basis === "history-short")
    add(`${base}/history/from`, history.from, TODAY, `${head} time`, { attribute: "dateTime" });
  if (history.asOf && history.basis !== "seen" && history.basis !== "history-short")
    add(`${base}/history/asOf`, history.asOf, TODAY, `${head} time`, { attribute: "dateTime" });
  history.rows.forEach((entry, index) => {
    const pointer = `${base}/history/rows/${index}`;
    const tr = row("history", entry.workflow);
    place(pointer, tr, "workflow", entry.workflow, entry.label, entry.place);
    counts(pointer, tr, entry.counts);
  });
  return cases;
}

/** The Can wait count a count leaf belongs to. */
function countAt(pointer: string, { briefing }: Leaves) {
  const [, index, at] = pointer.match(/^\/briefing\/today\/canWait\/(\d+)\/counts\/(\d+)\//) ?? [];
  return briefing.today?.canWait[Number(index)]?.counts[Number(at)];
}

/** The focus or rest item a leaf belongs to. */
function itemAt(pointer: string, { briefing }: Leaves) {
  const [, list, index] = pointer.match(/^\/briefing\/(focus|rest)\/(\d+)\//) ?? [];
  return list === "focus" || list === "rest" ? briefing[list][Number(index)] : undefined;
}

/** Today briefing fields the contract carries before a window bead draws them; each names its bead. */
export const PENDING: Readonly<Record<string, Exemption>> = {};

/** Item leaves Today draws at the item's place rather than on Today itself, each with its reason. */
export const AT_PLACE: Readonly<Record<string, Exemption>> = {
  "row-names-forks": {
    patterns: ["/briefing/focus/#/scope", "/briefing/rest/#/scope"],
    reason:
      "spicode-djg.10: a Today row names the forks it covers (13 forks), not core's scope; the template rollout's scope shows at Engineering system",
    when: (_value, { pointer, snapshot }) => {
      const item = itemAt(pointer, snapshot);
      return (snapshot.briefing.lines ?? []).some(({ subject, members }) =>
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
  "today-join": {
    patterns: ["/briefing/repositories/rows/#/sections/#/lines/#/onToday/rel"],
    reason:
      "spicode-djg.25: a line's source or companion join to its Today member is marked alike; rel names which",
  },
  "today-zero-count": {
    patterns: ["count", "kind", "label", "tone"].map(
      (leaf) => `/briefing/today/canWait/#/counts/#/${leaf}`,
    ),
    reason:
      "spicode-djg.10: a zero count draws nothing; a pile of zeros reads none, or not read when core names a gap (X3)",
    when: (_value, { pointer, snapshot }) => countAt(pointer, snapshot)?.count === 0,
  },
  "today-count-urls": {
    patterns: ["/briefing/today/canWait/#/counts/#/urls/#"],
    reason:
      "spicode-djg.10: a Can wait row opens its place, not each object (X8); the urls are core's join keys",
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
  ...PENDING,
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
    patterns: ["/briefing/environment/from", "/briefing/environment/to"],
    reason: "The Stack runs timeline's axis frame, drawn as its hour ticks",
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
  snapshot: Pick<ViewSnapshot, "briefing" | "releases">,
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
};

/** Every registry route, the sheet and the strip, less those a case or a named exemption covers. */
export function uncoveredRoutes(
  registry: Registry,
  cases: readonly Reach[],
  exemptions: Readonly<Record<string, string>> = ROUTE_EXEMPTIONS,
) {
  const surfaces = new Set(
    cases.filter(({ exempt }) => !exempt).map(({ home }) => home.start.surface),
  );
  return [
    ...Object.keys(registry.views),
    ...(registry.sheet ? ["sheet"] : []),
    ...(registry.strip ? ["strip"] : []),
  ].filter((route) => !surfaces.has(route) && !(route in exemptions));
}
