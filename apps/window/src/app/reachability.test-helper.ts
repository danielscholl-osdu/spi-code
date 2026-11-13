// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type InspectResult, InspectResultSchema, type ViewSnapshot } from "@spi-code/contracts";
import { inScope } from "../components/sidebar/attention.js";
import { selectionRows, TODAY_GROUPS, todayGroupRow } from "../panels/selection-rows.js";
import { plainTitle } from "../text.js";
import { clockTime, timedText } from "../time.js";
import { runningFactHome } from "../views/environment/running-fact.js";
import { eventText, eventWhen, eventWord } from "../views/environment/timeline.js";
import { releaseSectionCases } from "../views/releases/reachability.test-helper.js";
import { todayReleasesCases } from "../views/today/releases.test-helper.js";
import { lensFields } from "./lens-fields.test-helper.js";
import type { Destination, Registry, Route } from "./navigation.js";
import { placeReachCases } from "./place-reachability.test-helper.js";
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
};

/** What a click on the drawn field opens: the item's Detail, or a place. */
export type Opens = { click: Selector } & ({ detail: string } | { place: Destination });

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
const firstClause = (value: string) => value.split(" · ")[0] ?? value;
const lastWord = (value: string) => value.trim().split(/\s+/).pop() ?? "";
const nextSync = (value: string) => value.replace(/^Next sync /, "");
const subText = (value: string) => timedText(plainTitle(value), { hint: false });
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
  strip: start("Strip", { kind: "today" }, "strip"),
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
const STRIP = home("Strip", STARTS.strip);
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

type DetailFeed = Readonly<Record<string, InspectResult>>;

/**
 * The router's Detail answers on the recorded sweep (fixtures/watch/inspect-1106.json), which
 * packages/host/src/watch/parity.test.ts pins to the router field for field: the feed Detail
 * draws here is the host's.
 */
export const detailFeed = (raw: string): DetailFeed =>
  Object.fromEntries(
    InspectResultSchema.array()
      .parse(JSON.parse(raw))
      .map((result) => [result.id, result]),
  );

function overlaps(hold: Event, e: Event) {
  const end = (x: Event) => (x.end === undefined ? Number.POSITIVE_INFINITY : Date.parse(x.end));
  return Date.parse(e.start) <= end(hold) && end(e) >= Date.parse(hold.start);
}

/** The hold Detail sits behind Stack runs and its bar: two clicks from Environment. */
export const HOLD_GAP = "spicode-t1k.226: a hold's Detail is two clicks from Environment";

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
  const cases: Reach[] = placeReachCases(snapshot);
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

  const facts = briefing.facts;
  const engineeringDetails = lensHome("Engineering system · Details");
  const fact2 = at("/briefing/facts/2");
  if (facts[2])
    for (const [key, selector] of [
      ["label", ".inbox-fact-label"],
      ["figure", ".inbox-fact-figure"],
      ["sub", ".inbox-fact-sub"],
    ] as const)
      add(`/briefing/facts/2/${key}`, facts[2][key], engineeringDetails, `${fact2} ${selector}`, {
        ...(key === "label" ? { canon: lastWord } : {}),
      });
  const environmentFact = facts.findIndex(({ label }) => label === "Environment");
  const envFact = facts[environmentFact];
  if (envFact && envFact.figure !== "?") {
    const pointer = `/briefing/facts/${environmentFact}`;
    add(`${pointer}/figure`, envFact.figure, STRIP, '.window-strip [data-field="environment"] b');
    add(
      `${pointer}/sub`,
      firstClause(envFact.sub),
      STRIP,
      '.window-strip [data-field="environment"]',
      {
        read: (element) => (element.textContent ?? "").replace(`env ${envFact.figure}`, "").trim(),
      },
    );
  }
  if (briefing.nextSyncAt) {
    const time = clockTime(briefing.nextSyncAt);
    add("/briefing/nextSyncAt", time, STRIP, '.window-strip [data-field="next-sync"] b');
  }
  add("/briefing/sweptAt", briefing.sweptAt, TODAY, "[data-sweep-line] time", {
    attribute: "dateTime",
  });

  const verdict = briefing.verdict;
  if (verdict) {
    add("/briefing/verdict/text", verdict.text, TODAY, ".today-verdict .today-headline");
    add("/briefing/verdict/mark", verdict.mark, TODAY, ".today-verdict", {
      attribute: "data-mark",
    });
  }
  const since = briefing.since;
  if (since) {
    add("/briefing/since/basis", since.basis, TODAY, ".today-since", { attribute: "data-basis" });
    const basis = ".today-since-basis";
    if (since.asOf) {
      add("/briefing/since/asOf", since.asOf, TODAY, `${basis} time`, { attribute: "dateTime" });
      add("/briefing/since/from", clockTime(since.from, { hint: false }), TODAY, basis, {
        attribute: "title",
        contains: true,
      });
    } else
      add("/briefing/since/from", since.from, TODAY, `${basis} time`, { attribute: "dateTime" });
    since.rows.forEach((row, index) => {
      const pointer = `/briefing/since/rows/${index}`;
      const div = `.today-since-row:nth-of-type(${index + 1})`;
      add(`${pointer}/workflow`, row.workflow, TODAY, div, { attribute: "data-workflow" });
      add(`${pointer}/label`, row.label, TODAY, `${div} .kit-slot-row-label`);
      add(`${pointer}/countText`, row.countText, TODAY, `${div} .kit-slot-row-count`);
      row.slots.forEach((slot, at) => {
        const pip = `${div} .kit-slot:nth-child(${at + 1})`;
        add(`${pointer}/slots/${at}/text`, slot.text, TODAY, pip, { attribute: "aria-label" });
        add(`${pointer}/slots/${at}/service`, slot.service, TODAY, pip, {
          attribute: "aria-label",
          contains: true,
        });
        add(`${pointer}/slots/${at}/state`, slot.state, TODAY, pip, {
          read: (element) =>
            [...element.classList]
              .find((name) => name.startsWith("kit-slot--") && name !== "kit-slot--upstream")
              ?.slice("kit-slot--".length) ?? "",
        });
        if (slot.origin)
          add(`${pointer}/slots/${at}/origin`, slot.origin, TODAY, pip, {
            read: (element) =>
              element.classList.contains("kit-slot--upstream") ? "upstream" : "system",
          });
      });
    });
  }

  cases.push(
    ...bandCases(snapshot),
    ...horizonCases(snapshot),
    ...todayReleasesCases(snapshot, TODAY),
  );

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
      if (item.due) {
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
  const environmentReading = snapshot.readings.find(({ anchor }) => anchor.kind === "environment");
  const environmentHome = home("Environment", STARTS.environment);
  const environmentPlace = 'section.place[aria-label="Environment"]';
  environment.facts.forEach((fact, index) => {
    const pointer = `/briefing/environment/facts/${index}`;
    const div = at(`${pointer}/figure`);
    const { versionTile, subInHeadline } = runningFactHome(
      fact,
      environmentReading ?? { anchor: { kind: "environment" }, content: null },
    );
    const tile = `${environmentPlace} .place-tile:nth-child(${versionTile + 1})`;
    if (versionTile >= 0) {
      add(`${pointer}/label`, "running", environmentHome, `${tile} .place-tile-counts`, {
        read: (element) => firstClause(element.textContent ?? ""),
        canon: (value) => value.toLowerCase(),
      });
      add(`${pointer}/figure`, fact.figure, environmentHome, `${tile} .place-tile-value`);
    } else {
      add(`${pointer}/label`, fact.label, runs, `${div} .env-fact-label`);
      add(`${pointer}/figure`, fact.figure, runs, `${div} strong`);
    }
    add(
      `${pointer}/sub`,
      subText(fact.sub),
      subInHeadline ? environmentHome : runs,
      subInHeadline ? `${environmentPlace} .place-headline` : `${div} > div:last-child`,
      subInHeadline
        ? {
            read: (element) =>
              (element.textContent ?? "")
                .replace(/^v\S+ is /, "")
                .replace(", green since ", " · green at ")
                .replace(/\.$/, ""),
          }
        : {},
    );
  });
  const now = new Date(Date.parse(environment.to));
  const overlapped = new Set<string>();
  environment.lanes.forEach((lane, laneIndex) => {
    const pointer = `/briefing/environment/lanes/${laneIndex}`;
    const row = `.env-row[data-lane=${quote(lane.id)}]`;
    add(`${pointer}/label`, lane.label, runs, `${row} .env-lane-label`);
    lane.events.forEach((e, index) => {
      const event = `${pointer}/events/${index}`;
      const bar = `button.env-event[data-event=${quote(`${lane.id}:${e.id}`)}]`;
      add(`${event}/label`, eventText(e), runs, `${bar} .env-event-label`);
      add(`${event}/state`, eventWord[e.state], runs, bar, {
        attribute: "aria-label",
        contains: true,
      });
      add(`${event}/start`, eventWhen(e, now), runs, bar, {
        attribute: "aria-label",
        contains: true,
      });
      if (e.end)
        add(`${event}/end`, eventWhen(e, now), runs, bar, {
          attribute: "aria-label",
          contains: true,
        });
      if (lane.id !== "holds") return;
      const where = home(
        `Environment · Detail hold:${e.id}`,
        STARTS.environment,
        bar,
        answer(e.inspect ?? `hold:${e.id}`),
      );
      const gap = { exempt: HOLD_GAP };
      add(`${event}/label`, `Held ${e.label}`, where, detailField("cause"), {
        canon: (value) => value.replace(/^Held /, ""),
        ...gap,
      });
      if (e.detail) add(`${event}/detail`, e.detail, where, detailField("effect"), gap);
      // The Detail draws its instants as `time` elements and no span; read the instants from their
      // datetime, and require the drawn text to be the same reading against the test's pinned clock.
      const when = (element: Element) => {
        const [start = "", end] = [...element.querySelectorAll("time")].map(
          (time) => time.getAttribute("datetime") ?? "",
        );
        const { end: _, ...running } = e;
        const read = eventWhen(
          end === undefined ? { ...running, start } : { ...running, start, end },
          now,
        );
        const drawn = element.textContent ?? "";
        return drawn === read.split(" \u00b7 ")[0] ? read : drawn;
      };
      add(`${event}/start`, eventWhen(e, now), where, detailField("why"), { read: when, ...gap });
      if (e.end)
        add(`${event}/end`, eventWhen(e, now), where, detailField("why"), { read: when, ...gap });
      let offset = 0;
      environment.lanes
        .filter(({ id }) => id !== "holds")
        .forEach((other) => {
          const otherIndex = environment.lanes.indexOf(other);
          other.events.forEach((run, runIndex) => {
            if (!overlaps(e, run)) return;
            const runPointer = `/briefing/environment/lanes/${otherIndex}/events/${runIndex}`;
            overlapped.add(runPointer);
            add(`${runPointer}/detail`, run.detail, where, related(offset, "dt"), gap);
            offset += 1;
          });
        });
    });
  });
  environment.lanes.forEach((lane, laneIndex) => {
    lane.events.forEach((e, index) => {
      const pointer = `/briefing/environment/lanes/${laneIndex}/events/${index}`;
      if (lane.id !== "holds" && !overlapped.has(pointer) && e.detail)
        add(`${pointer}/detail`, e.detail, runs, "", {
          exempt: "spicode-t1k.223: a run's detail renders only on a hold it overlaps",
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
    add(`${pointer}/name`, line.name, month, `${place} .place-header h1`, { read: ofName });
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
  cases.push(...motionCases(snapshot));
  return cases;
}

/** Today's In motion rows and Can wait chips, and the Can wait list each chip opens in Detail. */
export function motionCases(snapshot: ViewSnapshot): Reach[] {
  const { briefing } = snapshot;
  const cases: Reach[] = [];
  const add = (
    pointer: string,
    value: unknown,
    where: Home,
    selector: Selector,
    extra: Partial<Reach> = {},
  ) => {
    cases.push({ pointer, value: String(value), home: where, selector, ...extra });
  };
  const run = briefing.ambient?.inProgress;
  if (run && run.lines.length > 0) {
    const base = "/briefing/ambient/inProgress";
    add(`${base}/items`, run.items, TODAY, ".today-motion-run", { attribute: "data-items" });
    add(`${base}/text`, run.text, TODAY, ".today-motion-figure", {
      read: (element) => (element.textContent ?? "").replace(/^·\s*/, ""),
    });
    const items = briefingItems(briefing);
    run.lines.forEach((line, index) => {
      const pointer = `${base}/lines/${index}`;
      const li = `.today-motion-line[data-line-id=${quote(line.id)}]`;
      const attribute = (leaf: string, value: unknown, name: string) =>
        add(`${pointer}/${leaf}`, value, TODAY, li, { attribute: name });
      attribute("id", line.id, "data-line-id");
      attribute("count", line.count, "data-count");
      attribute("origin", line.origin, "data-origin");
      attribute("text", line.text, "title");
      for (const [at, id] of line.itemIds.entries())
        add(`${pointer}/itemIds/${at}`, id, TODAY, li, {
          attribute: "data-item-ids",
          contains: true,
        });
      for (const [at, service] of (line.next ?? []).entries())
        add(
          `${pointer}/next/${at}`,
          service,
          TODAY,
          `${li} .today-motion-next .kit-chip--service:nth-child(${at + 1})`,
        );
      if (line.station) attribute("station", line.station, "data-station");
      if (line.pr) {
        add(`${pointer}/pr/number`, `#${line.pr.number}`, TODAY, `${li} .kit-pr`);
        if (line.pr.url) attribute("pr/url", line.pr.url, "data-pr-url");
        if (line.pr.inspect) attribute("pr/inspect", line.pr.inspect, "data-pr-inspect");
      }
      if (line.age) add(`${pointer}/age`, line.age, TODAY, `${li} .kit-chip--age`);
      const chip = (at: number) => `${li} .today-motion-state > .kit-chip:nth-child(${at})`;
      if (line.state) {
        add(`${pointer}/state/text`, line.state.text, TODAY, chip(1));
        add(`${pointer}/state/tone`, line.state.tone, TODAY, chip(1), {
          read: (element) =>
            [...element.classList]
              .find((name) => name.startsWith("kit-chip--"))
              ?.slice("kit-chip--".length) ?? "",
        });
      }
      if (line.followUp) add(`${pointer}/followUp`, line.followUp, TODAY, chip(line.state ? 2 : 1));
      const [first = line.id] = line.itemIds;
      const detail = { click: `${li} .today-motion-open`, detail: first };
      for (const [item, entry] of items)
        if (line.itemIds.includes(entry.id) && entry.origin === line.origin)
          add(`${item}/origin`, entry.origin, TODAY, li, {
            attribute: "data-origin",
            opens: detail,
          });
      if (!line.service) return;
      const service = `${li} .today-motion-service .kit-chip--service`;
      add(`${pointer}/service`, line.service, TODAY, service);
      const place: Route = { kind: "service", id: line.service };
      for (const [item, entry] of items)
        if (line.itemIds.includes(entry.id) && entry.scope === line.service)
          add(`${item}/scope`, entry.scope, TODAY, service, { opens: { click: service, place } });
    });
  }
  const canWait = briefing.canWait;
  if (canWait && canWait.chips.length > 0) {
    const block = ".today-canwait";
    canWait.chips.forEach((chip, index) => {
      const pointer = `/briefing/canWait/chips/${index}`;
      const button = `${block} button.today-canwait-chip:nth-of-type(${index + 1})`;
      add(`${pointer}/text`, chip.text, TODAY, button, { read: ownText });
      if (chip.count !== undefined)
        add(`${pointer}/count`, chip.count, TODAY, button, { attribute: "data-count" });
      if (chip.service)
        add(`${pointer}/service`, chip.service, TODAY, button, { attribute: "data-service" });
    });
    const list = home("Today · Can wait", STARTS.today, `${block} button.today-canwait-chip`);
    canWait.items.forEach((item, index) => {
      const pointer = `/briefing/canWait/items/${index}`;
      const field = `.detail-row-fields > div:nth-child(${index + 1})`;
      add(`${pointer}/id`, item.id, TODAY, block, { attribute: "data-ids", contains: true });
      for (const [at, id] of item.itemIds.entries())
        add(`${pointer}/itemIds/${at}`, id, TODAY, block, {
          attribute: "data-ids",
          contains: true,
        });
      add(`${pointer}/why`, item.why, list, `${field} > dd`);
      if (item.service) {
        add(`${pointer}/service`, item.service, list, `${field} > dt`);
        add(`${pointer}/text`, item.text, list, field, {
          read: (element) =>
            `${element.querySelector("dt")?.textContent}: ${element.querySelector("dd")?.textContent}`,
        });
      } else add(`${pointer}/text`, item.text, list, `${field} > dt`);
    });
  }
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

const verbOf = (element: Element) => (element.textContent ?? "").replace(/ ›$/, "");
const nth = (selector: string, index: number) => (root: ParentNode) =>
  root.querySelectorAll(selector)[index];

/** Each focus and rest item, with its pointer. */
export function briefingItems(briefing: ViewSnapshot["briefing"]) {
  return [
    ...briefing.focus.map((item, index) => [`/briefing/focus/${index}`, item] as const),
    ...briefing.rest.map((item, index) => [`/briefing/rest/${index}`, item] as const),
  ];
}

/** In-system items carry no upstream chip (today-design 'Two origins, one mark'). */
const chipOrigin = (element: Element) =>
  element.querySelector(".kit-chip--upstream") ? "upstream" : "system";

/** Today's attention band: each Interrupt's card, the in-system decisions and the Failing run. */
export function bandCases(snapshot: ViewSnapshot): Reach[] {
  const { briefing } = snapshot;
  const cases: Reach[] = [];
  const add: Add = (pointer, value, where, selector, extra = {}) => {
    cases.push({ pointer, value: String(value), home: where, selector, ...extra });
  };
  const band = ".today-band";
  const items = briefingItems(briefing);
  const known = new Set(treeServices(snapshot.tree));
  const themes = new Set(briefing.themes.map(({ id }) => id));
  const place = (service: string): Route => ({ kind: "service", id: service });
  for (const [pointer, item] of items) {
    if (item.attention !== "interrupt") continue;
    const card = `${band} li.today-need[data-item-id=${quote(item.id)}]`;
    const title = `${card} .today-need-title`;
    const detail = { click: title, detail: item.id };
    add(`${pointer}/title`, item.title, TODAY, title);
    add(`${pointer}/scope`, item.scope, TODAY, `${card} .today-need-scope`, {
      opens: known.has(item.scope)
        ? { click: `${card} .today-need-scope`, place: place(item.scope) }
        : detail,
    });
    add(`${pointer}/rung`, `P${item.rung}`, TODAY, `${card} > .kit-chip`);
    add(`${pointer}/verb`, item.verb, TODAY, `${card} .today-verb`, { read: verbOf });
    if (item.origin)
      add(`${pointer}/origin`, item.origin, TODAY, card, {
        attribute: "data-origin",
        opens: detail,
      });
    if (item.age) add(`${pointer}/age`, item.age, TODAY, `${card} .kit-chip--age`);
    if (item.blocks) {
      const chip = `${card} .today-need-blocks .kit-chip`;
      add(`${pointer}/blocks/text`, item.blocks.text, TODAY, chip);
      add(`${pointer}/blocks/count`, item.blocks.count, TODAY, chip, { contains: true });
    }
  }

  const decisions = briefing.decisions;
  if (decisions && decisions.groups.length > 0) {
    const heading = `${band} .today-decisions .today-band-heading`;
    add("/briefing/decisions/text", decisions.text, TODAY, heading, { contains: true });
    add("/briefing/decisions/items", decisions.items, TODAY, heading, { contains: true });
    decisions.groups.forEach((group, index) => {
      const pointer = `/briefing/decisions/groups/${index}`;
      const row = `${band} li.today-decision[data-decision-id=${quote(group.id)}]`;
      add(`${pointer}/id`, group.id, TODAY, row, { attribute: "data-decision-id" });
      add(`${pointer}/theme`, group.theme, TODAY, row, { attribute: "data-theme" });
      add(`${pointer}/text`, plainTitle(group.text), TODAY, row, { attribute: "title" });
      if (group.kind) add(`${pointer}/kind`, group.kind, TODAY, row, { attribute: "data-kind" });
      if (group.token)
        add(`${pointer}/token`, plainTitle(group.token), TODAY, `${row} .today-decision-cause`);
      if (group.verb)
        add(`${pointer}/verb`, group.verb, TODAY, `${row} .today-verb`, { read: verbOf });
      group.itemIds.forEach((id, at) => {
        add(`${pointer}/itemIds/${at}`, id, TODAY, row, {
          attribute: "data-item-ids",
          contains: true,
        });
      });
      group.scope.forEach(({ service, pr }, at) => {
        const fork = nth(`${row} .today-decision-fork`, at);
        const base = `${pointer}/scope/${at}`;
        add(`${base}/service`, service, TODAY, fork, { attribute: "data-service" });
        if (!pr) return;
        add(
          `${base}/pr/number`,
          `#${pr.number}`,
          TODAY,
          (root) => fork(root)?.querySelector(".kit-pr"),
          {
            canon: (value) => value.replace(/^#/, ""),
          },
        );
        if (pr.url) add(`${base}/pr/url`, pr.url, TODAY, fork, { attribute: "data-pr-url" });
        if (pr.inspect)
          add(`${base}/pr/inspect`, pr.inspect, TODAY, fork, { attribute: "data-inspect" });
      });
      const [first = ""] = group.itemIds;
      const target =
        group.itemIds.length > 1 && themes.has(group.theme) ? `theme:${group.theme}` : first;
      const detail = { click: `${row} .today-decision-cause`, detail: target };
      const forks = group.scope.map(({ service }) => service);
      const [fork] = forks;
      for (const [item, entry] of items) {
        if (!group.itemIds.includes(entry.id)) continue;
        if (entry.origin)
          add(`${item}/origin`, entry.origin, TODAY, row, { read: chipOrigin, opens: detail });
        if (!fork || entry.scope !== forks.join(", ")) continue;
        add(`${item}/scope`, entry.scope, TODAY, row, {
          read: (element) =>
            [...element.querySelectorAll(".today-decision-fork")]
              .map((span) => span.getAttribute("data-service"))
              .join(", "),
          opens: known.has(fork)
            ? { click: `${row} .today-decision-fork .kit-chip--service`, place: place(fork) }
            : detail,
        });
      }
    });
  }

  const failing = briefing.ambient?.failing;
  if (failing && failing.lines.length > 0) {
    const heading = `${band} .today-failing .today-band-heading`;
    add("/briefing/ambient/failing/text", failing.text, TODAY, heading, { contains: true });
    add("/briefing/ambient/failing/items", failing.items, TODAY, heading, { contains: true });
    failing.lines.forEach((line, index) => {
      const pointer = `/briefing/ambient/failing/lines/${index}`;
      const row = `${band} li.today-item-row[data-line-id=${quote(line.id)}]`;
      add(`${pointer}/id`, line.id, TODAY, row, { attribute: "data-line-id" });
      add(`${pointer}/count`, line.count, TODAY, row, { attribute: "data-count" });
      add(`${pointer}/origin`, line.origin, TODAY, row, { attribute: "data-origin" });
      add(`${pointer}/text`, line.text, TODAY, row, { attribute: "title" });
      line.itemIds.forEach((id, at) => {
        add(`${pointer}/itemIds/${at}`, id, TODAY, row, {
          attribute: "data-item-ids",
          contains: true,
        });
      });
      if (line.service)
        add(`${pointer}/service`, line.service, TODAY, `${row} .today-item-service`);
      if (line.station)
        add(`${pointer}/station`, line.station, TODAY, `${row} .today-item-glyph`, {
          attribute: "data-station",
        });
      if (line.pr) {
        const pr = `${row} .today-item-pr`;
        add(`${pointer}/pr/number`, `#${line.pr.number}`, TODAY, `${pr} .kit-pr`, {
          canon: (value) => value.replace(/^#/, ""),
        });
        if (line.pr.url)
          add(`${pointer}/pr/url`, line.pr.url, TODAY, pr, { attribute: "data-pr-url" });
        if (line.pr.inspect)
          add(`${pointer}/pr/inspect`, line.pr.inspect, TODAY, pr, { attribute: "data-inspect" });
      }
      if (line.state) {
        const state = `${row} .today-item-state`;
        add(`${pointer}/state/text`, line.state.text, TODAY, `${state} > .kit-chip`);
        add(`${pointer}/state/tone`, line.state.tone, TODAY, state, { attribute: "data-tone" });
      }
      if (line.followUp)
        add(`${pointer}/followUp`, line.followUp, TODAY, `${row} .kit-chip--plain`);
      if (line.age) add(`${pointer}/age`, line.age, TODAY, `${row} .kit-chip--age`);
      const [first = ""] = line.itemIds;
      const detail = { click: `${row} .today-item-open`, detail: first };
      for (const [item, entry] of items) {
        if (!line.itemIds.includes(entry.id)) continue;
        if (entry.origin === line.origin)
          add(`${item}/origin`, entry.origin, TODAY, row, {
            attribute: "data-origin",
            opens: detail,
          });
        if (line.service && entry.scope === line.service)
          add(`${item}/scope`, entry.scope, TODAY, `${row} .today-item-service`, {
            opens: known.has(line.service)
              ? { click: `${row} button.today-item-service`, place: place(line.service) }
              : detail,
          });
      }
    });
  }
  return cases;
}

/** The 740-only group opener reaches every core line in that group's full Detail list. */
export function moreCases(snapshot: ViewSnapshot): Reach[] {
  return TODAY_GROUPS.flatMap((group) => {
    const row = todayGroupRow(snapshot, group);
    const entries = row.entries ?? [];
    if (entries.length <= 3) return [];
    const prefix = row.prefixes?.[0];
    const list =
      group === "horizon" ? prefix : `${prefix}/${group === "decisions" ? "groups" : "lines"}`;
    return entries.map((entry, index) => ({
      pointer: `${list}/${index}/text`,
      value: plainTitle(entry.title),
      home: home(`${row.title} full list`, STARTS.today, `.today-more[data-group="${group}"]`),
      selector: `.detail-group-list > li:nth-child(${index + 1})`,
    }));
  });
}

/** Upstream items on a horizon card or the owed row: the section's inbound mark is their origin. */
const inbound = (element: Element) =>
  element.closest(".today-horizon")?.querySelector(".horizon-inbound") ? "upstream" : "system";

/** Each item a horizon card or the owed row holds: its fork chip opens the place, its card the Detail. */
export function horizonCases(snapshot: ViewSnapshot): Reach[] {
  const { briefing } = snapshot;
  const cases: Reach[] = [];
  const add: Add = (pointer, value, where, selector, extra = {}) => {
    cases.push({ pointer, value: String(value), home: where, selector, ...extra });
  };
  const items = briefingItems(briefing);
  const themes = new Set(briefing.themes.map(({ id }) => id));
  const { cards = [], owed } = briefing.horizon;
  cards.forEach((card, index) => {
    const root = `.today-horizon .horizon-card[data-card-id=${quote(card.id)}]`;
    const [first = ""] = card.itemIds;
    const target = card.kind !== "sync" && themes.has(card.id) ? `theme:${card.id}` : first;
    const detail = { click: `${root} button.horizon-token`, detail: target };
    for (const [item, entry] of items) {
      if (!card.itemIds.includes(entry.id)) continue;
      if (entry.origin)
        add(`${item}/origin`, entry.origin, TODAY, root, { read: inbound, opens: detail });
      const at = card.services.findIndex(({ service }) => service === entry.scope);
      if (at < 0) continue;
      const chip = `${root} .horizon-fork[data-pointer="/briefing/horizon/cards/${index}/services/${at}"] .kit-chip--service`;
      add(`${item}/scope`, entry.scope, TODAY, chip, {
        opens: { click: chip, place: { kind: "service", id: entry.scope } },
      });
    }
  });
  if (owed && owed.count > 0)
    (owed.itemIds ?? []).forEach((id, at) => {
      const open = nth(".today-horizon .horizon-owed .horizon-owed-open", at);
      const opens = { click: open, detail: id };
      for (const [item, entry] of items) {
        if (entry.id !== id) continue;
        if (entry.origin)
          add(
            `${item}/origin`,
            entry.origin,
            TODAY,
            ".today-horizon .horizon-owed .kit-segmented",
            {
              read: (element) =>
                element.classList.contains("kit-segmented--upstream") ? "upstream" : "system",
              opens,
            },
          );
        add(`${item}/scope`, entry.scope, TODAY, ".today-horizon .horizon-owed .kit-bar-figure", {
          contains: true,
          opens,
        });
      }
    });
  return cases;
}

/** The focus or rest item a leaf belongs to. */
function itemAt(pointer: string, { briefing }: Leaves) {
  const [, list, index] = pointer.match(/^\/briefing\/(focus|rest)\/(\d+)\//) ?? [];
  return list === "focus" || list === "rest" ? briefing[list][Number(index)] : undefined;
}

/** A fact another surface draws: the third on Engineering system, Environment's on the strip. */
function factElsewhere(pointer: string, { briefing }: Leaves) {
  const [, index, key] = pointer.match(/^\/briefing\/facts\/(\d+)\/(\w+)$/) ?? [];
  const fact = briefing.facts[Number(index)];
  if (!fact) return false;
  if (index === "2") return true;
  return fact.label === "Environment" && fact.figure !== "?" && key !== "label";
}

/** Today briefing fields the contract carries before a window bead draws them; each names its bead. */
export const PENDING: Readonly<Record<string, Exemption>> = {};

/** Item leaves Today draws at the item's place rather than on Today itself, each with its reason. */
export const AT_PLACE: Readonly<Record<string, Exemption>> = {
  "forkless-decision": {
    patterns: ["/briefing/focus/#/scope", "/briefing/rest/#/scope"],
    reason:
      "A decision core gives no forks (the template rollout, the stack's lanes) draws no scope chip (today-design 'Decisions waiting'); its scope shows at its place",
    when: (_value, { pointer, snapshot }) => {
      const item = itemAt(pointer, snapshot);
      return (snapshot.briefing.decisions?.groups ?? []).some(
        ({ itemIds, scope }) =>
          item !== undefined && itemIds.includes(item.id) && scope.length === 0,
      );
    },
  },
  "fleet-wide-line": {
    patterns: ["/briefing/focus/#/scope", "/briefing/rest/#/scope"],
    reason:
      "An Ambient line core gives no service (the template rollout) draws its next merges, not its scope (today-design 'Words and visuals', ruling 69); its scope shows at its place",
    when: (_value, { pointer, snapshot }) => {
      const item = itemAt(pointer, snapshot);
      const { failing, inProgress } = snapshot.briefing.ambient ?? {};
      return [...(failing?.lines ?? []), ...(inProgress?.lines ?? [])].some(
        ({ itemIds, service }) => item !== undefined && itemIds.includes(item.id) && !service,
      );
    },
  },
};

/** Leaves the window draws nowhere by design, each with the reason or the bead that owns it. */
export const EXEMPTIONS: Readonly<Record<string, Exemption>> = {
  ...PENDING,
  transport: {
    patterns: [
      "/briefing/focus/#/id",
      "/briefing/focus/#/ids/#",
      "/briefing/focus/#/evidence/#/url",
      "/briefing/rest/#/id",
      "/briefing/rest/#/ids/#",
      "/briefing/rest/#/evidence/#/url",
      "/briefing/ready/#/id",
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
      "/releases/lines/#/id",
    ],
    reason: "Transport: ids, inspect ids and links the window keys rows and opens Detail with",
  },
  styling: {
    patterns: [
      "/briefing/facts/#/tone",
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
  "retired-today": {
    patterns: [
      "/briefing/facts/#/label",
      "/briefing/facts/#/figure",
      "/briefing/facts/#/sub",
      "/briefing/more",
      "/briefing/ready/#/text",
      "/briefing/ready/#/count",
    ],
    reason:
      "Today's tiles and its n-more fold are gone (today-design 'What goes'); the place cards and the Releases block draw from briefing.places and releases.today",
    when: (_value, { pointer, snapshot }) => !factElsewhere(pointer, snapshot),
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
  "evidence-label": {
    patterns: ["/briefing/focus/#/evidence/#/label", "/briefing/rest/#/evidence/#/label"],
    reason: "spicode-t1k.218: item evidence links render on no surface",
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
