// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ReactNode } from "react";
import { PaneTitle } from "../../app/title-row.js";
import { dayLine } from "../../time.js";

/** Today top to bottom: the date, the caveat band when a read failed, then its body. */
export function TodayFrame({
  sweptAt,
  caveat,
  children,
}: {
  sweptAt: string;
  caveat: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="place" aria-label="Today">
      <PaneTitle>
        <h1 data-place>Today</h1>
        <time className="today-date" dateTime={sweptAt}>
          {dayLine(sweptAt)}
        </time>
      </PaneTitle>
      <section className="place-reading today-frame" aria-label="Today reading">
        {caveat}
        {children}
      </section>
    </section>
  );
}
