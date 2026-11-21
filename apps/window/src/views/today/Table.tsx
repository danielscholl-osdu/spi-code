// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  type Briefing,
  type CanWaitCauses,
  type FocusItem,
  fleetLines,
  type Link,
  type TodayDeadline,
  type TodayLine,
  type TodayMember,
  type TodayMemberStation,
  type ViewSnapshot,
} from "@spi-code/contracts";
import { Fragment, type MouseEvent, useCallback, useEffect, useRef } from "react";
import {
  type EvidenceSelection,
  navigate,
  openEvidence,
  routeHash,
  setOpenSelection,
  useOpenSelection,
} from "../../app/navigation.js";
import { Octicon } from "../../components/icons/Octicon.js";
import { LinkPill } from "../../components/kit/LinkPill.js";
import { type BodyPlace, todayContent } from "../../components/opened-body/content.js";
import { OpenedBody } from "../../components/opened-body/OpenedBody.js";
import { plainTitle } from "../../text.js";
import { PendingRequests } from "../../threads/PendingRequests.js";
import { RequestOwner } from "../../threads/RequestOwner.js";
import { timedText } from "../../time.js";
import { CanWait } from "./CanWait.js";
import { forksWord } from "./fleet.js";
import { ageInOneUnit, ForkName, Section } from "./parts.js";
import "./table.css";

const SECTIONS = [
  { id: "blocked", label: "Blocked" },
  { id: "waiting", label: "Waiting on you" },
] as const;

export { ageInOneUnit };

const TODAY: BodyPlace = { label: "Today", destination: { kind: "today" } };

const distinct = (gaps: readonly string[]) => [...new Set(gaps)];

type Row = {
  key: string;
  selection: EvidenceSelection;
  fork: string;
  headline?: { text: string; pointer: string };
  pill?: Link | undefined;
  age?: string | undefined;
  deadline?: TodayDeadline | undefined;
  gaps: number;
  sub: boolean;
  pointer: string;
  line: TodayLine;
  member?: TodayMember;
};

/** A filtered line keeps the pointers of the line and members it was cut from. */
function rowsOf(line: TodayLine, index: number, whole: TodayLine = line): Row[] {
  const pointer = `/briefing/lines/${index}`;
  const [one, ...others] = line.members;
  const single = one && others.length === 0 && !line.rollout ? one : undefined;
  const lineGaps = distinct(line.members.flatMap((m) => m.evidence.notRead));
  const kept = distinct(line.members.map((m) => m.fork));
  const head: Row = {
    key: line.id,
    selection: single ? { kind: "item", id: single.id } : { kind: "line", id: line.id },
    fork:
      line.members.length === whole.members.length
        ? line.subject
        : kept.length === 1
          ? (kept[0] ?? line.subject)
          : forksWord(kept.length),
    headline: { text: plainTitle(line.headline), pointer: `${pointer}/headline` },
    pill: single?.primary,
    age: ageInOneUnit(line.age),
    deadline: line.deadline,
    gaps: lineGaps.length,
    sub: false,
    pointer,
    line,
    ...(single ? { member: single } : {}),
  };
  if (single) return [head];
  return [
    head,
    ...line.members.map((member) => ({
      key: `${line.id}/${member.id}`,
      selection: { kind: "item", id: member.id } as const,
      fork: member.fork,
      pill: member.primary,
      age: ageInOneUnit(member.age),
      gaps: distinct(member.evidence.notRead).filter((gap) => !lineGaps.includes(gap)).length,
      sub: true,
      pointer: `${pointer}/members/${whole.members.indexOf(member)}`,
      line,
      member,
    })),
  ];
}

const isRow = (row: Row, open: { kind: string; id: string } | null) =>
  !!open && row.selection.kind === open.kind && row.selection.id === open.id;

/**
 * The row an item opens on Today: its member's own row, or its group's row when it is part of
 * several members of one line; null when it is on no row or on rows of different lines.
 */
export function todayRowOf(lines: readonly TodayLine[], item: string): EvidenceSelection | null {
  const rows = lines.flatMap((line, index) => rowsOf(line, index));
  const holders = rows.filter(
    (row) =>
      row.member?.id === item ||
      row.member?.ids.includes(item) ||
      (!row.sub && (row.line.id === item || (row.line.rollout && item === "rollout"))),
  );
  const [first] = holders;
  if (!first) return null;
  if (holders.some((row) => row.line !== first.line)) return null;
  const own = holders.find((row) => row.member?.id === item);
  if (own) return own.selection;
  if (holders.length === 1) return first.selection;
  return rows.find((row) => row.line === first.line && !row.sub)?.selection ?? null;
}

/** Goes to Today with an item's row open in place, or with nothing open when it has no row. */
export function openTodayRow(lines: readonly TodayLine[] | undefined, item: string) {
  navigate({ kind: "today" });
  setOpenSelection(todayRowOf(lines ?? [], item));
}

/** Goes to Today with a line's own row open: its one member's row or its group's; nothing when it has gone. */
export function openTodayLine(lines: readonly TodayLine[] | undefined, id: string) {
  const index = lines?.findIndex((line) => line.id === id) ?? -1;
  const line = lines?.[index];
  navigate({ kind: "today" });
  setOpenSelection(line ? (rowsOf(line, index)[0]?.selection ?? null) : null);
}

function RowCells({
  row,
  origin,
  open,
  services,
  onToggle,
}: {
  row: Row;
  origin: string | undefined;
  open: boolean;
  services: ReadonlySet<string>;
  onToggle(row: Row, event: MouseEvent): void;
}) {
  const toggle = (event: MouseEvent) => onToggle(row, event);
  const reason = row.deadline && plainTitle(timedText(row.deadline.reason, { hint: false }));
  return (
    <tr
      className={row.sub ? "today-row today-row--sub" : "today-row"}
      data-pointer={row.pointer}
      data-line-id={row.line.id}
      {...(row.member ? { "data-item-id": row.member.id } : {})}
      {...(row.member?.station ? { "data-station": row.member.station } : {})}
      {...(origin ? { "data-origin": origin } : {})}
      {...(open ? { "data-open": "" } : {})}
    >
      <td className="today-row-fork">
        <ForkName fork={row.fork} services={services} />
      </td>
      <td className="today-row-what">
        {row.headline ? (
          <button
            type="button"
            aria-expanded={open}
            data-pointer={row.headline.pointer}
            onClick={toggle}
          >
            {row.headline.text}
          </button>
        ) : (
          <button
            type="button"
            className="today-row-expand"
            aria-expanded={open}
            aria-label={`${row.fork}: ${plainTitle(row.line.headline)}`}
            onClick={toggle}
          >
            Details {open ? "⌃" : "⌄"}
          </button>
        )}
        {row.member?.ids.some((id) => id.startsWith("port:")) && (
          <span className="service-tag today-row-tag">Counted on Upstream</span>
        )}
      </td>
      <td className="today-row-open">
        {row.pill && (
          <>
            <LinkPill link={row.pill} />
            <RequestOwner url={row.pill.url} compact />
          </>
        )}
      </td>
      <td className="today-row-age">
        {row.gaps > 0 && (
          <button
            type="button"
            className="today-row-gaps"
            aria-label={`${row.gaps} not read: open Evidence`}
            onClick={(event) => {
              event.stopPropagation();
              openEvidence(row.selection);
            }}
          >
            ⌀ {row.gaps}
          </button>
        )}
        {reason && (
          <span
            className="today-row-clock"
            role="img"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: the reason shows on focus as on hover
            tabIndex={0}
            aria-label={reason}
            data-tip={reason}
          >
            <Octicon name="clock" />
          </span>
        )}
        {row.age && <span className="today-row-age-text">{row.age}</span>}
      </td>
    </tr>
  );
}

/** The Can wait causes Yours draws: none under a station filter, nor beside a briefing with no lines. */
export function drawnCauses(
  briefing: Pick<Briefing, "lines" | "today">,
  station?: TodayMemberStation,
): CanWaitCauses | undefined {
  return briefing.lines && !station ? briefing.today?.causes : undefined;
}

/**
 * Yours: Blocked and Waiting on you as core's situation lines whose rows open in place, one at a
 * time, then Can wait by cause. A station keeps only its rows and members, and hides Can wait.
 */
export function TodayTable({
  snapshot,
  station,
  calm = "Nothing is yours to move today.",
}: {
  snapshot: ViewSnapshot;
  station?: TodayMemberStation | undefined;
  /** What an empty Yours says; null says nothing. */
  calm?: string | null;
}) {
  const { briefing } = snapshot;
  const lines = briefing.lines;
  const open = useOpenSelection();
  const table = useRef<HTMLDivElement>(null);
  const openers = useRef(new Map<string, HTMLButtonElement | null>());
  const close = useCallback(() => setOpenSelection(null), []);
  const shown = lines && station ? fleetLines(lines, station) : (lines ?? []);
  const rows = shown.flatMap((line) => {
    const index = lines?.findIndex(({ id }) => id === line.id) ?? -1;
    return rowsOf(line, index, lines?.[index]);
  });
  const openRow = rows.find((row) => isRow(row, open));
  const anyOpen = !!open;

  useEffect(() => {
    if (!anyOpen) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Element | null;
      const today = table.current?.closest(".today");
      if (!target || !today?.contains(target) || target.closest("[data-open]")) return;
      setOpenSelection(null);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [anyOpen]);

  const openKey = openRow?.key;
  useEffect(() => {
    if (openKey) {
      const row = table.current?.querySelector(`tr[data-open]`);
      row?.scrollIntoView?.({ block: "nearest" });
    }
  }, [openKey]);

  if (!lines) return null;

  const causes = drawnCauses(briefing, station);

  const services = new Set(snapshot.stations.map(({ service }) => service));
  const items: FocusItem[] = [...briefing.focus, ...briefing.rest];
  const originOf = (row: Row) => {
    if (!row.member && row.line.rollout) return items.find(({ id }) => id === "rollout")?.origin;
    const ids = new Set(row.member ? [row.member.id, ...row.member.ids] : []);
    const origins = new Set(
      items.flatMap(({ id, origin }) => (ids.has(id) && origin ? [origin] : [])),
    );
    return origins.size ? [...origins].sort().join(" ") : undefined;
  };
  const toggle = (row: Row, event: MouseEvent) => {
    if (event.detail === 0 && (event.metaKey || event.ctrlKey)) return;
    openers.current.set(row.key, event.currentTarget as HTMLButtonElement);
    setOpenSelection(isRow(row, open) ? null : row.selection);
  };
  const body = (row: Row) => {
    const rollout = row.member ? undefined : row.line.rollout;
    const content = todayContent({
      line: row.line,
      ...(row.member ? { member: row.member } : {}),
      items,
      place: TODAY,
    });
    if (!row.member) delete content.primary;
    return (
      <tr className="today-row-body" data-open="">
        <td />
        <td colSpan={3}>
          <OpenedBody
            content={content}
            selection={row.selection}
            origin="today"
            {...(row.pill ? { rowUrl: row.pill.url } : {})}
            onClose={() => {
              close();
              openers.current.get(row.key)?.focus();
            }}
          />
          {rollout && (
            <div className="today-rollout-detail">
              {rollout.withoutPr.length > 0 && (
                <p>
                  No open template sync PR on <span>{rollout.withoutPr.join(", ")}</span>.
                </p>
              )}
              <nav aria-label="Rollout">
                <a href={routeHash({ kind: "engineering-system" })}>Template ›</a>
                <a
                  href={routeHash({ kind: "evidence", selection: row.selection })}
                  onClick={(event) => {
                    event.preventDefault();
                    openEvidence(row.selection);
                  }}
                >
                  Evidence ›
                </a>
              </nav>
            </div>
          )}
        </td>
      </tr>
    );
  };

  return (
    <div ref={table} className="today-table">
      {shown.length === 0 && calm && <p className="today-table-calm">{calm}</p>}
      {SECTIONS.map(({ id, label }) => {
        const held = shown.filter((line) => line.section === id);
        if (held.length === 0) return null;
        const members = held.reduce((n, line) => n + line.members.length, 0);
        return (
          <Section key={id} id={id} label={label} count={members} head>
            {held.map((line) => (
              <tbody key={line.id} data-line={line.id}>
                {rows
                  .filter((row) => row.line === line)
                  .flatMap((row) => {
                    const opened = row === openRow;
                    return [
                      <RowCells
                        key={row.key}
                        row={row}
                        origin={originOf(row)}
                        open={opened}
                        services={services}
                        onToggle={toggle}
                      />,
                      ...(opened ? [<Fragment key={`${row.key}/body`}>{body(row)}</Fragment>] : []),
                    ];
                  })}
              </tbody>
            ))}
          </Section>
        );
      })}
      {!station && <PendingRequests sweep={snapshot} fork />}
      {causes && <CanWait causes={causes} snapshot={snapshot} services={services} />}
    </div>
  );
}
