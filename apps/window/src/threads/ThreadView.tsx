// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { Composer } from "./Composer.js";
import { Timeline } from "./Timeline.js";
import type { ThreadViewProps } from "./types.js";
import "./threads.css";

/** A thread in the centre: its timeline and composer, or a draft with nothing sent. */
export function ThreadView({ entries, contextLine, origin, ...composer }: ThreadViewProps) {
  return (
    <section className={composer.draft ? "thread-view thread-view--draft" : "thread-view"}>
      {composer.draft ? (
        <p className="thread-origin">
          {origin ? `${origin}. ` : ""}Nothing is sent until you press send.
        </p>
      ) : (
        <Timeline
          entries={entries}
          contextLine={contextLine}
          running={composer.running}
          onOpenLink={composer.onOpenLink}
        />
      )}
      <Composer {...composer} />
    </section>
  );
}
