// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { InspectResult, ViewSnapshot } from "@spi-code/contracts";
import { navigate, type Route, routeLabel } from "../app/navigation.js";
import type { SelectionRow } from "./selection-rows.js";

/** The item's one action at M2: open its page on GitHub, or open the place that owns it. */
export type DetailAction =
  | { kind: "external"; label: string; url: string }
  | { kind: "place"; label: string; route: Route };

function external(url: string): DetailAction {
  const host = /^https?:\/\/([^/:]+)/.exec(url)?.[1] ?? "";
  const label = host.endsWith("github.com")
    ? "Open on GitHub"
    : // OSDU's upstream GitLab lives at community.opengroup.org.
      host.includes("gitlab") || host === "community.opengroup.org"
      ? "Open on GitLab"
      : "Open link";
  return { kind: "external", label, url };
}

const LINE_STATIONS = new Set(["upstream", "sync", "cascade", "main"]);

const place = (route: Route): DetailAction => ({
  kind: "place",
  label: `Open ${routeLabel(route)}`,
  route,
});

function servicePlace(snapshot: ViewSnapshot | undefined, id: string | undefined) {
  return id && snapshot?.stations.some(({ service }) => service === id)
    ? place({ kind: "service", id })
    : undefined;
}

/** A program repository's place, or a service's; anything else has no place to open. */
function scopePlace(snapshot: ViewSnapshot | undefined, scope: string) {
  if (scope === "Environment" || scope === "osdu-spi-stack") return place({ kind: "environment" });
  if (scope === "osdu-spi" || scope === "fleet") return place({ kind: "engineering-system" });
  return servicePlace(snapshot, scope);
}

export function detailAction(
  row: SelectionRow | null,
  result: InspectResult | null,
  snapshot: ViewSnapshot | undefined,
): DetailAction | undefined {
  if (!row) return undefined;
  const href = row.fields?.find((field) => field.href)?.href;
  switch (row.kind) {
    case "run":
    case "repository-line":
      return href ? external(href) : undefined;
    case "station": {
      const [, service, station = ""] = row.id.split(":");
      // A line station's own PR, issue or run; queue items and the fork's upstream carry inspect ids.
      const own = LINE_STATIONS.has(station)
        ? result?.related.find((related) => related.url && !related.inspect)?.url
        : undefined;
      return own ? external(own) : servicePlace(snapshot, service);
    }
    case "flow":
      return servicePlace(snapshot, row.id.split(":")[1]);
    case "repository": {
      const repo = snapshot?.briefing.repositories.rows.find(({ id }) => id === row.id);
      return repo ? scopePlace(snapshot, repo.name) : undefined;
    }
    case "queue": {
      const item = [...(snapshot?.briefing.focus ?? []), ...(snapshot?.briefing.rest ?? [])].find(
        ({ id }) => id === row.id,
      );
      if (!item) return undefined;
      const owner = scopePlace(snapshot, item.scope);
      const link = item.evidence.find(({ url }) => /^https?:\/\//.test(url))?.url;
      return owner ?? (link ? external(link) : undefined);
    }
    case "plan":
    case "theme":
      return place({ kind: "upstream" });
    case "environment":
      return place({ kind: "environment" });
    case "template-step":
      return place({ kind: "engineering-system" });
    case "release": {
      const month = snapshot?.releases.lines.find(({ id }) => id === row.id)?.month;
      return month ? place({ kind: "release", month }) : undefined;
    }
  }
}

export function runDetailAction(action: DetailAction) {
  if (action.kind === "external") void window.spi?.openExternal(action.url);
  else navigate(action.route);
}
