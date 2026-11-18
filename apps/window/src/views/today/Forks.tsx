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
import { openEvidence, setOpenSelection, useOpenSelection } from "../../app/navigation.js";
import { STATION_MARKS } from "../../components/flow/Flow.js";
import { LinkPill } from "../../components/kit/LinkPill.js";
import { ServiceMark, serviceMark } from "../../components/sidebar/service-mark.js";
import { plainTitle } from "../../text.js";
import { forksWord, STATION_LABELS } from "./fleet.js";
import { ageInOneUnit, ForkName } from "./parts.js";
import "./forks.css";

const DOORS = {
  template: "Template",
  release: "Release",
  other: "Other",
  dependabot: "Deps",
} as const;
const COLUMNS = { ...STATION_LABELS, ...DOORS } as const;
type Column = keyof typeof COLUMNS;
type Door = keyof typeof DOORS;

const NOT_READ = "Not read. Showing what the last read held.";

function stationReading(station: ServiceHomeStation | undefined, notRead: boolean) {
  const word = station?.word.trim();
  const missingWord = !word || /^not read$/i.test(word);
  const unread = notRead || station?.notRead || station?.state === "unread" || missingWord;
  const calm = word === "None open" || word === "Sync current" || station?.state === "green";
  return {
    unread,
    state: station?.state ?? "unread",
    word: missingWord || (unread && calm) ? station?.pr && `PR #${station.pr.number}` : word,
  };
}

function StationCell({
  reading,
  unread,
}: {
  reading: ReturnType<typeof stationReading>;
  unread: boolean;
}) {
  const { state, word } = reading;
  if (!word || (unread && word === "None open")) return null;
  const { glyph, say } = STATION_MARKS[state];
  return (
    <span className="forks-reading" data-state={state}>
      {state !== "unread" && !(unread && state === "ready") && (
        <>
          <span className="forks-glyph" aria-hidden="true">
            {glyph}
          </span>
          <span className="visually-hidden">{say}: </span>
        </>
      )}
      <span>{word}</span>
    </span>
  );
}

function doorReading(column: Door, home: ServiceHome | undefined) {
  const door = home?.doors.find(({ id }) => id === column);
  const pr = door?.prs[0];
  const count = door?.count ?? door?.prs.length ?? 0;
  const value =
    column === "template"
      ? pr && `PR #${pr.number}`
      : column === "release"
        ? ageInOneUnit(home?.releasePr?.age) || undefined
        : count || undefined;
  const state =
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
  return {
    value,
    state,
    description,
    unread:
      door?.count == null ||
      (value === undefined &&
        (count > 0 || (column === "release" && home?.releasePr !== undefined))),
  };
}

export function readFork(fleet: TodayFleet, fork: string, home: ServiceHome | undefined) {
  const stations = new Map(
    (Object.keys(STATION_LABELS) as ServiceHomeStation["id"][]).map((id) => [
      id,
      stationReading(
        home?.stations.find((station) => station.id === id),
        fleet.stations.some((figure) => figure.id === id && figure.notRead.includes(fork)),
      ),
    ]),
  );
  const doors = new Map((Object.keys(DOORS) as Door[]).map((id) => [id, doorReading(id, home)]));
  const unread =
    !home ||
    home.mark.kind === "unread" ||
    [...stations.values(), ...doors.values()].some((reading) => reading.unread);
  return { stations, doors, unread };
}

function DoorCell({
  reading,
  unread,
}: {
  reading: ReturnType<typeof doorReading>;
  unread: boolean;
}) {
  const { value, state, description } = reading;
  if (value === undefined && unread) return null;
  return (
    <span className="forks-reading" data-state={state} title={description}>
      {value ?? "·"}
      {state === "stopped" && (
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
      {unread && (
        <p className="today-not-read">
          Not read on {fork}.{" "}
          <button type="button" onClick={() => openEvidence(null)}>
            Evidence ›
          </button>
        </p>
      )}
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
                {entry.count > 1 && <span>{entry.count}</span>}
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
  const services = new Set([...yours, ...rest.forks]);
  const readings = new Map(
    [...services].map((fork) => [fork, readFork(fleet, fork, homes.get(fork))]),
  );
  const quiet = rest.forks.filter((fork) => !readings.get(fork)?.unread);
  const total = [...services].map((fork) => homes.get(fork)?.openPrTotal);
  const knownTotal = total.reduce<number>((n, count) => n + (count ?? 0), 0);
  const partial = total.some((count) => count === undefined);
  const open = selection?.kind === "fork" ? selection.id : undefined;
  const showQuiet = unfolded || (open !== undefined && quiet.includes(open));
  const props = (column: Column) => ({
    "data-column": column,
    "data-dim": station !== undefined && station !== column ? "" : undefined,
  });
  const row = (fork: string) => {
    const reading = readings.get(fork);
    if (!reading) return null;
    const { stations, doors, unread } = reading;
    const expanded = fork === open;
    const mark = serviceMark(snapshot, fork);
    const detailId = `${id}-${fork}`;
    return (
      <Fragment key={fork}>
        <tr data-fork={fork} data-open={expanded || undefined}>
          <td className="forks-toggle-cell">
            <button
              type="button"
              className="forks-toggle"
              aria-label={`${fork}: show its rows`}
              aria-expanded={expanded}
              aria-controls={expanded ? detailId : undefined}
              onClick={() => setOpenSelection(expanded ? null : { kind: "fork", id: fork })}
            >
              <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
            </button>
          </td>
          <th className="forks-name-cell" scope="row">
            <ForkName fork={fork} services={services} />
          </th>
          <td className="forks-mark-cell">
            <div className="forks-marks">
              {mark?.kind === "unread" || (unread && !mark) ? (
                <ServiceMark mark={{ kind: "unread", label: NOT_READ }} />
              ) : (
                <>
                  <ServiceMark mark={mark} />
                  {unread && (
                    <span role="img" aria-label={NOT_READ} title={NOT_READ}>
                      ⌀
                    </span>
                  )}
                </>
              )}
            </div>
          </td>
          {Object.keys(COLUMNS).map((key) => {
            const column = key as Column;
            const door = doors.get(column as Door);
            const station = stations.get(column as ServiceHomeStation["id"]);
            return (
              <td key={column} {...props(column)}>
                {door && <DoorCell reading={door} unread={unread} />}
                {station && <StationCell reading={station} unread={unread} />}
              </td>
            );
          })}
        </tr>
        {expanded && (
          <tr className="forks-open" data-open-fork={fork}>
            <td colSpan={11} id={detailId}>
              <div className="forks-open-body">
                <OpenFork snapshot={snapshot} fork={fork} unread={unread} />
              </div>
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
          {partial && !knownTotal ? "⌀ not read" : `${knownTotal} open pull requests`}
        </span>
      </h2>
      <div className="today-section-box forks-scroll">
        <table>
          <thead>
            <tr>
              <th className="forks-toggle-cell" scope="col" aria-label="Fork details" />
              <th className="forks-name-cell" scope="col">
                Fork
              </th>
              <th className="forks-mark-cell" scope="col" aria-label="Service mark" />
              {Object.entries(COLUMNS).map(([column, label]) => (
                <th key={column} scope="col" {...props(column as Column)}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody data-fork-group="yours">{yours.map(row)}</tbody>
          <tbody data-fork-group="unread">
            {rest.forks.filter((fork) => readings.get(fork)?.unread).map(row)}
          </tbody>
          {showQuiet && <tbody data-fork-group="quiet">{quiet.map(row)}</tbody>}
          {quiet.length > 0 && (
            <tbody>
              <tr>
                <td colSpan={11}>
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
