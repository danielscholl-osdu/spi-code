// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type InspectResult, InspectResultSchema, type ViewSnapshot } from "@spi-code/contracts";
import { inScope } from "../components/sidebar/attention.js";
import { selectionRows } from "../panels/selection-rows.js";
import { plainTitle } from "../text.js";
import { clockTime } from "../time.js";
import { runningFactHome } from "../views/environment/running-fact.js";
import { eventText, eventWhen, eventWord } from "../views/environment/timeline.js";
import { selectTodayItems } from "../views/today/selectors.js";
import { lensFields } from "./lens-fields.test-helper.js";
import type { Destination, Registry } from "./navigation.js";
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
};

/** Exact index-free leaf patterns, so a new leaf elsewhere never inherits the exemption. */
export type Exemption = {
  patterns: readonly string[];
  reason: string;
  when?: (value: unknown) => boolean;
};

type Lane = ViewSnapshot["briefing"]["environment"]["lanes"][number];
type Event = Lane["events"][number];
type Repo = ViewSnapshot["briefing"]["repositories"]["rows"][number];

const at = (pointer: string) => `[data-pointer="${pointer}"]`;
const quote = (value: string) => JSON.stringify(value);
const firstClause = (value: string) => value.split(" · ")[0] ?? value;
const lastWord = (value: string) => value.trim().split(/\s+/).pop() ?? "";
const nextSync = (value: string) => value.replace(/^Next sync /, "");
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
/** Fact sublines whose tail no surface draws. */
export const FACT_TAIL_GAP = "spicode-t1k.222: the fact's tail renders on no surface";

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
  const services = treeServices(snapshot.tree);
  const rows = selectionRows(snapshot);

  for (const row of lensFields(snapshot)) {
    const { lens: _, home: name, ...field } = row;
    cases.push({ ...field, home: lensHome(name) });
  }

  const today = 'section.place[aria-label="Today"]';
  const facts = briefing.facts;
  const firstClausePart = (sub: string): Partial<Reach> => {
    const shown = firstClause(sub);
    return shown === sub
      ? {}
      : { partial: { tail: sub.slice(shown.length + " · ".length), reason: FACT_TAIL_GAP } };
  };
  facts.slice(0, 3).forEach((fact, index) => {
    const pointer = `/briefing/facts/${index}`;
    const tile = `${today} .place-tile:nth-child(${index + 1})`;
    const revision = index === 2 ? /^Template · main (\S+)$/.exec(fact.label)?.[1] : undefined;
    add(`${pointer}/figure`, fact.figure, TODAY, `${tile} .place-tile-value`);
    if (revision) {
      add(`${pointer}/label`, `forks on ${revision}`, TODAY, `${tile} .place-tile-counts`, {
        canon: lastWord,
      });
    } else {
      add(`${pointer}/label`, fact.label, TODAY, `${tile} dt`);
      add(
        `${pointer}/sub`,
        firstClause(fact.sub),
        TODAY,
        `${tile} .place-tile-counts`,
        firstClausePart(fact.sub),
      );
    }
  });
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
        ...firstClausePart(envFact.sub),
      },
    );
  }
  if (briefing.nextSyncAt) {
    const time = clockTime(briefing.nextSyncAt);
    add("/briefing/nextSyncAt", time, STRIP, '.window-strip [data-field="next-sync"] b');
    add("/briefing/nextSyncAt", time, STRIP, '.window-strip [data-field="due"]', {
      read: (element) => (element.textContent ?? "").split(" due before ")[1] ?? "",
    });
  }
  add("/briefing/sweptAt", briefing.sweptAt, TODAY, "[data-sweep-line] time", {
    attribute: "dateTime",
  });

  const { focus: todayFocus, folded } = selectTodayItems(briefing);
  const focusIds = new Set(todayFocus.map(({ id }) => id));
  const foldedIds = new Set(folded.map(({ id }) => id));
  const more = home("Today · More", STARTS.today, "details.today-folded > summary");
  const summary = "details.today-folded > summary";
  if (folded.length > 0)
    add("/briefing/more", `${briefing.more} more`, TODAY, summary, {
      contains: true,
    });
  briefing.ready.forEach((entry, index) => {
    add(`/briefing/ready/${index}/text`, entry.text, TODAY, summary, { contains: true });
    add(`/briefing/ready/${index}/count`, entry.count, TODAY, summary, { contains: true });
  });

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
    if (focusIds.has(item.id)) {
      const li = `${today} li.place-item[data-item-id=${id}]`;
      add(`${pointer}/title`, nextSync(title), TODAY, `${li} .place-item-title`, {
        canon: nextSync,
      });
      add(`${pointer}/rung`, `P${item.rung}`, TODAY, `${li} .place-rank`);
      add(`${pointer}/scope`, item.scope, TODAY, `${li} .place-scope`, {
        ...(item.id === "rollout"
          ? { exempt: "spicode-t1k.225: Today names the rollout's scope osdu-spi, not its own" }
          : {}),
      });
    }
    if (foldedIds.has(item.id)) {
      const button = (root: ParentNode) =>
        root.querySelector(`details.today-folded button[data-selection-id=${id}]`);
      const part = (selector: string) => (root: ParentNode) =>
        button(root)?.closest("li")?.querySelector(selector);
      add(`${pointer}/title`, title, more, button, { canon: nextSync });
      add(`${pointer}/rung`, `P${item.rung}`, more, part(".place-rank"));
      add(`${pointer}/scope`, item.scope, more, part(".place-scope"));
      if (item.sub) add(`${pointer}/sub`, plainTitle(item.sub), more, part(":scope > p"));
    }
    for (const reading of readings.filter(({ ids }) => ids.has(item.id))) {
      const where = home(reading.from.name, reading.from);
      const li = `section.place[aria-label=${quote(reading.name)}] li.place-item[data-item-id=${id}]`;
      add(`${pointer}/title`, title, where, `${li} .place-item-title`, { canon: nextSync });
      add(`${pointer}/rung`, `P${item.rung}`, where, `${li} .place-rank`);
      add(`${pointer}/scope`, item.scope, where, `${li} .place-scope`);
      if (item.sub) add(`${pointer}/sub`, plainTitle(item.sub), where, `${li} .place-item-sub`);
      if (item.next) add(`${pointer}/next`, plainTitle(item.next), where, `${li} .place-item-next`);
      if (item.due) {
        add(`${pointer}/due/at`, item.due.at, where, `${li} time`, { attribute: "dateTime" });
        add(`${pointer}/due/before`, `Before ${item.due.before}`, where, `${li} time`);
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
      if (item.sub) add(`${pointer}/sub`, plainTitle(item.sub), where, `${row} .service-row-sub`);
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
        add(`${pointer}/more/${index}/text`, entry.text, engineeringDetails, `${div} > dd`);
      });
    }

    const reading = readings.find(
      ({ kind, ids }) => SELECTABLE_PLACES.has(kind) && ids.has(item.id),
    );
    const theme = briefing.themes.findIndex(({ inspect }) => inspect === item.id);
    const opener = focusIds.has(item.id)
      ? { from: STARTS.today, step: `${today} [data-selection-id=${id}]` }
      : reading
        ? {
            from: reading.from,
            step: `section.place[aria-label=${quote(reading.name)}] [data-selection-id=${id}]`,
          }
        : theme >= 0
          ? { from: STARTS.upstream, step: themeHead(theme) }
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
        add(`${pointer}/${key}`, plainTitle(item[key]), detail, detailField(key), {
          ...(grouped && key !== "next"
            ? { exempt: "spicode-t1k.216: a grouped port's Detail tells its first fork only" }
            : {}),
        });
  }

  const upstream = home("Upstream", STARTS.upstream);
  briefing.themes.forEach((theme, index) => {
    const pointer = `/briefing/themes/${index}`;
    if (theme.inspect) {
      const gap = "spicode-t1k.217: a theme with an inspect id opens its item, not the theme";
      const forkButton = (fork: string) => (root: ParentNode) =>
        [...root.querySelectorAll(`li.upstream-theme${at(pointer)} button.upstream-fork`)].find(
          (button) => button.textContent === fork,
        );
      add(`${pointer}/next`, theme.next, upstream, "", { exempt: gap });
      for (const list of ["certain", "possible"] as const)
        theme[list].forEach((fork, slot) => {
          add(`${pointer}/${list}/${slot}/fork`, fork.fork, upstream, forkButton(fork.fork));
          add(`${pointer}/${list}/${slot}/state`, fork.state, upstream, "", { exempt: gap });
        });
      theme.exposed.forEach((fork, slot) => {
        add(`${pointer}/exposed/${slot}`, fork, upstream, "", { exempt: gap });
      });
      return;
    }
    const where = home(
      `Upstream · Detail theme:${theme.id}`,
      STARTS.upstream,
      themeHead(index),
      answer(`theme:${theme.id}`),
    );
    add(`${pointer}/title`, theme.title, where, detailField("cause"));
    if (theme.sub) add(`${pointer}/sub`, theme.sub, where, detailField("effect"));
    if (theme.next) add(`${pointer}/next`, plainTitle(theme.next), where, detailField("next"));
    if (theme.when) add(`${pointer}/when`, theme.when, where, detailField("why"));
    let offset = 0;
    for (const list of ["certain", "possible"] as const) {
      theme[list].forEach((fork, at) => {
        add(`${pointer}/${list}/${at}/fork`, fork.fork, where, related(offset + at, "dd"));
        add(
          `${pointer}/${list}/${at}/state`,
          `${list} · ${fork.state}`,
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
    environment.headline,
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
      fact.sub,
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
    const station = snapshot.stations
      .find(({ service }) => service === flow.fork)
      ?.stations.find(({ id }) => id === "upstream");
    if (!station || !/^\S+ behind/.test(station.text)) continue;
    add(
      `/briefing/flow/rows/${index}/behind`,
      flow.behind,
      LINE,
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

/** Leaves the window draws nowhere by design, each with the reason or the bead that owns it. */
export const EXEMPTIONS: Readonly<Record<string, Exemption>> = {
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
  "releases-reading": {
    patterns: ["/releases/reading"],
    reason: "Read state: ReleaseMonth words it as its status line, not as a field",
  },
  verb: {
    patterns: ["/briefing/focus/#/verb", "/briefing/rest/#/verb"],
    reason: "Verbs are not drawn until actions ship (PS-04, CO-05; spicode-t1k.56)",
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
 * and leaves only partly drawn: each with the tail no surface shows and the bead that owns it.
 */
export function coverage(
  snapshot: Pick<ViewSnapshot, "briefing" | "releases">,
  cases: readonly Reach[],
  exemptions: Readonly<Record<string, Exemption>> = EXEMPTIONS,
) {
  const all = leaves(snapshot);
  const pointers = new Set(cases.map(({ pointer }) => pointer));
  const used = new Set<string>();
  const uncovered = all
    .filter(({ pointer, pattern, value }) => {
      if (pointers.has(pointer)) return false;
      const name = Object.entries(exemptions).find(
        ([, exemption]) =>
          exemption.patterns.includes(pattern) && (exemption.when?.(value) ?? true),
      )?.[0];
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
    stale: Object.entries(exemptions).flatMap(([name, { patterns }]) =>
      patterns.map((pattern) => `${name} ${pattern}`).filter((entry) => !used.has(entry)),
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
