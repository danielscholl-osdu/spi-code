// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { EnvBorrow, Environment } from "@spi-code/contracts";
import type { ComponentProps } from "react";
import { clockTime } from "../../time.js";
import { fixed, pctOf, span } from "./timeline.js";

export const dayFrom = (to: number) => to - 86_400_000;

export function borrowWhen(borrow: EnvBorrow, now: number): string {
  const start = clockTime(borrow.start, { now });
  const estimate = borrow.estimated ? "≈" : "";
  const end = borrow.end ? Date.parse(borrow.end) : borrow.result === "running" ? now : undefined;
  if (end === undefined) return start;
  const endText = borrow.end ? clockTime(end, { now }) : "now";
  return `${start} to ${estimate}${endText} · ${estimate}${span(end - Date.parse(borrow.start))}`;
}

export function borrowInDay(borrow: EnvBorrow, to: number): boolean {
  return borrowInRange(borrow, dayFrom(to), to);
}

export function borrowInRange(borrow: EnvBorrow, from: number, to: number): boolean {
  const start = Date.parse(borrow.start);
  const end = borrow.result === "running" ? to : Date.parse(borrow.end ?? borrow.start);
  return start <= to && (end > from || (end === start && start === from));
}

export function BorrowRows({
  env,
  to,
  opener,
}: {
  env: Environment;
  to: number;
  opener: (id: string) => ComponentProps<"button">;
}) {
  const rows = new Map<string, EnvBorrow[]>();
  for (const borrow of env.borrows ?? []) {
    if (!borrowInDay(borrow, to)) continue;
    const row = rows.get(borrow.fork);
    if (row) row.push(borrow);
    else rows.set(borrow.fork, [borrow]);
  }
  if (!rows.size && !env.forksNote) return null;
  const from = dayFrom(to);
  return (
    <section className="env-borrows" aria-label="Forks">
      <div className="env-row">
        <h4 className="env-lane-label">Forks</h4>
        {env.forksNote && <p className="env-forks-note">{env.forksNote}</p>}
      </div>
      {[...rows].map(([fork, entries]) => {
        const ends: number[] = [];
        const placed = entries.reverse().map((borrow) => {
          const start = pctOf(Date.parse(borrow.start), from, to);
          const end = borrow.end
            ? pctOf(Date.parse(borrow.end), from, to)
            : borrow.result === "running"
              ? 100
              : start;
          let tier = ends.findIndex((last) => last <= start);
          if (tier < 0) tier = ends.length;
          ends[tier] = Math.max(end, start + 0.85);
          return { borrow, tier, start, end };
        });
        return (
          <div className="env-row" key={fork}>
            <div className="env-lane-label env-fork-label">{fork}</div>
            <div className="env-track" style={{ height: ends.length * 16 + 10 }}>
              {placed.map(({ borrow, tier, start, end }) => {
                const label = [fork, borrow.result, borrowWhen(borrow, to)].join(" · ");
                return (
                  <button
                    type="button"
                    key={borrow.id}
                    className="env-borrow"
                    data-borrow={borrow.id}
                    data-result={borrow.result}
                    data-estimated={borrow.estimated}
                    data-tick={!borrow.end && borrow.result !== "running" ? "" : undefined}
                    aria-label={label}
                    title={label}
                    style={{
                      left: `min(${fixed(start)}%, calc(100% - 8px))`,
                      width: `${fixed(end - start)}%`,
                      top: tier * 16 + 7,
                    }}
                    {...opener(borrow.id)}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </section>
  );
}
