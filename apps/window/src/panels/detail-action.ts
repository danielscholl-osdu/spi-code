// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { InspectResult, ViewSnapshot } from "@spi-code/contracts";
import { navigate, type Route, routeLabel } from "../app/navigation.js";
import type { SelectionRow } from "./selection-rows.js";

/** The item's one action at M2: open its page on GitHub, or open the place that owns it. */
export type DetailAction =
  | { kind: "external"; label: string; url: string }
  | { kind: "place"; label: string; route: Route };

/**
 * Mirrors the desktop link bridge's allowlist (apps/desktop/src/external-links.ts): only
 * https://github.com URLs without credentials open. An action the bridge refuses never renders.
 */
export function bridgeOpens(url: string) {
  try {
    const parsed = new URL(url);
    return (
      parsed.origin === "https://github.com" && parsed.username === "" && parsed.password === ""
    );
  } catch {
    return false;
  }
}

function external(url: string | undefined): DetailAction | undefined {
  return url && bridgeOpens(url) ? { kind: "external", label: "Open on GitHub", url } : undefined;
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
      return external(href);
    case "station": {
      const [, service, station = ""] = row.id.split(":");
      // A line station's own PR, issue or run; queue items and the fork's upstream carry inspect ids.
      // A station whose own link the bridge cannot open falls back to the place it belongs to.
      const own = LINE_STATIONS.has(station)
        ? result?.related.find(
            (related) => related.url && !related.inspect && bridgeOpens(related.url),
          )?.url
        : undefined;
      return external(own) ?? servicePlace(snapshot, service);
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
      return owner ?? external(item.evidence.find(({ url }) => bridgeOpens(url))?.url);
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
