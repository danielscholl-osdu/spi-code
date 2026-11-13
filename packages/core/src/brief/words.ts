// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { CoreContext } from "../context.js";
import { HISTORY_DAYS } from "../config.js";
import type { Model } from "../model/index.js";
import type { LifecycleStat } from "../model/stack.js";
import { span, stamp } from "../util.js";

export function ago(at: string, now: Date): string | undefined {
  const text = span(now.getTime() - Date.parse(at));
  return text && `${text} ago`;
}

export function streakText(stat: LifecycleStat): string | undefined {
  const s = stat.streak;
  if (!s || s.n < 2) return undefined;
  return s.green ? `${s.n} in a row` : `red ${s.n} in a row`;
}

function pct(share: number): string {
  // Never round a held window up to a clean 100.
  return `${Math.floor(share * 100)}%`;
}

// How much of the window the environment was not held; figure is null while a day is unread.
export function deployableWords(
  model: Model,
  now: Date,
  context?: Pick<CoreContext, "timeStyle" | "words">,
): { label: string; figure: string | null; sub: string } {
  const a = model.stack.availability;
  const app = context?.words === "app";
  const label = `${app ? "Ready" : "Deployable"} · ${HISTORY_DAYS} days`;
  const held = app ? "in maintenance" : "held";
  if (!a) return { label, figure: null, sub: "no lifecycle run read" };
  const unread = model.stack.history.held?.filter((d) => d.unread).length ?? 0;
  const at = a.since !== undefined && Number.isFinite(a.since) ? stamp(new Date(a.since).toISOString(), now, context) : undefined;
  return {
    label,
    figure: unread > 0 ? null : pct(a.share),
    sub: [
      a.long === 0
        ? "no hold over an hour"
        : `${a.long} ${a.long === 1 ? "hold" : "holds"} over an hour, ${span(a.longMs)} in all`,
      a.heldNow ? (at ? `${held} since ${at}` : `${held} now`) : at ? `up since ${at}` : undefined,
      unread > 0 ? `${unread === 1 ? "1 day" : `${unread} days`} not read` : undefined,
    ]
      .filter(Boolean)
      .join(" · "),
  };
}
