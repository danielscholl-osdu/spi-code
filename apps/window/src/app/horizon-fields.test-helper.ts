// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Horizon } from "@spi-code/contracts";
import type { LensField } from "./lens-fields.test-helper.js";

/** Each horizon leaf's drawn home; navigation bindings are exercised by horizon.test.tsx. */
export function horizonFields(horizon: Horizon): LensField[] {
  const fields: LensField[] = [];
  const add = (pointer: string, value: unknown, selector: string, extra: Partial<LensField> = {}) =>
    fields.push({
      lens: "Horizon",
      home: "Today · On the horizon",
      pointer,
      value: String(value),
      selector,
      ...extra,
    });
  const at = (pointer: string) => `[data-pointer="${pointer}"]`;
  function walk(value: unknown, pointer: string): void {
    if (Array.isArray(value)) {
      value.forEach((entry, i) => {
        walk(entry, `${pointer}/${i}`);
      });
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) walk(entry, `${pointer}/${key}`);
      return;
    }
    const parent = pointer.slice(0, pointer.lastIndexOf("/"));
    const key = pointer.slice(pointer.lastIndexOf("/") + 1);
    const root = at(parent);
    if (key === "headline") return;
    if (/\/itemIds\/\d+$/.test(pointer) || ["id", "url", "inspect", "surfaceItems"].includes(key)) {
      add(pointer, value, root, {
        exempt:
          "Navigation identity or item-unit metadata; card-unit counts and their core sentence are drawn. Openers are click-tested.",
      });
    } else if (/\/services\/\d+$/.test(pointer)) {
      add(pointer, value, `${at(pointer)} .kit-chip--service`);
    } else if (key === "text") {
      if (parent.endsWith("/counts")) add(pointer, value, root);
      else if (parent.endsWith("/owed"))
        add(pointer, value, `${root} .kit-segmented`, { attribute: "aria-label" });
      else add(pointer, value, root, { attribute: "title" });
    } else if (key === "count") {
      if (parent.endsWith("/owed"))
        add(pointer, value, `${root} .kit-bar-figure`, { contains: true });
      else if (/\/owed\/services\//.test(parent)) {
        const i = Number(parent.slice(parent.lastIndexOf("/") + 1));
        add(pointer, value, `.horizon-owed .kit-segment:nth-child(${i + 1})`, {
          attribute: "data-count",
        });
      } else
        add(
          pointer,
          value,
          `${root} ${parent.includes("wontLand") ? ".horizon-wont-count" : "strong"}`,
        );
    } else if (key === "service") {
      if (parent.includes("/owed/services/")) {
        const i = Number(parent.slice(parent.lastIndexOf("/") + 1));
        add(pointer, value, `.horizon-owed .kit-segment:nth-child(${i + 1})`, {
          attribute: "title",
          contains: true,
        });
      } else add(pointer, value, `${root} .kit-chip--service`);
    } else if (key === "number") {
      add(pointer, `#${value}`, `${at(parent.slice(0, -3))} .kit-pr`);
    } else if (key === "at") add(pointer, value, `${root} time`, { attribute: "dateTime" });
    else if (key === "token") add(pointer, value, `${root} .horizon-token`);
    else if (key === "verb") add(pointer, value, `${root} .horizon-verb`, { contains: true });
    else {
      const attribute = {
        kind: "data-kind",
        mark: "data-mark",
        stage: "data-stage",
        needsYou: "data-needs-you",
        reason: "data-reason",
        needYouCards: "data-need-you",
        toWatchCards: "data-to-watch",
      }[key];
      if (!attribute) throw new Error(`No horizon home for ${pointer}`);
      add(pointer, value, root, { attribute });
    }
  }
  walk(horizon, "/briefing/horizon");
  return fields;
}
