// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ViewSnapshot } from "@spi-code/contracts";
import { plainTitle } from "../text.js";
import { FLOW_MODES } from "../views/environment/flow-context.js";

export type LensField = {
  lens: "Flow" | "Repositories" | "Horizon";
  pointer: string;
  value: string;
  home: string;
  selector: string;
  attribute?: string;
  contains?: boolean;
  blank?: boolean;
  exempt?: string;
};

/** The rendered fields, not transport ids, links, sort keys or styling metadata. */
export function lensFields({ briefing }: ViewSnapshot): LensField[] {
  const rows: LensField[] = [];
  const add = (
    lens: LensField["lens"],
    pointer: string,
    value: string | number,
    home: string,
    selector: string,
    extra: Partial<LensField> = {},
  ) => {
    rows.push({ lens, pointer, value: String(value), home, selector, ...extra });
  };
  const at = (pointer: string) => `[data-pointer="${pointer}"]`;
  const flow = briefing.flow;
  for (const key of ["mode", "headline", "sub"] as const)
    if (flow[key])
      add(
        "Flow",
        `/briefing/flow/${key}`,
        key === "mode" ? FLOW_MODES[flow.mode] : flow[key],
        "Environment · Stack runs",
        at(`/briefing/flow/${key}`),
      );
  flow.tiles.forEach((tile, index) => {
    const pointer = `/briefing/flow/tiles/${index}`;
    const waiting = tile.label === "Waiting on you";
    const home = waiting
      ? "Today · Waiting for you, drawn only when pending (M4)"
      : "Environment · Stack runs";
    const extra = waiting
      ? { exempt: "Pending cards ship in M4; spicode-t1k.209 covers GitHub reviews" }
      : {};
    for (const [key, selector] of [
      ["label", "dt"],
      ["value", "strong"],
      ["sub", "dd > span"],
    ] as const)
      add("Flow", `${pointer}/${key}`, tile[key], home, `${at(pointer)} ${selector}`, extra);
    if (tile.meter)
      for (const [key, attribute] of [
        ["busy", "value"],
        ["cap", "max"],
      ] as const)
        add("Flow", `${pointer}/meter/${key}`, tile.meter[key], home, `${at(pointer)} meter`, {
          attribute,
        });
  });
  flow.rows.forEach((row, index) => {
    const pointer = `/briefing/flow/rows/${index}`;
    const home = `Service ${row.fork} · Upstream sync Detail`;
    const fields = [
      ["fork", row.fork],
      ...(row.tag ? [["tag", row.tag]] : []),
      ["behind", row.behind],
      ["carries", row.carries],
      ["ready/text", row.ready.text],
      ["plan/text", row.plan.text],
      ...row.line.map((cell, index) => [`line/${index}/text`, cell.text]),
      ["next/text", row.next.text],
      ...row.detail.lines.map((value, index) => [`detail/lines/${index}`, value]),
    ];
    fields.forEach(([key, value], fieldIndex) => {
      if (key === undefined || value === undefined) throw new Error("Missing Flow field");
      add(
        "Flow",
        `${pointer}/${key}`,
        value,
        home,
        `.detail-row-fields > div:nth-child(${fieldIndex + 1}) dd`,
        { blank: value === "·" },
      );
    });
    add("Flow", `${pointer}/detail/title`, row.detail.title || row.fork, home, ".detail-title");
  });
  for (const [key, selector] of [
    ["title", "h3"],
    ["text", "p"],
    ["button", "button"],
  ] as const)
    if (flow.next[key])
      add(
        "Flow",
        `/briefing/flow/next/${key}`,
        key === "button" ? "View upstream plan" : flow.next[key],
        "Environment · Stack runs",
        `${at("/briefing/flow/next")} ${selector}`,
      );
  flow.also.forEach((item, index) => {
    add(
      "Flow",
      `/briefing/flow/also/${index}/text`,
      item.text,
      "Environment · Stack runs",
      at(`/briefing/flow/also/${index}`),
    );
  });
  if (flow.schedule)
    for (const [key, selector] of [
      ["title", "h3"],
      ["text", "p"],
    ] as const)
      add(
        "Flow",
        `/briefing/flow/schedule/${key}`,
        flow.schedule[key],
        "Environment · Stack runs",
        `${at("/briefing/flow/schedule")} ${selector}`,
      );
  add(
    "Flow",
    "/briefing/flow/plan/title",
    flow.plan.title,
    "Environment · Stack runs",
    at("/briefing/flow/plan/title"),
  );
  flow.plan.lines.forEach((line, index) => {
    for (const [key, selector] of [
      ["label", "dt"],
      ["text", "dd"],
    ] as const)
      add(
        "Flow",
        `/briefing/flow/plan/lines/${index}/${key}`,
        line[key],
        "Environment · Stack runs",
        `${at(`/briefing/flow/plan/lines/${index}`)} ${selector}`,
      );
  });
  add(
    "Flow",
    "/briefing/flow/plan/note",
    flow.plan.note,
    "Environment · Stack runs",
    at("/briefing/flow/plan/note"),
  );

  const repositories = briefing.repositories;
  add(
    "Repositories",
    "/briefing/repositories/headline",
    repositories.headline,
    "Engineering system · Details",
    at("/briefing/repositories/headline"),
  );
  repositories.facts.forEach((fact, index) => {
    const pointer = `/briefing/repositories/facts/${index}`;
    const extra = ["?", "not read yet"].includes(fact.figure)
      ? { exempt: "Unread figure: draws nothing" }
      : {};
    for (const [key, selector] of [
      ["label", "dt"],
      ["figure", "strong"],
      ["sub", "dd > span"],
    ] as const)
      add(
        "Repositories",
        `${pointer}/${key}`,
        fact[key],
        "Engineering system · Details",
        `${at(pointer)} ${selector}`,
        extra,
      );
  });
  repositories.rows.forEach((repo, index) => {
    const pointer = `/briefing/repositories/rows/${index}`;
    const home =
      repo.name === "osdu-spi"
        ? "Engineering system · Details"
        : repo.name === "osdu-spi-stack"
          ? "Environment · Stack repository"
          : `Service ${repo.name} · Repository`;
    for (const [key, value] of [
      ["name", repo.name],
      ["group", repo.group === "program" ? "Program" : "Forks"],
    ] as const)
      add("Repositories", `${pointer}/${key}`, value, home, `${at(`${pointer}/cells`)} h3`, {
        contains: true,
      });
    const title =
      repo.name === "osdu-spi"
        ? ".template-repo-title"
        : repo.name === "osdu-spi-stack"
          ? at(`${pointer}/title`)
          : `[data-section="repository"] summary .service-section-count`;
    add("Repositories", `${pointer}/title`, plainTitle(repo.title), home, title);
    for (const [key, cell] of Object.entries(repo.cells)) {
      const unread = ["?", "not read yet"].includes(cell.text);
      const extra = unread ? { exempt: "Unread figure: draws nothing" } : {};
      add(
        "Repositories",
        `${pointer}/cells/${key}/text`,
        cell.text,
        home,
        `${at(`${pointer}/cells/${key}`)} dd > span:first-child`,
        extra,
      );
      if (cell.rest)
        add(
          "Repositories",
          `${pointer}/cells/${key}/rest`,
          cell.rest,
          home,
          `${at(`${pointer}/cells/${key}`)} dd > span:nth-child(2)`,
          extra,
        );
    }
  });
  add(
    "Horizon",
    "/briefing/horizon/headline",
    briefing.horizon.headline,
    "Upstream · Further ahead",
    at("/briefing/horizon/headline"),
  );
  briefing.themes.forEach((theme, index) => {
    for (const [key, selector] of [
      ["title", ".upstream-theme-title"],
      ["sub", ".upstream-theme-sub"],
      ["kind", ".upstream-theme-kind"],
      ["when", ".upstream-theme-when"],
    ] as const) {
      const value = theme[key];
      if (value)
        add(
          "Horizon",
          `/briefing/themes/${index}/${key}`,
          value,
          "Upstream · Further ahead",
          `${at(`/briefing/themes/${index}`)} ${selector}`,
        );
    }
  });
  return rows;
}
