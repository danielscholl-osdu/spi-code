// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { EnvBorrow, Environment } from "@spi-code/contracts";
import { type ComponentProps, type ReactNode, useState } from "react";
import { timedText } from "../../time.js";
import { type Day, dayNames } from "./range.js";
import { eventWord, fixed, LABEL_PX, pctOf, TRACK_MIN_PX } from "./timeline.js";

export function borrowDetail(borrow: EnvBorrow, now: number): string {
  const detail = borrow.detail ?? [borrow.start, borrow.end].filter(Boolean).join(" → ");
  return timedText(detail, { now });
}

export function borrowInRange(borrow: EnvBorrow, from: number, to: number): boolean {
  const start = Date.parse(borrow.start);
  const end = borrow.result === "running" ? to : Date.parse(borrow.end ?? borrow.start);
  return start <= to && (end > from || (end === start && start === from));
}

/** Each fork that borrowed in the range, newest first, with its borrows oldest first. */
function forkRows(env: Environment, from: number, to: number) {
  const rows = new Map<string, EnvBorrow[]>();
  for (const borrow of env.borrows ?? []) {
    if (!borrowInRange(borrow, from, to)) continue;
    const row = rows.get(borrow.fork);
    if (row) row.unshift(borrow);
    else rows.set(borrow.fork, [borrow]);
  }
  return [...rows];
}

function ForksHeading({ env }: { env: Environment }) {
  return (
    <div className="env-row">
      <h4 className="env-lane-label">Forks</h4>
      {env.forksNote && <p className="env-forks-note">{env.forksNote}</p>}
    </div>
  );
}

const SHOWN_FORKS = 5;
const PILL_PX = 64;

/** A day's column on the 7-day track; one too narrow for `px` at the narrowest track keeps its content inside the now line. */
export function DayCell({
  day,
  from,
  to,
  px,
  children,
}: {
  day: Day;
  from: number;
  to: number;
  px: number;
  children: ReactNode;
}) {
  const left = pctOf(day.start, from, to);
  const right = pctOf(day.end, from, to);
  return (
    <span
      className="env-day-cell"
      data-narrow={((right - left) / 100) * (TRACK_MIN_PX - LABEL_PX) < px || undefined}
      style={{ left: `${fixed(left)}%`, width: `${fixed(right - left)}%` }}
    >
      {children}
    </span>
  );
}

/** 7 days: one pill per fork per day that opens it, the five most recent forks until all are asked for. */
export function ForkDays({
  env,
  days,
  from,
  to,
  onOpen,
}: {
  env: Environment;
  days: readonly Day[];
  from: number;
  to: number;
  onOpen: (day: Day) => void;
}) {
  const [all, setAll] = useState(false);
  const rows = forkRows(env, from, to);
  const words = env.activity?.words;
  if (!rows.length && !env.forksNote) return null;
  return (
    <section className="env-borrows" aria-label="Forks">
      <ForksHeading env={env} />
      {rows.slice(0, all ? undefined : SHOWN_FORKS).map(([fork, entries]) => (
        <div className="env-row" key={fork} data-fork={fork}>
          <div className="env-lane-label env-fork-label">{fork}</div>
          <div className="env-track">
            {days.map((day) => {
              const own = entries.filter(({ start }) => {
                const at = Date.parse(start);
                return at >= day.start && at < day.end;
              });
              if (!own.length) return null;
              const failed = own.filter(({ result }) => result === "failed").length;
              const running = own.some(({ result }) => result === "running");
              const count = words
                ? `${own.length} ${own.length === 1 ? words.borrow : words.borrows}`
                : String(own.length);
              const label = [
                `${fork}, ${dayNames(day).long}: ${count}`,
                failed ? `${failed} ${eventWord.failed}` : "",
                running ? eventWord.running : "",
              ]
                .filter(Boolean)
                .join(", ");
              return (
                <DayCell key={day.key} day={day} from={from} to={to} px={PILL_PX}>
                  <button
                    type="button"
                    className="env-pill"
                    data-day={day.key}
                    aria-label={label}
                    title={label}
                    onClick={() => onOpen(day)}
                  >
                    {own.length}
                    {failed > 0 && <small>{` · ${failed}\u2715`}</small>}
                    {running && <i className="env-pill-running" aria-hidden="true" />}
                  </button>
                </DayCell>
              );
            })}
          </div>
        </div>
      ))}
      {rows.length > SHOWN_FORKS && (
        <button
          type="button"
          className="env-more"
          aria-expanded={all}
          onClick={() => setAll((shown) => !shown)}
        >
          {all ? "Fewer forks" : `All ${rows.length} forks`}
        </button>
      )}
    </section>
  );
}

export function BorrowRows({
  env,
  from,
  to,
  now,
  opener,
}: {
  env: Environment;
  from: number;
  to: number;
  now: number;
  opener: (id: string) => ComponentProps<"button">;
}) {
  const rows = forkRows(env, from, to);
  if (!rows.length && !env.forksNote) return null;
  return (
    <section className="env-borrows" aria-label="Forks">
      <ForksHeading env={env} />
      {rows.map(([fork, entries]) => {
        const ends: number[] = [];
        const placed = entries.map((borrow) => {
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
                const label = [fork, borrowDetail(borrow, now)].join(" · ");
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
