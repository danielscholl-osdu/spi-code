// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type Link, type Station, todayMembers, type ViewSnapshot } from "@spi-code/contracts";
import { LINE, type LineColumn, type OpenSelection } from "../../app/navigation.js";
import { type OpenedContent, todayContent } from "../../components/opened-body/content.js";
import { type PlaceMember, placeMembers } from "../../components/place/members.js";
import { plainTitle } from "../../text.js";
import { cellItems, cellState, columns, memberStations } from "./cells.js";

export type CellOpening = {
  /** `fork:station`, as the cell's `data-cell` and a `cell` open selection name it. */
  cell: string;
  content: OpenedContent;
  /** The cell's other members, which the popover names under its body. */
  related: PlaceMember[];
};

const WORKFLOWS: Partial<Record<Station["id"], string>> = {
  upstream: "Sync Upstream",
  sync: "Sync Upstream",
  cascade: "Cascade Integration",
  main: "Validation",
};

/** The cell's Today members in core's order, so the first is the most urgent. */
export function cellMembers(snapshot: ViewSnapshot, service: string, station: Station["id"]) {
  const items = [...snapshot.briefing.focus, ...snapshot.briefing.rest];
  const ids = new Set(cellItems(items, service, station).map(({ id }) => id));
  return todayMembers(snapshot.briefing).filter(
    ({ member }) => ids.has(member.id) || member.ids.some((id) => ids.has(id)),
  );
}

/** Only a halted sync is known to hold the fork's upstream; any other stop holds nothing it can name. */
function heldBy(snapshot: ViewSnapshot, service: string, station: Station["id"]) {
  if (station !== "upstream") return undefined;
  return cellMembers(snapshot, service, "sync").find(({ line }) => line.section === "blocked");
}

/** The fork's repository, from a run the sweep read on it; unknown when it read none. */
function forkRepository(runs: readonly { url: string }[]) {
  const url = runs[0] && new URL(runs[0].url);
  const [owner, repo] = url?.pathname.split("/").filter(Boolean) ?? [];
  return url && owner && repo ? `${url.origin}/${owner}/${repo}` : undefined;
}

/** A cell with no member opens its station's latest run, the lane's deployments, or the fork's Actions page. */
function cellSource(
  snapshot: ViewSnapshot,
  service: string,
  station: Station["id"],
): Link | undefined {
  const runs = snapshot.services?.find((row) => row.service === service)?.runs ?? [];
  const run = runs
    .filter((run) => run.workflow === WORKFLOWS[station])
    .sort((a, b) => b.time.localeCompare(a.time))[0];
  if (run) return { kind: "run", label: `${run.workflow} run`, url: run.url };
  const repository = forkRepository(runs);
  if (!repository) return undefined;
  return station === "lane"
    ? { kind: "deploy", label: "Deployments", url: `${repository}/deployments` }
    : { kind: "other", label: "Actions", url: `${repository}/actions` };
}

function stateSentence(state: ReturnType<typeof cellState>, held: PlaceMember | undefined) {
  switch (state) {
    case "ready":
      return "Nothing waits here.";
    case "stopped":
      return held
        ? `Held by the blocked sync: ${held.member.fork} ${plainTitle(held.line.headline).split(":")[0]}.`
        : "Not on Today. SPI Code has no item for this and didn't read the run.";
    case "waiting-on-clock":
      return "Waits on a scheduled run; nothing here is yours.";
    case "unread":
      return "SPI Code didn't read this station.";
    default:
      return "Nothing here is on Today; it moves on its own.";
  }
}

/** Where an open selection lands on the sheet: a cell, or a stepped member's first cell. */
function target(snapshot: ViewSnapshot, open: OpenSelection) {
  if (open.kind === "cell") {
    const [service = "", station = ""] = open.id.split(":");
    return { service, station, lead: undefined };
  }
  if (open.kind !== "item") return undefined;
  const lead = placeMembers(snapshot, "line").find(({ member }) => member.id === open.id);
  const station = memberStations(lead?.member).find((id) => columns.some((c) => c.id === id));
  return lead && station ? { service: lead.member.fork, station, lead } : undefined;
}

/** The popover for what is open on the Line: a clicked cell leads with its most urgent member. */
export function cellOpening(
  snapshot: ViewSnapshot | undefined,
  open: OpenSelection | null,
): CellOpening | undefined {
  if (!snapshot || !open) return undefined;
  const at = target(snapshot, open);
  const column = columns.find(({ id }) => id === at?.station);
  const station = snapshot.stations
    .find((row) => row.service === at?.service)
    ?.stations.find(({ id }) => id === column?.id);
  if (!at || !column || !station) return undefined;
  const { service } = at;
  const cell = `${service}:${column.id}`;
  const members = cellMembers(snapshot, service, column.id);
  const lead = at.lead ?? members[0];
  const place = {
    label: `Line › ${service} › ${column.label}`,
    destination: column.id === "lane" ? LINE : { ...LINE, column: column.id as LineColumn },
    selection: { kind: "cell", id: cell },
  };
  if (lead) {
    const items = [...snapshot.briefing.focus, ...snapshot.briefing.rest];
    const content = todayContent({ line: lead.line, member: lead.member, items, place });
    return {
      cell,
      content: { ...content, title: plainTitle(content.title) },
      related: members.filter(({ member }) => member.id !== lead.member.id),
    };
  }
  const held = cellState(station) === "stopped" ? heldBy(snapshot, service, column.id) : undefined;
  const source = cellSource(snapshot, service, column.id);
  return {
    cell,
    content: {
      title: `${service} · ${column.label}`,
      place,
      subject: null,
      cause: stateSentence(cellState(station), held),
      ...(source ? { primary: source, links: [source] } : {}),
    },
    related: [],
  };
}
