// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ViewSnapshot } from "@spi-code/contracts";
import { type StripState, selectStrip } from "../../store/strip.js";
import { clockTime } from "../../time.js";

const SYNC_WINDOW_MS = 2 * 60 * 60_000;

export type MarkTone = "error" | "warning" | "success" | "work" | "sync";

export type StatusMark =
  | { kind: "count"; tone: "error" | "warning"; count: number }
  | { kind: "check"; tone: "success" }
  | { kind: "wrench"; tone: "warning" }
  | { kind: "refresh"; tone: "work" }
  | { kind: "clock"; tone: "sync" };

/** A status pin's field: what the smoke selects it by, its sentence, and its mark when it has one. */
export type StatusRow = {
  status: "upstream" | "next-sync" | "environment" | "template";
  classification: StripState["classification"] | "soon" | "later";
  sentence?: string;
  mark?: StatusMark;
};

export type StatusPin = "place:upstream" | "place:environment" | "place:engineering-system";

function warningCount(status: "upstream" | "template", count: number, sentence: string): StatusRow {
  return {
    status,
    classification: "pending",
    sentence,
    mark: { kind: "count", tone: "warning", count },
  };
}

function environmentRow(field: StripState): StatusRow {
  const mark: StatusMark | undefined =
    field.classification === "fine"
      ? { kind: "check", tone: "success" }
      : field.classification === "maintenance"
        ? { kind: "wrench", tone: "warning" }
        : field.classification === "refreshing"
          ? { kind: "refresh", tone: "work" }
          : undefined;
  return {
    status: "environment",
    classification: field.classification,
    sentence: field.label,
    ...(mark ? { mark } : {}),
  };
}

function syncRow(nextSync: string | undefined, now: number): StatusRow {
  const at = nextSync === undefined ? Number.NaN : Date.parse(nextSync);
  const ahead = at - now;
  if (!nextSync || !(ahead > 0)) return { status: "next-sync", classification: "unread" };
  const sentence = `Next upstream sync ${clockTime(nextSync, { now })}.`;
  return ahead <= SYNC_WINDOW_MS
    ? {
        status: "next-sync",
        classification: "soon",
        sentence,
        mark: { kind: "clock", tone: "sync" },
      }
    : { status: "next-sync", classification: "later", sentence };
}

/** The next instant a next-sync clock appears or goes, so its row redraws on time. */
export function syncDeadline(nextSync: string | undefined, now: number): number | undefined {
  const at = nextSync === undefined ? Number.NaN : Date.parse(nextSync);
  if (!(at > now)) return undefined;
  return at - SYNC_WINDOW_MS > now ? at - SYNC_WINDOW_MS : at;
}

/** Sidebar marks share Today's Upstream rows and Template door. */
export function statusRows(
  snapshot: ViewSnapshot | undefined,
  now: number,
): Readonly<Record<StatusPin, StatusRow>> {
  const strip = snapshot && selectStrip(snapshot);
  const upstream =
    snapshot?.briefing.lines?.filter(({ members }) =>
      members.some(({ home }) => home === "upstream"),
    ).length ?? 0;
  const template = snapshot?.briefing.today?.fleet?.doors.find(({ id }) => id === "template");
  return {
    "place:upstream": upstream
      ? warningCount(
          "upstream",
          upstream,
          `${upstream} ${upstream === 1 ? "row" : "rows"} on Upstream.`,
        )
      : syncRow(strip?.nextSync, now),
    "place:environment": strip
      ? environmentRow(strip.environment)
      : { status: "environment", classification: "unread" },
    "place:engineering-system": template?.count
      ? warningCount(
          "template",
          template.count,
          `${template.count} template sync ${template.count === 1 ? "PR" : "PRs"} to review: ${template.forks.join(", ")}` +
            (template.notRead.length
              ? `
⌀ Not read: ${template.notRead.join(", ")}`
              : ""),
        )
      : {
          status: "template",
          classification: template && !template.notRead.length ? "fine" : "unread",
          ...(template?.notRead.length
            ? { sentence: `⌀ Not read: ${template.notRead.join(", ")}` }
            : {}),
        },
  };
}

export type StatusDot = "error" | "warning";

export const STATUS_DOT_LABEL: Readonly<Record<StatusDot, string>> = {
  error: "Something needs you now",
  warning: "Something is waiting",
};

/** One dot for what a hidden list holds: error over warning, and none when nothing is marked. */
export function statusDot(
  interrupts: number,
  marks: Iterable<{ readonly tone: StatusMark["tone"] } | undefined>,
): StatusDot | undefined {
  const tones = new Set([...marks].map((mark) => mark?.tone));
  if (interrupts > 0 || tones.has("error")) return "error";
  return tones.has("warning") ? "warning" : undefined;
}
