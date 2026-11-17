// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { StripFields, StripState } from "../../store/strip.js";
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
  status: "forks" | "next-sync" | "environment" | "template";
  classification: StripState["classification"] | "soon" | "later";
  sentence?: string;
  mark?: StatusMark;
  services?: number;
};

export type StatusPin =
  | "sheet:line"
  | "place:upstream"
  | "place:environment"
  | "place:engineering-system";

const count = (field: StripState, tone: "error" | "warning"): StatusMark | undefined =>
  field.count !== undefined && field.count > 0
    ? { kind: "count", tone, count: field.count }
    : undefined;

function countRow(
  status: "forks" | "template",
  field: StripState,
  worse: StripState["classification"],
  better: StripState["classification"],
): StatusRow {
  const mark =
    field.classification === worse
      ? count(field, "error")
      : field.classification === better
        ? count(field, "warning")
        : undefined;
  return {
    status,
    classification: field.classification,
    sentence: field.label,
    ...(mark ? { mark } : {}),
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

/** Each status pin's field from the strip; without a snapshot every field is unread and unmarked. */
export function statusRows(
  fields: StripFields | undefined,
  now: number,
): Readonly<Record<StatusPin, StatusRow>> {
  if (!fields)
    return {
      "sheet:line": { status: "forks", classification: "unread", services: 0 },
      "place:upstream": { status: "next-sync", classification: "unread" },
      "place:environment": { status: "environment", classification: "unread" },
      "place:engineering-system": { status: "template", classification: "unread" },
    };
  return {
    "sheet:line": {
      ...countRow("forks", fields.forks, "stopped", "waiting"),
      services: fields.forks.services,
    },
    "place:upstream": syncRow(fields.nextSync, now),
    "place:environment": environmentRow(fields.environment),
    "place:engineering-system": countRow("template", fields.template, "failed", "pending"),
  };
}

export type StatusDot = "error" | "warning";

export const STATUS_DOT_LABEL: Readonly<Record<StatusDot, string>> = {
  error: "Something needs you now",
  warning: "Something is waiting",
};

/** One dot for what a hidden list holds: error over warning, and none when nothing is marked. */
export function statusDot(
  today: number,
  marks: Iterable<{ readonly tone: StatusMark["tone"] } | undefined>,
): StatusDot | undefined {
  const tones = new Set([...marks].map((mark) => mark?.tone));
  if (today > 0 || tones.has("error")) return "error";
  return tones.has("warning") ? "warning" : undefined;
}
