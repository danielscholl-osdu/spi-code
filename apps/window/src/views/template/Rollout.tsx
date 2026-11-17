// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { FocusItem, Link, ViewSnapshot } from "@spi-code/contracts";
import { useCallback, useState } from "react";
import { setOpenSelection, useOpenSelection } from "../../app/navigation.js";
import { type OpenedContent, todayContent } from "../../components/opened-body/content.js";
import { placeMembers } from "../../components/place/members.js";
import { Popover } from "../../components/popover/Popover.js";
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

function rungContent(snapshot: ViewSnapshot, ladder: RolloutLadder, rung: Rung): OpenedContent {
  const { service, stage } = rung;
  const place = {
    label: `Template › Rollout › ${service}`,
    destination: { kind: "engineering-system" } as const,
    selection: { kind: "rung", id: service },
  };
  const items = [...snapshot.briefing.focus, ...snapshot.briefing.rest];
  const dispatch = placeMembers(snapshot, "engineering").find(
    ({ member }) => member.id === "rollout",
  );
  const change = items
    .find(({ id }) => id === "rollout")
    ?.evidence.find(({ kind, url }) => kind === "compare" && url.endsWith(ladder.target));
  const templateChange = change && { ...change, label: "Template change" };
  if (stage === "todo" && dispatch) {
    const content = todayContent({ ...dispatch, items, place });
    const forks = ladder.rungs
      .filter(({ stage }) => stage === "todo")
      .map(({ service }) => service);
    return {
      ...content,
      title: dispatch.line.headline,
      cause: `${content.cause ? `${content.cause} ` : ""}The template hasn't reached ${forks.length} forks: ${forks.join(", ")}.`,
      ...(templateChange ? { primary: templateChange, links: [templateChange] } : {}),
    };
  }
  const slot = snapshot.briefing.since?.rows
    .find(({ workflow }) => workflow === "template")
    ?.slots.find((slot) => slot.service === service);
  const run = snapshot.services
    ?.find((row) => row.service === service)
    ?.runs.filter(({ workflow }) => workflow === "Sync Template")
    .sort((a, b) => b.time.localeCompare(a.time))[0];
  const source: Link | undefined = run && { kind: "run", label: "Sync Template run", url: run.url };
  return {
    title: `${service}: template ${ladder.target.slice(0, 7)} ${STAGES[stage].word}`,
    place,
    subject: null,
    cause: `What SPI Code read: ${slot?.text ?? "No Sync Template result was read."}${stage === "pending" ? " Verification of the new template on main has not been read as green yet." : ""}`,
    ...(source ? { primary: source } : templateChange ? { primary: templateChange } : {}),
    links: [...(source ? [source] : []), ...(templateChange ? [templateChange] : [])],
  };
}

export function Rollout({ ladder, snapshot }: { ladder: RolloutLadder; snapshot: ViewSnapshot }) {
  const marked = useOpenSelection();
  const selected =
    marked?.kind === "rung"
      ? marked.id
      : marked?.kind === "item" && marked.id === "rollout"
        ? ladder.rungs.find(({ member }) => member)?.service
        : undefined;
  const rung = ladder.rungs.find(({ service }) => service === selected);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const close = useCallback(() => setOpenSelection(null), []);
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
              <button
                ref={selected === service ? setAnchor : undefined}
                type="button"
                data-rung={service}
                aria-label={label}
                aria-haspopup="dialog"
                aria-expanded={selected === service}
                data-member-marked={
                  (member && marked?.kind === "item" && marked.id === "rollout") || undefined
                }
                data-selected={selected === service || undefined}
                onClick={() =>
                  setOpenSelection(selected === service ? null : { kind: "rung", id: service })
                }
              >
                {body}
              </button>
            </li>
          );
        })}
      </ul>
      {rung && marked && anchor?.isConnected && anchor.dataset.rung === rung.service && (
        <Popover
          anchor={anchor}
          selection={marked}
          content={rungContent(snapshot, ladder, rung)}
          onClose={close}
        />
      )}
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
