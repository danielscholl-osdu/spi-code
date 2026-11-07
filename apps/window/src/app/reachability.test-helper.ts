// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { InspectResult, ViewSnapshot } from "@spi-code/contracts";
import { clock } from "../components/evidence/words.js";
import { inScope } from "../components/sidebar/attention.js";
import { selectionRows } from "../panels/selection-rows.js";
import { plainTitle } from "../text.js";
import { eventText, eventWhen, eventWord } from "../views/environment/timeline.js";
import { selectTodayItems } from "../views/today/selectors.js";
import { lensFields } from "./lens-fields.test-helper.js";
import type { Destination, Registry } from "./navigation.js";
import { treeServices } from "./queue.js";

export type Selector = string | ((root: ParentNode) => Element | null | undefined);

/**
 * Where a field lives: a route, then at most one click. A Detail home also carries the host's
 * answer, and its click is the row that names it, which is itself reachable from its place.
 */
export type Home = {
  name: string;
  surface: string;
  route: Destination;
  steps: Selector[];
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
};

export type Exemption = { pattern: RegExp; reason: string; when?: (value: unknown) => boolean };

type Item = ViewSnapshot["briefing"]["focus"][number];
type Theme = ViewSnapshot["briefing"]["themes"][number];
type Lane = ViewSnapshot["briefing"]["environment"]["lanes"][number];
type Event = Lane["events"][number];
type Repo = ViewSnapshot["briefing"]["repositories"]["rows"][number];

const at = (pointer: string) => `[data-pointer="${pointer}"]`;
const quote = (value: string) => JSON.stringify(value);
const firstClause = (value: string) => value.split(" · ")[0] ?? value;
const lastWord = (value: string) => value.trim().split(/\s+/).pop() ?? "";
const nextSync = (value: string) => value.replace(/^Next sync /, "");
const ownText = (element: Element) =>
  [...element.childNodes]
    .filter((node) => node.nodeType === 3)
    .map((node) => node.textContent ?? "")
    .join("")
    .trim();

const PLACE_ROUTES: Record<string, (id?: string) => { name: string; route: Destination }> = {
  upstream: () => ({ name: "Upstream", route: { kind: "upstream" } }),
  environment: () => ({ name: "Environment", route: { kind: "environment" } }),
  engineering: () => ({ name: "Engineering system", route: { kind: "engineering-system" } }),
  releases: () => ({ name: "Releases", route: { kind: "releases" } }),
  security: () => ({ name: "Security", route: { kind: "security" } }),
  service: (id = "") => ({ name: id, route: { kind: "service", id } }),
};
const SELECTABLE_PLACES = new Set(["upstream", "environment", "engineering", "service"]);

function home(name: string, route: Destination, steps: Selector[] = [], detail?: InspectResult) {
  const surface = route.kind === "line" ? "sheet" : route.kind;
  return { name, surface, route, steps, ...(detail ? { detail } : {}) };
}

const TODAY = home("Today", { kind: "today" });
const STRIP: Home = { ...home("Strip", { kind: "today" }), surface: "strip" };
const LINE = home("Line sheet", { kind: "line" });

/** The lens-field homes t1k.189 ruled, opened the way lens-retirement.test.tsx opens them. */
function lensHome(name: string): Home {
  const [place = "", target] = name.split(" · ");
  const route: Destination = place.startsWith("Service ")
    ? { kind: "service", id: place.slice(8) }
    : place === "Environment"
      ? { kind: "environment" }
      : place === "Engineering system"
        ? { kind: "engineering-system" }
        : place === "Today"
          ? { kind: "today" }
          : { kind: "upstream" };
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
  return home(name, route, step ? [step] : []);
}

const THEME_CLASS: Record<Theme["kind"], InspectResult["class"]> = {
  halt: "HALT",
  toolchain: "TOOLCHAIN",
  port: "PORT",
  rollout: "ROLLOUT",
  deadline: "GATE",
};

const answer = (
  id: string,
  fields: Pick<InspectResult, "class" | "cause" | "effect" | "next" | "why" | "related">,
): InspectResult => ({ id, ...fields, evidence: [], actions: [], approval: null });

/** A queue item's Detail as the host answers it; packages/host/src/watch/parity.test.ts holds the host to it. */
const itemAnswer = (item: Item) =>
  answer(item.id, {
    class: item.cls,
    cause: item.cause,
    effect: item.effect,
    next: item.next,
    why: "",
    related: [],
  });

const themeAnswer = (theme: Theme) =>
  answer(`theme:${theme.id}`, {
    class: THEME_CLASS[theme.kind],
    cause: theme.title,
    effect: theme.sub,
    next: theme.next,
    why: theme.when ?? "",
    related: [
      ...theme.certain.map((f) => ({ text: f.fork, state: `certain · ${f.state}` })),
      ...theme.possible.map((f) => ({ text: f.fork, state: `possible · ${f.state}` })),
      ...theme.exposed.map((name) => ({ text: name, state: "exposed" })),
    ],
  });

function overlaps(hold: Event, e: Event) {
  const end = (x: Event) => (x.end === undefined ? Number.POSITIVE_INFINITY : Date.parse(x.end));
  return Date.parse(e.start) <= end(hold) && end(e) >= Date.parse(hold.start);
}

function holdAnswer(hold: Event, lanes: readonly Lane[]) {
  return answer(`hold:${hold.id}`, {
    class: hold.end === undefined ? "GATE" : "READY",
    cause: `Held ${hold.label}`,
    effect: hold.detail,
    next: "",
    why: `${hold.start} to ${hold.end ?? "now"}`,
    related: lanes
      .filter((lane) => lane.id !== "holds")
      .flatMap((lane) =>
        lane.events
          .filter((e) => overlaps(hold, e))
          .map((e) => ({ text: `${lane.label} ${e.label}`, state: e.detail })),
      ),
  });
}

const detailField = (field: string) => `.inspector dd[data-field="${field}"]`;
const related = (index: number, part: "dt" | "dd") =>
  `.inspector-related > div:nth-child(${index + 1}) > ${part}`;

/** Every Briefing and Releases field the window draws, each at its home surface. */
export function reachCases(snapshot: ViewSnapshot): Reach[] {
  const { briefing, releases } = snapshot;
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
      add(`${pointer}/sub`, firstClause(fact.sub), TODAY, `${tile} .place-tile-counts`, {
        canon: firstClause,
      });
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
        canon: firstClause,
      },
    );
  }
  if (briefing.nextSyncAt) {
    const time = clock(briefing.nextSyncAt);
    add("/briefing/nextSyncAt", time, STRIP, '.window-strip [data-field="next-sync"] b');
    add("/briefing/nextSyncAt", time, STRIP, '.window-strip [data-field="due"]', {
      read: (element) => (element.textContent ?? "").split(" due before ")[1] ?? "",
    });
  }
  add("/briefing/sweptAt", briefing.sweptAt, TODAY, "time.sweep-stamp", { attribute: "dateTime" });

  const { focus: todayFocus, folded } = selectTodayItems(briefing);
  const focusIds = new Set(todayFocus.map(({ id }) => id));
  const foldedIds = new Set(folded.map(({ id }) => id));
  const more = home("Today · More", { kind: "today" }, ["details.today-folded > summary"]);
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
    const route = PLACE_ROUTES[anchor.kind];
    if (!content || !route) return [];
    const { name, route: destination } = route("id" in anchor ? anchor.id : undefined);
    return [
      { kind: anchor.kind, name, destination, ids: new Set(content.items.map(({ id }) => id)) },
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
      const where = home(reading.name, reading.destination);
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
      const where = home(`Service ${service} · Attention`, { kind: "service", id: service }, [
        '[data-section="attention"] > summary',
      ]);
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
      ? { name: "Today", route: TODAY.route, step: `${today} [data-selection-id=${id}]` }
      : reading
        ? {
            name: reading.name,
            route: reading.destination,
            step: `section.place[aria-label=${quote(reading.name)}] [data-selection-id=${id}]`,
          }
        : theme >= 0
          ? { name: "Upstream", route: { kind: "upstream" } as const, step: themeHead(theme) }
          : undefined;
    if (!opener) continue;
    const detail = home(
      `${opener.name} · Detail ${item.id}`,
      opener.route,
      [opener.step],
      itemAnswer(item),
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

  briefing.themes.forEach((theme, index) => {
    const pointer = `/briefing/themes/${index}`;
    if (theme.inspect) {
      const ahead = home("Upstream", { kind: "upstream" });
      const gap = "spicode-t1k.217: a theme with an inspect id opens its item, not the theme";
      add(`${pointer}/next`, theme.next, ahead, "", { exempt: gap });
      for (const list of ["certain", "possible"] as const)
        theme[list].forEach((fork, at) => {
          add(`${pointer}/${list}/${at}/fork`, fork.fork, ahead, "", { exempt: gap });
          add(`${pointer}/${list}/${at}/state`, fork.state, ahead, "", { exempt: gap });
        });
      theme.exposed.forEach((fork, at) => {
        add(`${pointer}/exposed/${at}`, fork, ahead, "", { exempt: gap });
      });
      return;
    }
    const where = home(
      `Upstream · Detail theme:${theme.id}`,
      { kind: "upstream" },
      [themeHead(index)],
      themeAnswer(theme),
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
  environment.facts.forEach((fact, index) => {
    const pointer = `/briefing/environment/facts/${index}`;
    const div = at(`${pointer}/figure`);
    add(`${pointer}/label`, fact.label, runs, `${div} .env-fact-label`);
    add(`${pointer}/figure`, fact.figure, runs, `${div} strong`);
    add(`${pointer}/sub`, fact.sub, runs, `${div} > div:last-child`);
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
        { kind: "environment" },
        ['[data-part="runs"] > summary', bar],
        holdAnswer(e, environment.lanes),
      );
      add(`${event}/label`, `Held ${e.label}`, where, detailField("cause"), {
        canon: (value) => value.replace(/^Held /, ""),
      });
      if (e.detail) add(`${event}/detail`, e.detail, where, detailField("effect"));
      const when = (element: Element) => {
        const [start = "", end = ""] = (element.textContent ?? "").split(" to ");
        const { end: _, ...running } = e;
        return eventWhen(end === "now" ? { ...running, start } : { ...running, start, end }, now);
      };
      add(`${event}/start`, eventWhen(e, now), where, detailField("why"), { read: when });
      if (e.end) add(`${event}/end`, eventWhen(e, now), where, detailField("why"), { read: when });
      let offset = 0;
      environment.lanes
        .filter(({ id }) => id !== "holds")
        .forEach((other) => {
          const otherIndex = environment.lanes.indexOf(other);
          other.events.forEach((run, runIndex) => {
            if (!overlaps(e, run)) return;
            const runPointer = `/briefing/environment/lanes/${otherIndex}/events/${runIndex}`;
            overlapped.add(runPointer);
            add(`${runPointer}/detail`, run.detail, where, related(offset, "dt"));
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

  const releasesPlace = home("Releases", { kind: "releases" });
  const ofName = (element: Element) => (element.textContent ?? "").replace(/^SPI /, "");
  releases.lines.forEach((line, index) => {
    const pointer = `/releases/lines/${index}`;
    const row = `tr${at(pointer)}`;
    const month = home(`Release ${line.month}`, { kind: "release", month: line.month });
    const page = `div${at(pointer)}`;
    add(`${pointer}/name`, line.name, releasesPlace, `${row} button.release-name`, {
      read: ofName,
    });
    add(`${pointer}/notes`, line.notes, releasesPlace, `${row} .notes-chip`, {
      attribute: "data-notes",
    });
    add(`${pointer}/headline`, line.headline, releasesPlace, `${row} td:nth-child(3)`);
    add(`${pointer}/stateText`, line.stateText, releasesPlace, `${row} td:nth-child(4)`);
    add(`${pointer}/month`, line.month, month, "h1", {
      read: (element) => (element.textContent ?? "").replace(/^Release /, ""),
    });
    add(`${pointer}/name`, line.name, month, `${page} > h2`, { read: ofName });
    add(`${pointer}/notes`, line.notes, month, `${page} .notes-chip`, { attribute: "data-notes" });
    add(
      `${pointer}/stateText`,
      line.stateText,
      month,
      (root) => root.querySelector(`${page} .notes-chip`)?.parentElement,
      { read: ownText },
    );
    add(`${pointer}/headline`, line.headline, month, `${page} > h2 + p`);
    line.stats.forEach((stat, at) => {
      const fact = `${page} .pane-fact:nth-child(${at + 1})`;
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
    pattern: /\/(id|ids\/#|inspect|url)$|^\/briefing\/repositories\/first$/,
    reason: "Transport: ids, inspect ids and links the window keys rows and opens Detail with",
  },
  styling: {
    pattern: /\/(tone|fade|strong|weight|attention)$|\/plan\/kind$|^\/releases\/lines\/#\/open$/,
    reason: "Styling and grouping metadata, drawn as tone, order or a data attribute",
  },
  "releases-reading": {
    pattern: /^\/releases\/reading$/,
    reason: "Read state: ReleaseMonth words it as its status line, not as a field",
  },
  verb: {
    pattern: /\/verb$/,
    reason: "Verbs are not drawn until actions ship (PS-04, CO-05; spicode-t1k.56)",
  },
  "unset-flag": {
    pattern: /\/(owned|upstream)$|\/next\/quiet$/,
    reason: "An unset flag draws nothing",
    when: (value) => value === false,
  },
  axis: {
    pattern: /^\/briefing\/environment\/(from|to)$/,
    reason: "The Stack runs timeline's axis frame, drawn as its hour ticks",
  },
  "lens-button": {
    pattern: /^\/briefing\/flow\/plan\/button$/,
    reason:
      "The retired Flow lens's button label; Stack runs draws its own control (spicode-t1k.189)",
  },
  "evidence-label": {
    pattern: /\/evidence\/#\/label$/,
    reason: "spicode-t1k.218: item evidence links render on no surface",
  },
  "briefing-voice": {
    pattern: /^\/briefing\/(headline|summary|doctor\/.+)$/,
    reason: "spicode-t1k.219: the briefing headline, summary and doctor have no home yet",
  },
  "stats-short": {
    pattern: /^\/releases\/lines\/#\/stats\/#\/short$/,
    reason: "spicode-t1k.224: a release stat's short label renders on no surface",
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

/** Leaves with no case or exemption, cases that point at no leaf, and exemptions no leaf uses. */
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
        ([, exemption]) => exemption.pattern.test(pattern) && (exemption.when?.(value) ?? true),
      )?.[0];
      if (name) used.add(name);
      return !name;
    })
    .map(({ pointer }) => pointer);
  const known = new Set(all.map(({ pointer }) => pointer));
  return {
    uncovered,
    stray: [...pointers].filter((pointer) => !known.has(pointer)),
    stale: Object.keys(exemptions).filter((name) => !used.has(name)),
  };
}

/** Routes the window draws no Briefing or Releases field on, each with its reason. */
export const ROUTE_EXEMPTIONS: Readonly<Record<string, string>> = {
  setup: "Setup is not a watch place: it draws the host's setup state, before any sweep",
  security:
    "Security draws its own reading; on the 6 Nov sweep it holds no Briefing item, and its tiles are not Briefing fields",
};

/** Every registry route, the sheet and the strip, less those a case or a named exemption covers. */
export function uncoveredRoutes(
  registry: Registry,
  cases: readonly Reach[],
  exemptions: Readonly<Record<string, string>> = ROUTE_EXEMPTIONS,
) {
  const surfaces = new Set(cases.filter(({ exempt }) => !exempt).map(({ home }) => home.surface));
  return [
    ...Object.keys(registry.views),
    ...(registry.sheet ? ["sheet"] : []),
    ...(registry.strip ? ["strip"] : []),
  ].filter((route) => !surfaces.has(route) && !(route in exemptions));
}
