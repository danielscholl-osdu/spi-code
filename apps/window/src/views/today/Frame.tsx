// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ReactNode } from "react";
import { dayLine } from "../../time.js";
import { useTodayAnchor } from "./anchor.js";

/** Where each later part of Today mounts; an empty slot draws nothing, never an empty box. */
export type TodaySlots = {
  band?: ReactNode;
  horizon?: ReactNode;
  places?: ReactNode;
  releases?: ReactNode;
  motion?: ReactNode;
};

function Slot({ name, children }: { name: keyof TodaySlots; children: ReactNode }) {
  return children ? (
    <div className="today-slot" data-today-slot={name}>
      {children}
    </div>
  ) : null;
}

/**
 * Today top to bottom: the verdict when there is one to draw, the caveat band, the attention band,
 * On the horizon, the place cards, then Releases beside In motion.
 */
export function TodayFrame({
  sweptAt,
  head,
  caveat,
  slots,
}: {
  sweptAt: string;
  head: ReactNode;
  caveat: ReactNode;
  slots: TodaySlots;
}) {
  const frame = useTodayAnchor();
  const lower = Boolean(slots.releases || slots.motion);
  return (
    <section className="place" aria-label="Today">
      <header className="place-header pane-header">
        <h1 data-place>Today</h1>
        <time className="today-date" dateTime={sweptAt}>
          {dayLine(sweptAt)}
        </time>
      </header>
      <section ref={frame} className="place-reading today-frame" aria-label="Today reading">
        {head && <div className="today-head">{head}</div>}
        {caveat}
        <Slot name="band">{slots.band}</Slot>
        <Slot name="horizon">{slots.horizon}</Slot>
        <Slot name="places">{slots.places}</Slot>
        {lower && (
          <div className="today-lower">
            <Slot name="releases">{slots.releases}</Slot>
            <Slot name="motion">{slots.motion}</Slot>
          </div>
        )}
      </section>
    </section>
  );
}
