// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ReactNode } from "react";
import { PaneTitle } from "../../app/title-row.js";
import { Icon } from "../../components/icons/Icon.js";
import { dayLine, Time } from "../../time.js";
import { forksWord } from "./fleet.js";
import type { TodayRead } from "./read.js";

function ReadState({ read }: { read: TodayRead }) {
  const { sweptAt, reading, count } = read;
  const progress = count ? `${count.done} of ${count.of}` : null;
  if (!sweptAt)
    return reading ? (
      <span className="today-read-state">{progress ? `Reading ${progress}` : "Reading"}</span>
    ) : null;
  const after = reading
    ? ` · reading${progress ? ` ${progress}` : ""}`
    : read.gaps.length === 0 && read.forks !== null
      ? ` · ${forksWord(read.forks)}`
      : "";
  return (
    <span className="today-read-state">
      Read <Time at={sweptAt} hint={false} />
      {after}
    </span>
  );
}

/** The title row's end: what was not read, how the read stands, and Read again. */
function ReadEnd({
  read,
  sweeping,
  onReadAgain,
  onOpenEvidence,
}: {
  read: TodayRead;
  sweeping: boolean;
  onReadAgain: () => void;
  onOpenEvidence: () => void;
}) {
  const gaps = read.gaps.join(", ");
  return (
    <span className="today-read">
      {read.gaps.length > 0 && (
        <button
          type="button"
          className="today-read-gap"
          title={`${gaps} · opens Evidence`}
          aria-label={`${gaps}, open Evidence`}
          onClick={onOpenEvidence}
        >
          ⌀ {read.gaps.length} ›
        </button>
      )}
      <ReadState read={read} />
      <button
        type="button"
        className="today-read-again"
        aria-label="Read again"
        title="Read again"
        disabled={sweeping}
        onClick={onReadAgain}
      >
        <Icon name="refresh" size={14} />
      </button>
    </span>
  );
}

/** Today top to bottom: the title row with the date and the read, then its body. */
export function TodayFrame({
  read,
  sweeping,
  onReadAgain,
  onOpenEvidence,
  children,
}: {
  read: TodayRead;
  sweeping: boolean;
  onReadAgain: () => void;
  onOpenEvidence: () => void;
  children: ReactNode;
}) {
  const end = (
    <ReadEnd
      read={read}
      sweeping={sweeping}
      onReadAgain={onReadAgain}
      onOpenEvidence={onOpenEvidence}
    />
  );
  const title = (
    <PaneTitle end={end}>
      <h1 data-place>Today</h1>
      {read.sweptAt ? (
        <time className="today-date" dateTime={read.sweptAt}>
          {dayLine(read.sweptAt)}
        </time>
      ) : (
        <span className="today-date">{dayLine(Date.now())}</span>
      )}
    </PaneTitle>
  );
  if (!read.sweptAt)
    return (
      <>
        {title}
        {children}
      </>
    );
  return (
    <section className="place" aria-label="Today">
      {title}
      <section className="place-reading today-frame" aria-label="Today reading">
        {children}
      </section>
    </section>
  );
}
