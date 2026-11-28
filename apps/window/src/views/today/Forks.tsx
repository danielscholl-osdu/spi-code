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
import {
  navigate,
  openEvidence,
  setOpenSelection,
  useOpenSelection,
} from "../../app/navigation.js";
import { STATION_MARKS } from "../../components/flow/Flow.js";
import { LinkPill } from "../../components/kit/LinkPill.js";
import { plainTitle } from "../../text.js";
import { PendingRequests } from "../../threads/PendingRequests.js";
import { RequestOwner } from "../../threads/RequestOwner.js";
import { forksWord, STATION_LABELS } from "./fleet.js";
import { ageInOneUnit, ForkName } from "./parts.js";
import "./forks.css";

const DOORS = {
  template: "Template",
  release: "Release",
  dependabot: "Dependabot",
  other: "Other PRs",
} as const;
const COLUMNS = { ...STATION_LABELS, ...DOORS } as const;
type Column = keyof typeof COLUMNS;
type Door = keyof typeof DOORS;

const NOT_READ = "Not read. Showing what the last read held.";

function stationReading(station: ServiceHomeStation | undefined, notRead: boolean) {
  const word = station?.word.trim();
  const missingWord = !word || /^not read$/i.test(word);
  const unread = notRead || station?.notRead || station?.state === "unread" || missingWord;
  return {
    unread,
    state: unread ? ("unread" as const) : (station?.state ?? "unread"),
    word: unread ? station?.pr && `PR #${station.pr.number}` : word,
  };
}

function StationCell({ reading }: { reading: ReturnType<typeof stationReading> }) {
  const { state, word } = reading;
  if (!word) return null;
  const { glyph, say } = STATION_MARKS[state];
  return (
    <span className="forks-reading" data-state={state}>
      {state !== "unread" && (
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
      ? `Release PR #${pr.number} open ${value} · opens Releases`
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
    fleet.doors.some((figure) => figure.notRead.includes(fork)) ||
    [...stations.values(), ...doors.values()].some((reading) => reading.unread);
  return { stations, doors, unread };
}

const QUIET = new Set<ServiceHomeStation["state"]>(["green", "ready"]);

/** Work or a state that is not quiet anywhere but the Release door. */
function holdsWork(home: ServiceHome) {
  return (
    home.mark.kind === "count" ||
    home.stations.some(({ state, pr }) => !QUIET.has(state) || pr !== undefined) ||
    home.doors.some(
      ({ id, count, prs }) => id !== "release" && ((count ?? 0) > 0 || prs.length > 0),
    )
  );
}

const AGE_UNIT_SECONDS: Record<string, number> = { d: 86400, h: 3600, m: 60, s: 1 };

/** Core's ages ("40s", "25m", "21h", "4d", "4d 12h") in seconds; anything else is unknown. */
function ageInSeconds(age: string | undefined) {
  if (!age || !/^(?:\d+d(?: \d+h)?|\d+[hms])$/.test(age)) return undefined;
  let seconds = 0;
  for (const [, count, unit] of age.matchAll(/(\d+)([dhms])/g))
    seconds += Number(count) * (AGE_UNIT_SECONDS[unit ?? ""] ?? 0);
  return seconds;
}

/**
 * Which forks the sheet shows and which it folds. Only a fork proven to hold nothing, or nothing
 * but release PRs, folds; one not read, or with no home, stays shown.
 */
export function sortForks(
  snapshot: Pick<ViewSnapshot, "briefing" | "services">,
  fleet: TodayFleet,
) {
  const { yours, rest } = fleet.forks;
  const homes = new Map(snapshot.services?.map(({ service, home }) => [service, home]));
  const members = new Set(todayMembers(snapshot.briefing).map(({ member }) => member.fork));
  const readings = new Map(
    [...yours, ...rest.forks].map((fork) => [fork, readFork(fleet, fork, homes.get(fork))]),
  );
  const holding: string[] = [];
  const unread: string[] = [];
  const folded: string[] = [];
  const releaseOnly: { fork: string; age: string | undefined }[] = [];
  for (const fork of rest.forks) {
    const home = homes.get(fork);
    if (!home || readings.get(fork)?.unread) unread.push(fork);
    else if (members.has(fork) || holdsWork(home)) holding.push(fork);
    else {
      folded.push(fork);
      const release = home.doors.find(({ id }) => id === "release");
      if (home.releasePr || (release?.count ?? 0) > 0)
        releaseOnly.push({ fork, age: home.releasePr?.age });
    }
  }
  return { homes, readings, yours, holding, unread, folded, releaseOnly };
}

function foldHeadline({ folded, releaseOnly }: ReturnType<typeof sortForks>) {
  if (!folded.length || releaseOnly.length !== folded.length) return undefined;
  const ages = releaseOnly.map(({ age }) => ageInSeconds(age));
  const known = ages.every((seconds) => seconds !== undefined);
  const oldest = known ? releaseOnly[ages.indexOf(Math.max(...(ages as number[])))] : undefined;
  return (
    <>
      <span className="forks-fold-name">
        {folded.length} release-only {folded.length === 1 ? "fork" : "forks"}
      </span>
      {oldest && ` · oldest ${ageInOneUnit(oldest.age)} on ${oldest.fork}`}
    </>
  );
}

function DoorCell({ column, reading }: { column: Door; reading: ReturnType<typeof doorReading> }) {
  const { value, state, description, unread } = reading;
  if (value === undefined && unread) return null;
  if (column === "release" && value !== undefined)
    return (
      <button
        type="button"
        className="forks-reading forks-go"
        title={description}
        onClick={() => navigate({ kind: "releases" })}
      >
        {value}
        <span className="forks-go-mark" aria-hidden="true">
          ›
        </span>
      </button>
    );
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
              {member.primary && (
                <>
                  <LinkPill link={member.primary} />
                  <RequestOwner url={member.primary.url} compact />
                </>
              )}
              {member.age && <span>{ageInOneUnit(member.age)}</span>}
            </li>
          ))}
        </ul>
      )}
      <PendingRequests sweep={snapshot} scope={fork} />
      {causes.length > 0 && (
        <div className="forks-can-wait">
          <strong>Can wait</strong>
          <ul className="forks-work">
            {causes.map(({ cause, entry }) => (
              <li key={cause.id}>
                <span>{plainTitle(cause.headline)}</span>
                {entry.count > 1 && <span>{entry.count}</span>}
                {cause.kind === "release"
                  ? entry.objects.map((object) => (
                      <Fragment key={object.id}>
                        <LinkPill link={{ label: object.label, url: object.url, kind: "pr" }} />
                        <RequestOwner url={object.url} compact />
                        {object.age && <span>open {ageInOneUnit(object.age)}</span>}
                      </Fragment>
                    ))
                  : (cause.kind === "dependabot" || cause.kind === "other") &&
                    entry.objects.map(({ id, url }) => <RequestOwner key={id} url={url} compact />)}
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
  return holds.length
    ? holds.map(({ id, word }, index) => (
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

  const sorted = sortForks(snapshot, fleet);
  const { homes, readings, yours, holding, unread: unreadForks, folded } = sorted;
  const { rest } = fleet.forks;
  const services = new Set([...yours, ...rest.forks]);
  const total = [...services].map((fork) => homes.get(fork)?.openPrTotal);
  const knownTotal = total.reduce<number>((n, count) => n + (count ?? 0), 0);
  const partial = total.some((count) => count === undefined);
  const open = selection?.kind === "fork" ? selection.id : undefined;
  const showFolded = unfolded || (open !== undefined && folded.includes(open));
  const headline = foldHeadline(sorted);
  const props = (column: Column) => ({
    "data-column": column,
    "data-dim": station !== undefined && station !== column ? "" : undefined,
  });
  const row = (fork: string) => {
    const reading = readings.get(fork);
    if (!reading) return null;
    const { stations, doors, unread } = reading;
    const expanded = fork === open;
    const detailId = `${id}-${fork}`;
    return (
      <Fragment key={fork}>
        <tr data-fork={fork} data-open={expanded || undefined}>
          <td className="forks-toggle-cell">
            <button
              type="button"
              className="forks-toggle"
              aria-label={`Expand ${fork} details`}
              aria-expanded={expanded}
              aria-controls={expanded ? detailId : undefined}
              onClick={() => setOpenSelection(expanded ? null : { kind: "fork", id: fork })}
            >
              <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
            </button>
          </td>
          <th className="forks-name-cell" scope="row">
            <span className="forks-name">
              <ForkName fork={fork} services={services} />
              {unread && (
                <span className="forks-unread" role="img" aria-label={NOT_READ} title={NOT_READ}>
                  ⌀
                </span>
              )}
            </span>
          </th>
          {Object.keys(COLUMNS).map((key) => {
            const column = key as Column;
            const door = doors.get(column as Door);
            const station = stations.get(column as ServiceHomeStation["id"]);
            return (
              <td key={column} {...props(column)}>
                {door && <DoorCell column={column as Door} reading={door} />}
                {station && <StationCell reading={station} />}
              </td>
            );
          })}
        </tr>
        {expanded && (
          <tr className="forks-open" data-open-fork={fork}>
            <td colSpan={10} id={detailId}>
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
              {Object.entries(COLUMNS).map(([column, label]) => (
                <th key={column} scope="col" {...props(column as Column)}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody data-fork-group="yours">{yours.map(row)}</tbody>
          <tbody data-fork-group="holding">{holding.map(row)}</tbody>
          <tbody data-fork-group="unread">{unreadForks.map(row)}</tbody>
          {showFolded && <tbody data-fork-group="quiet">{folded.map(row)}</tbody>}
          {folded.length > 0 && (
            <tbody>
              <tr>
                <td colSpan={10}>
                  <button
                    type="button"
                    className="forks-fold"
                    aria-expanded={showFolded}
                    title={folded.join(", ")}
                    onClick={() => {
                      if (showFolded && open && folded.includes(open)) setOpenSelection(null);
                      setUnfolded(!showFolded);
                    }}
                  >
                    <span aria-hidden="true">{showFolded ? "▾" : "▸"}</span>{" "}
                    {headline ?? (
                      <>
                        {forksWord(folded.length)} with nothing waiting on you ·{" "}
                        {foldWords(rest, folded, (fork, id) =>
                          homes.get(fork)?.doors.find((door) => door.id === id),
                        )}
                      </>
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
