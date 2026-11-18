// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  type ServiceHome,
  type ServiceHomeDoor,
  type ServiceHomeStation,
  type TodayFleet,
  type TodayMemberStation,
  todayMembers,
  type ViewSnapshot,
} from "@spi-code/contracts";
import { Fragment, useId, useState } from "react";
import { navigate, setOpenSelection, useOpenSelection } from "../../app/navigation.js";
import { STATION_MARKS } from "../../components/flow/Flow.js";
import { LinkPill } from "../../components/kit/LinkPill.js";
import { ServiceMark, serviceMark } from "../../components/sidebar/service-mark.js";
import { plainTitle } from "../../text.js";
import { NotRead } from "./CanWait.js";
import { forksWord, STATION_LABELS } from "./fleet.js";
import { ageInOneUnit } from "./parts.js";
import "./forks.css";

const DOORS = {
  template: "Template",
  release: "Release",
  other: "Other",
  dependabot: "Deps",
} as const;
const COLUMNS = { ...STATION_LABELS, ...DOORS } as const;
type Column = keyof typeof COLUMNS;

const UNKNOWN = { word: "not read", state: "unread" } as const;

function StationCell({
  station = UNKNOWN,
}: {
  station?: Pick<ServiceHomeStation, "state" | "word"> | undefined;
}) {
  const { glyph, say } = STATION_MARKS[station.state];
  return (
    <span className="forks-reading" data-state={station.state}>
      <span className="forks-glyph" aria-hidden="true">
        {glyph}
      </span>
      <span className="visually-hidden">{say}: </span>
      <span>{station.word}</span>
    </span>
  );
}

function DoorCell({ column, home }: { column: keyof typeof DOORS; home: ServiceHome | undefined }) {
  const door = home?.doors.find(({ id }) => id === column);
  const pr = door?.prs[0];
  const partial = door?.count == null;
  const count = door?.count ?? door?.prs.length ?? 0;
  const empty = partial ? "" : "·";
  const value =
    column === "template"
      ? pr
        ? `PR #${pr.number}`
        : count
          ? "⌀"
          : empty
      : column === "release"
        ? count
          ? (ageInOneUnit(home?.releasePr?.age) ?? "⌀")
          : empty
        : count || empty;
  const tone =
    column === "other" && door?.red
      ? "stopped"
      : column === "template" && pr
        ? "waiting-on-person"
        : undefined;
  const description =
    column === "release" && pr
      ? `Release PR #${pr.number}`
      : column === "other" && door?.red
        ? `${door.red} failed`
        : undefined;
  return (
    <span className="forks-reading" data-state={tone} title={description}>
      {value}
      {partial && value !== "⌀" && (
        <span role="img" aria-label="not read">
          ⌀
        </span>
      )}
      {tone === "stopped" && (
        <span role="img" aria-label="failed">
          ✕
        </span>
      )}
    </span>
  );
}

function OpenFork({
  snapshot,
  fork,
  unread,
}: {
  snapshot: ViewSnapshot;
  fork: string;
  unread: boolean;
}) {
  const yours = todayMembers(snapshot.briefing).filter(({ member }) => member.fork === fork);
  const causes =
    snapshot.briefing.today?.causes?.rows.flatMap((cause) =>
      cause.forks.filter((entry) => entry.fork === fork).map((entry) => ({ cause, entry })),
    ) ?? [];
  return (
    <>
      {!yours.length && !unread && <p>Nothing waiting on you.</p>}
      {unread && <NotRead forks={[fork]} />}
      {yours.length > 0 && (
        <ul className="forks-work" aria-label="Yours">
          {yours.map(({ line, member }) => (
            <li key={member.id} data-member={member.id}>
              <span
                className="forks-reading"
                data-state={line.section === "blocked" ? "stopped" : "waiting-on-person"}
              >
                <span className="visually-hidden">
                  {line.section === "blocked" ? "Blocked: " : "Waiting on you: "}
                </span>
                {plainTitle(line.headline)}
              </span>
              {member.primary && <LinkPill link={member.primary} />}
              {member.age && <span>{ageInOneUnit(member.age)}</span>}
            </li>
          ))}
        </ul>
      )}
      {causes.length > 0 && (
        <div className="forks-can-wait">
          <strong>Can wait</strong>
          <ul className="forks-work">
            {causes.map(({ cause, entry }) => (
              <li key={cause.id}>
                <span>{plainTitle(cause.headline)}</span>
                <span>{entry.count}</span>
                {cause.kind === "release" &&
                  entry.objects.map((object) => (
                    <Fragment key={object.id}>
                      <LinkPill link={{ label: object.label, url: object.url, kind: "pr" }} />
                      {object.age && <span>open {ageInOneUnit(object.age)}</span>}
                    </Fragment>
                  ))}
              </li>
            ))}
          </ul>
        </div>
      )}
      <button
        type="button"
        className="today-cause-fork"
        onClick={() => navigate({ kind: "service", id: fork })}
      >
        Open {fork} ›
      </button>
    </>
  );
}

const HOLD_WORDS = {
  template: ["template sync PR", "template sync PRs"],
  release: ["release PR", "release PRs"],
  other: ["other PR", "other PRs"],
  dependabot: ["Dependabot PR", "Dependabot PRs"],
} as const;

function foldWords(
  rest: TodayFleet["forks"]["rest"],
  forks: readonly string[],
  doorOf: (fork: string, id: ServiceHomeDoor["id"]) => ServiceHomeDoor | undefined,
) {
  const known = new Set(forks);
  const holds = rest.doors.flatMap(({ id, count, forks: holding }) => {
    const total =
      known.size === rest.forks.length
        ? count
        : holding.reduce((sum, fork) => {
            if (!known.has(fork)) return sum;
            const door = doorOf(fork, id);
            return sum + (door?.count ?? door?.prs.length ?? 0);
          }, 0);
    return total ? [{ id, word: `${total} ${HOLD_WORDS[id][total === 1 ? 0 : 1]}` }] : [];
  });
  const openStations = rest.stations
    .filter(({ id }) => id === "sync" || id === "integration")
    .flatMap(({ id, forks }) => {
      const count = forks.filter((fork) => known.has(fork)).length;
      return count
        ? [
            {
              id,
              word: `${count} ${id === "sync" ? "sync" : "integration"} ${count === 1 ? "PR" : "PRs"}`,
            },
          ]
        : [];
    });
  const missing = rest.doors.some(({ notRead }) => notRead.some((fork) => known.has(fork)));
  const work: { id: string; word: string }[] = [...openStations, ...holds];
  if (missing) work.push({ id: "unread", word: "⌀ some PRs not read" });
  return work.length
    ? work.map(({ id, word }, index) => (
        <Fragment key={id}>
          {index > 0 && " · "}
          <span data-hold={id}>{word}</span>
        </Fragment>
      ))
    : "no open PRs";
}

export function Forks({
  snapshot,
  fleet,
  station,
}: {
  snapshot: ViewSnapshot;
  fleet: TodayFleet | undefined;
  station: TodayMemberStation | undefined;
}) {
  const id = useId();
  const [unfolded, setUnfolded] = useState(false);
  const selection = useOpenSelection();
  if (!fleet) return <p className="today-not-read">⌀ The forks were not read.</p>;

  const { yours, rest } = fleet.forks;
  const homes = new Map(snapshot.services?.map(({ service, home }) => [service, home]));
  const unread = new Set(fleet.stations.flatMap(({ notRead }) => notRead));
  const quiet = rest.forks.filter((fork) => !unread.has(fork));
  const total = [...yours, ...rest.forks].map((fork) => homes.get(fork)?.openPrTotal);
  const knownTotal = total.reduce<number>((n, count) => n + (count ?? 0), 0);
  const partial = total.some((count) => count === undefined);
  const open = selection?.kind === "fork" ? selection.id : undefined;
  const showQuiet = unfolded || (open !== undefined && quiet.includes(open));
  const props = (column: Column) => ({
    "data-column": column,
    "data-dim": station !== undefined && station !== column ? "" : undefined,
  });
  const row = (fork: string) => {
    const home = homes.get(fork);
    const expanded = fork === open;
    return (
      <Fragment key={fork}>
        <tr data-fork={fork}>
          <th scope="row">
            <button
              type="button"
              className="today-fork-name"
              aria-expanded={expanded}
              onClick={() => setOpenSelection(expanded ? null : { kind: "fork", id: fork })}
            >
              {fork}
            </button>
          </th>
          {Object.entries(COLUMNS).map(([key]) => {
            const column = key as Column;
            return (
              <td key={column} {...props(column)}>
                {column in DOORS ? (
                  <DoorCell column={column as keyof typeof DOORS} home={home} />
                ) : (
                  <StationCell station={home?.stations.find(({ id }) => id === column)} />
                )}
              </td>
            );
          })}
          <td>
            <ServiceMark mark={serviceMark(snapshot, fork)} />
          </td>
        </tr>
        {expanded && (
          <tr className="forks-open" data-open-fork={fork}>
            <td colSpan={10}>
              <OpenFork
                snapshot={snapshot}
                fork={fork}
                unread={unread.has(fork) || home?.mark.kind === "unread"}
              />
            </td>
          </tr>
        )}
      </Fragment>
    );
  };
  return (
    <section className="today-section" data-section="forks" aria-labelledby={id}>
      <h2 className="today-section-head" id={id}>
        {forksWord(total.length)}
        <span className="today-section-count">
          {partial && !knownTotal
            ? "⌀ Open pull requests not read"
            : `${knownTotal} open pull requests${partial ? " ⌀" : ""}`}
        </span>
      </h2>
      <div className="today-section-box forks-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Fork</th>
              {Object.entries(COLUMNS).map(([column, label]) => (
                <th key={column} scope="col" {...props(column as Column)}>
                  {label}
                </th>
              ))}
              <th scope="col" aria-label="Service mark" />
            </tr>
          </thead>
          <tbody data-fork-group="yours">{yours.map(row)}</tbody>
          <tbody data-fork-group="unread">
            {rest.forks.filter((fork) => unread.has(fork)).map(row)}
          </tbody>
          {showQuiet && <tbody data-fork-group="quiet">{quiet.map(row)}</tbody>}
          {quiet.length > 0 && (
            <tbody>
              <tr>
                <td colSpan={10}>
                  <button
                    type="button"
                    className="forks-fold"
                    aria-expanded={showQuiet}
                    title={quiet.join(", ")}
                    onClick={() => {
                      if (showQuiet && open && quiet.includes(open)) setOpenSelection(null);
                      setUnfolded(!showQuiet);
                    }}
                  >
                    <span aria-hidden="true">{showQuiet ? "▾" : "▸"}</span>{" "}
                    {forksWord(quiet.length)} with nothing waiting on you ·{" "}
                    {foldWords(rest, quiet, (fork, id) =>
                      homes.get(fork)?.doors.find((door) => door.id === id),
                    )}
                  </button>
                </td>
              </tr>
            </tbody>
          )}
        </table>
      </div>
    </section>
  );
}
