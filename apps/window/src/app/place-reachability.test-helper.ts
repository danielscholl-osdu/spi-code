// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ViewSnapshot } from "@spi-code/contracts";
import type { Destination } from "./navigation.js";
import type { Reach } from "./reachability.test-helper.js";

/** Place-card fields, with the card's own opener and each visual's core-supplied names. */
export function placeReachCases(snapshot: ViewSnapshot): Reach[] {
  const cases: Reach[] = [];
  const home = {
    name: "Today",
    start: { name: "Today", surface: "today", route: { kind: "today" as const } },
  };
  const { focus, rest } = snapshot.briefing;
  const items = [
    ...focus.map((item, index) => [`/briefing/focus/${index}`, item] as const),
    ...rest.map((item, index) => [`/briefing/rest/${index}`, item] as const),
  ];
  snapshot.briefing.places?.forEach((row, index) => {
    const card = `.today-place[data-place="${row.place}"]`;
    const base = `/briefing/places/${index}`;
    const add = (
      path: string,
      value: unknown,
      selector: string,
      extra: Partial<Reach> = {},
    ): void => {
      cases.push({
        pointer: `${base}/${path}`,
        value: String(value),
        home,
        selector: `${card} ${selector}`,
        ...extra,
      });
    };
    const attr = (
      path: string,
      value: unknown,
      selector: string,
      attribute: string,
      contains = false,
    ) => {
      add(path, value, selector, { attribute, ...(contains ? { contains } : {}) });
    };
    const self = (path: string, value: unknown, attribute: string) =>
      cases.push({
        pointer: `${base}/${path}`,
        value: String(value),
        home,
        selector: card,
        attribute,
      });
    self("place", row.place, "data-place");
    self("mark", row.mark, "data-mark");
    attr("tone", row.tone, ".today-place-figure", "data-tone");
    add("figure", row.figure, ".today-place-figure");
    attr("line", row.line, ".today-place-open", "title");
    if (row.reason) add("reason", row.reason, ".today-place-reason");
    if (row.caveat) add("caveat", row.caveat, ".today-place-caveat");
    row.areas.forEach((area, at) => {
      cases.push({
        pointer: `${base}/areas/${at}`,
        value: area,
        home,
        selector: card,
        attribute: "data-areas",
        contains: true,
      });
    });
    row.itemIds.forEach((id, at) => {
      cases.push({
        pointer: `${base}/itemIds/${at}`,
        value: id,
        home,
        selector: card,
        attribute: "data-items",
        contains: true,
      });
    });
    row.fresh.itemIds.forEach((id, at) => {
      const click = `${card} .today-place-new`;
      add(`fresh/itemIds/${at}`, id, ".today-place-new", {
        attribute: "data-items",
        contains: true,
        opens: { click, place: freshDestination(row.place) },
      });
    });
    if (row.unread) {
      row.unread.areas.forEach((area, at) => {
        attr(`unread/areas/${at}`, area, ".today-place-held", "data-areas", true);
      });
      if (row.unread.lastGood)
        attr("unread/lastGood", row.unread.lastGood, ".today-place-held time", "dateTime");
    }
    const visual = row.visual;
    if (!visual) return;
    attr("visual/kind", visual.kind, "[data-visual]", "data-visual");
    if (visual.kind === "pips" || visual.kind === "rollout") {
      visual.slots.forEach((slot, at) => {
        const button = `.today-place-slot:nth-child(${at + 1})`;
        attr(`visual/slots/${at}/service`, slot.service, button, "data-service");
        attr(`visual/slots/${at}/state`, slot.state, button, "data-state");
        attr(`visual/slots/${at}/text`, slot.text, button, "aria-label");
        if (slot.origin) attr(`visual/slots/${at}/origin`, slot.origin, button, "data-origin");
        const selector = `${card} ${button}`;
        const opens = { click: selector, place: { kind: "service" as const, id: slot.service } };
        for (const [pointer, item] of items) {
          if (!row.itemIds.includes(item.id) || item.scope !== slot.service) continue;
          const field = { home, selector, opens };
          cases.push({
            pointer: `${pointer}/scope`,
            value: item.scope,
            ...field,
            attribute: "data-service",
          });
          if (slot.origin && item.origin === slot.origin)
            cases.push({
              pointer: `${pointer}/origin`,
              value: item.origin,
              ...field,
              attribute: "data-origin",
            });
        }
      });
      if (visual.kind === "rollout")
        attr("visual/target", visual.target, "[data-visual]", "data-target");
      else {
        visual.stopped.forEach((id, at) => {
          add(`visual/stopped/${at}`, id, `.today-place-stopped button:nth-child(${at + 1})`);
        });
        if (visual.horizon) {
          attr("visual/horizon/text", visual.horizon.text, ".kit-chip--upstream", "aria-label");
          add("visual/horizon/count", visual.horizon.count, ".kit-chip--upstream", {
            contains: true,
          });
        }
      }
    } else if (visual.kind === "lifecycle") {
      visual.lanes.forEach((lane, at) => {
        const div = `.today-place-lifecycle > div:nth-child(${at + 1})`;
        attr(`visual/lanes/${at}/lane`, lane.lane, div, "data-lane");
        attr(`visual/lanes/${at}/green`, lane.green, `${div} meter`, "value");
        attr(`visual/lanes/${at}/total`, lane.total, div, "data-total");
        attr(`visual/lanes/${at}/text`, lane.text, div, "title");
        if (lane.state) attr(`visual/lanes/${at}/state`, lane.state, div, "data-state");
      });
      if (visual.greenSince)
        attr("visual/greenSince", visual.greenSince, ".today-place-green time", "dateTime");
    } else {
      visual.columns.forEach((column, at) => {
        const div = `.today-place-column:nth-child(${at + 1})`;
        attr(`visual/columns/${at}/service`, column.service, div, "data-service");
        attr(`visual/columns/${at}/count`, column.count, div, "data-count");
        attr(`visual/columns/${at}/text`, column.text, div, "aria-label");
        column.rules.forEach((rule, i) => {
          attr(`visual/columns/${at}/rules/${i}`, rule, div, "title", true);
        });
      });
      if (visual.program) {
        add("visual/program/text", visual.program.text, ".today-place-program");
        attr("visual/program/count", visual.program.count, ".today-place-program", "data-count");
        visual.program.rules.forEach((rule, i) => {
          attr(`visual/program/rules/${i}`, rule, ".today-place-program .kit-chip", "title", true);
        });
      }
      if (visual.largest)
        for (const key of ["label", "forks", "text"] as const)
          add(`visual/largest/${key}`, visual.largest[key], ".today-place-largest", {
            contains: true,
          });
    }
  });
  return [...cases, ...placeFreshCases(snapshot)];
}

const freshDestination = (place: string): Destination => {
  switch (place) {
    case "line":
      return { kind: "line" };
    case "environment":
      return { kind: "environment" };
    case "engineering":
      return { kind: "engineering-system" };
    default:
      return { kind: "security" };
  }
};

/** Fresh ids have a visible chip at their place as well as the opener on Today. */
export function placeFreshCases(snapshot: ViewSnapshot): Reach[] {
  return (snapshot.briefing.places ?? []).flatMap((row, index) =>
    (row.fresh?.itemIds ?? []).map((id, at) => ({
      pointer: `/briefing/places/${index}/fresh/itemIds/${at}`,
      value: id,
      home: {
        name: `Fresh items · ${row.place}`,
        start: {
          name: row.place,
          surface: row.place === "line" ? "sheet" : freshDestination(row.place).kind,
          route: freshDestination(row.place),
        },
      },
      selector: `[data-fresh-item=${JSON.stringify(id)}]`,
      attribute: "data-fresh-item",
    })),
  );
}
