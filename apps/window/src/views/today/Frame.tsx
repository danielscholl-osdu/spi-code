// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ReactNode } from "react";
import { PaneTitle } from "../../app/title-row.js";
import { dayLine } from "../../time.js";

/** Today top to bottom: the date, the caveat band when a read failed, then the table. */
export function TodayFrame({
  sweptAt,
  caveat,
  table,
}: {
  sweptAt: string;
  caveat: ReactNode;
  table: ReactNode;
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
        {table}
      </section>
    </section>
  );
}
