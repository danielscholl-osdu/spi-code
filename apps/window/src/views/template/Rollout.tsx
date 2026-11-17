// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { FocusItem, ViewSnapshot } from "@spi-code/contracts";
import "./rollout.css";

export type RolloutStage = "verified" | "pending" | "todo" | "failed" | "unread";

const STAGES: Readonly<Record<RolloutStage, { glyph: string; word: string }>> = {
  verified: { glyph: "✓", word: "verified" },
  pending: { glyph: "◷", word: "merged · verification pending" },
  todo: { glyph: "·", word: "to dispatch" },
  failed: { glyph: "✕", word: "failed" },
  unread: { glyph: "⌀", word: "not read" },
};

export type Rung = { service: string; stage: RolloutStage; member: boolean };

export type RolloutLadder = {
  target: string;
  commit?: string | undefined;
  rungs: Rung[];
  member?: FocusItem | undefined;
};

/** Merged is Sync Template's own merge result; an occupied fork whose result was not read stays not read. */
export function rolloutLadder({ briefing }: ViewSnapshot): RolloutLadder | undefined {
  const visual = briefing.places?.find(({ place }) => place === "engineering")?.visual;
  if (visual?.kind !== "rollout") return undefined;
  const merged = new Set(
    (briefing.since?.rows.find(({ workflow }) => workflow === "template")?.slots ?? [])
      .filter(({ state }) => state === "done")
      .map(({ service }) => service),
  );
  const item = [...briefing.focus, ...briefing.rest].find(({ id }) => id === "rollout");
  const member = item?.actor === "operator" ? item : undefined;
  const rungs = visual.slots.map(({ service, state }): Rung => {
    const stage: RolloutStage =
      state === "done"
        ? "verified"
        : state === "occupied" && merged.has(service)
          ? "pending"
          : state === "empty"
            ? "todo"
            : state === "broken"
              ? "failed"
              : "unread";
    return { service, stage, member: stage === "todo" && member !== undefined };
  });
  const commit = item?.evidence.find(
    ({ kind, url }) => kind === "commit" && url.endsWith(`/commit/${visual.target}`),
  )?.url;
  return { target: visual.target, commit, rungs, member };
}

export function Rollout({
  ladder,
  selected,
  onSelect,
}: {
  ladder: RolloutLadder;
  selected?: boolean;
  onSelect: () => void;
}) {
  const short = ladder.target.slice(0, 7);
  const count = (stage: RolloutStage) => ladder.rungs.filter((rung) => rung.stage === stage).length;
  const dotted = ladder.rungs.filter(({ member }) => member).length;
  return (
    <section className="rollout" aria-label="Rollout">
      <h2 className="rollout-title">
        Rollout of osdu-spi{" "}
        {ladder.commit ? (
          <button
            type="button"
            className="rollout-commit"
            onClick={() => ladder.commit && void window.spi.openExternal(ladder.commit)}
          >
            commit {short} ↗
          </button>
        ) : (
          <span className="rollout-commit">commit {short}</span>
        )}
      </h2>
      <ul className="rollout-ladder">
        {ladder.rungs.map(({ service, stage, member }) => {
          const { glyph, word } = STAGES[stage];
          const label = `${service}: ${word}${member ? ", on Today" : ""}`;
          const body = (
            <>
              <b>{service}</b>
              <span aria-hidden="true">{glyph}</span>
              <span className="rollout-word">{word.split(" · ")[0]}</span>
            </>
          );
          return (
            <li
              key={service}
              className="rollout-rung"
              data-stage={stage}
              data-member={member || undefined}
            >
              {member ? (
                <button
                  type="button"
                  aria-label={label}
                  aria-pressed={selected ?? false}
                  data-selected={selected || undefined}
                  onClick={onSelect}
                >
                  {body}
                </button>
              ) : (
                <div role="img" aria-label={label}>
                  {body}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <ul className="rollout-key" aria-label="Stages">
        {(Object.keys(STAGES) as RolloutStage[]).map((stage) => (
          <li key={stage} data-stage={stage}>
            {count(stage)} {STAGES[stage].word}
          </li>
        ))}
      </ul>
      {dotted > 0 && (
        <p className="rollout-member">
          on Today: the {dotted} {dotted === 1 ? "fork" : "forks"} the template hasn't reached
        </p>
      )}
    </section>
  );
}
