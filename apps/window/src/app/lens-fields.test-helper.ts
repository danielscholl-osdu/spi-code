// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ViewSnapshot } from "@spi-code/contracts";
import { plainTitle } from "../text.js";
import { timedText } from "../time.js";

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

/** The service home (spicode-mw0.6) retired the service page's Upstream sync Detail. */
export const RETIRED_SYNC_DETAIL =
  "spicode-mw0.6: the service page's Upstream sync Detail is retired; the fork's flow stations carry its sync, and its Upstream tab (spicode-mw0.7) what is queued";
/** The service home (spicode-mw0.6) retired the service page's Repository part. */
export const RETIRED_SERVICE_REPOSITORY =
  "spicode-mw0.6: the service page's Repository part is retired; a fork's open pull requests, issues and alerts move to its tabs (spicode-mw0.7, spicode-mw0.8)";

/** The service home (spicode-mw0.6) retired the service page's reading and Attention part. */
export const RETIRED_SERVICE_READING =
  "spicode-mw0.6: the service page's reading and Attention part are retired; the fork's Overview lists its rows from its home in Today's words, and Today keeps the item's member";

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
    rows.push({
      lens,
      pointer,
      value: timedText(String(value), { hint: false }),
      home,
      selector,
      ...extra,
    });
  };
  const at = (pointer: string) => `[data-pointer="${pointer}"]`;
  const flow = briefing.flow;
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
        `.popover-fields > div:nth-child(${fieldIndex + 1}) dd`,
        { blank: value === "·", exempt: RETIRED_SYNC_DETAIL },
      );
    });
    add("Flow", `${pointer}/detail/title`, row.detail.title || row.fork, home, ".popover h3", {
      exempt: RETIRED_SYNC_DETAIL,
    });
  });
  const repositories = briefing.repositories;
  add(
    "Repositories",
    "/briefing/repositories/headline",
    repositories.headline,
    "Template · Details",
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
        "Template · Details",
        `${at(pointer)} ${selector}`,
        extra,
      );
  });
  repositories.rows.forEach((repo, index) => {
    const pointer = `/briefing/repositories/rows/${index}`;
    const home =
      repo.name === "osdu-spi"
        ? "Template · Details"
        : repo.name === "osdu-spi-stack"
          ? "Environment · Stack repository"
          : `Service ${repo.name} · Repository`;
    const retired =
      repo.name === "osdu-spi" || repo.name === "osdu-spi-stack"
        ? {}
        : { exempt: RETIRED_SERVICE_REPOSITORY };
    for (const [key, value] of [
      ["name", repo.name],
      ["group", repo.group === "program" ? "Program" : "Forks"],
    ] as const)
      add("Repositories", `${pointer}/${key}`, value, home, `${at(`${pointer}/cells`)} h3`, {
        contains: true,
        ...retired,
      });
    const title =
      repo.name === "osdu-spi"
        ? ".template-repo-title"
        : repo.name === "osdu-spi-stack"
          ? at(`${pointer}/title`)
          : `[data-section="repository"] summary .service-section-count`;
    add("Repositories", `${pointer}/title`, plainTitle(repo.title), home, title, retired);
    for (const [key, cell] of Object.entries(repo.cells)) {
      const unread = ["?", "not read yet"].includes(cell.text);
      const extra = retired.exempt
        ? retired
        : unread
          ? { exempt: "Unread figure: draws nothing" }
          : {};
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
