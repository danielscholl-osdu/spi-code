// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type {
  FocusItem,
  Link,
  TodayDeadline,
  TodayLine,
  TodayMember,
  ViewSnapshot,
} from "@spi-code/contracts";
import {
  Fragment,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
} from "react";
import {
  type Destination,
  type EvidenceSelection,
  LINE,
  type LineColumn,
  navigate,
  openEvidence,
  setOpenSelection,
  useOpenSelection,
} from "../../app/navigation.js";
import { Octicon } from "../../components/icons/Octicon.js";
import { LinkPill } from "../../components/kit/LinkPill.js";
import { type BodyPlace, todayContent } from "../../components/opened-body/content.js";
import { OpenedBody } from "../../components/opened-body/OpenedBody.js";
import { plainTitle } from "../../text.js";
import { timedText } from "../../time.js";
import { columns, itemStation } from "../line/cells.js";
import { lowerSections } from "./Lower.js";
import "./table.css";

const SECTIONS = [
  { id: "blocked", label: "Blocked" },
  { id: "waiting", label: "Waiting on you" },
] as const;

const PLACES = {
  line: { label: "Line", destination: LINE },
  environment: { label: "Environment", destination: { kind: "environment" } },
  engineering: { label: "Engineering system", destination: { kind: "engineering-system" } },
  security: { label: "Security", destination: { kind: "security" } },
  upstream: { label: "Upstream", destination: { kind: "upstream" } },
} satisfies Record<string, BodyPlace>;

/** Ages in one unit: core's "6d 22h" reads 7d, and "1d 2h" reads 26h. */
export function ageInOneUnit(age: string | undefined): string | undefined {
  const parts = age?.match(/^(\d+)d (\d+)h$/);
  if (!parts) return age;
  const hours = Number(parts[1]) * 24 + Number(parts[2]);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

const distinct = (gaps: readonly string[]) => [...new Set(gaps)];

type MemberPlace = BodyPlace & { column?: string };

/** Where a member lives: its Line cell when its kind has a station on a fork's row, else its place. */
function memberPlace(
  member: TodayMember,
  forks: ReadonlySet<string>,
  places: ViewSnapshot["briefing"]["places"],
): MemberPlace {
  const station = itemStation(member.id);
  if (station && station !== "upstream" && forks.has(member.fork)) {
    const column = columns.find(({ id }) => id === station)?.label ?? station;
    const destination: Destination =
      station === "lane" || station === "release"
        ? LINE
        : { ...LINE, column: station as LineColumn };
    return {
      label: `Line › ${member.fork} › ${column}`,
      destination,
      selection: { kind: "cell", id: `${member.fork}:${station}` },
      column,
    };
  }
  if (member.id.startsWith("port:") || member.id.startsWith("radar:")) return PLACES.upstream;
  const ids = new Set([member.id, ...member.ids]);
  const row = places?.find(({ itemIds }) => itemIds.some((id) => ids.has(id)));
  return row && row.place in PLACES ? PLACES[row.place as keyof typeof PLACES] : PLACES.line;
}

/** A group's place: the column its members share, else the place they share, else the Line. */
function linePlace(
  line: TodayLine,
  forks: ReadonlySet<string>,
  places: ViewSnapshot["briefing"]["places"],
): BodyPlace {
  const each = line.members.map((member) => memberPlace(member, forks, places));
  const [first, ...rest] = each;
  if (!first) return PLACES.line;
  if (rest.length === 0) return first;
  if (first.column && rest.every(({ column }) => column === first.column))
    return { label: `Line › ${first.column}`, destination: first.destination };
  const top = (place: MemberPlace) => place.label.split(" › ")[0];
  return rest.every((place) => top(place) === top(first))
    ? { label: top(first) ?? "Line", destination: first.column ? LINE : first.destination }
    : PLACES.line;
}

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

function rowsOf(line: TodayLine, index: number): Row[] {
  const pointer = `/briefing/lines/${index}`;
  const [one, ...others] = line.members;
  const single = one && others.length === 0 ? one : undefined;
  const lineGaps = distinct(line.members.flatMap((m) => m.evidence.notRead));
  const head: Row = {
    key: line.id,
    selection: single ? { kind: "item", id: single.id } : { kind: "line", id: line.id },
    fork: line.subject,
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
    ...line.members.map((member, at) => ({
      key: `${line.id}/${member.id}`,
      selection: { kind: "item", id: member.id } as const,
      fork: member.fork,
      pill: member.primary,
      age: ageInOneUnit(member.age),
      gaps: distinct(member.evidence.notRead).filter((gap) => !lineGaps.includes(gap)).length,
      sub: true,
      pointer: `${pointer}/members/${at}`,
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
  const rows = lines.flatMap(rowsOf);
  const own = rows.find((row) => row.member?.id === item);
  if (own) return own.selection;
  const holders = rows.filter((row) => row.member?.ids.includes(item));
  const [first] = holders;
  if (!first) return null;
  if (holders.length === 1) return first.selection;
  if (holders.some((row) => row.line !== first.line)) return null;
  return rows.find((row) => row.line === first.line && !row.sub)?.selection ?? null;
}

/** Goes to Today with an item's row open in place, or with nothing open when it has no row. */
export function openTodayRow(lines: readonly TodayLine[] | undefined, item: string) {
  navigate({ kind: "today" });
  setOpenSelection(todayRowOf(lines ?? [], item));
}

function RowCells({
  row,
  origin,
  open,
  onToggle,
}: {
  row: Row;
  origin: string | undefined;
  open: boolean;
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
      {...(origin ? { "data-origin": origin } : {})}
      {...(open ? { "data-open": "" } : {})}
    >
      <td className="today-row-fork">
        <button type="button" aria-expanded={open} title={row.fork} onClick={toggle}>
          {row.fork}
        </button>
      </td>
      <td className="today-row-what">
        {row.headline && (
          <button
            type="button"
            aria-expanded={open}
            data-pointer={row.headline.pointer}
            onClick={toggle}
          >
            {row.headline.text}
          </button>
        )}
      </td>
      <td className="today-row-open">{row.pill && <LinkPill link={row.pill} />}</td>
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

/** One section of Today's table: its heading and a box holding the shared four columns. */
function Section({
  id,
  label,
  count,
  head = false,
  children,
}: {
  id: string;
  label: ReactNode;
  count?: number;
  head?: boolean;
  children: ReactNode;
}) {
  const heading = useId();
  return (
    <section className="today-section" data-section={id} aria-labelledby={heading}>
      <h2 className="today-section-head" id={heading}>
        <span className="today-section-dot" aria-hidden="true" />
        {label}
        {count !== undefined && (
          <>
            {" "}
            <span className="today-section-count">{count}</span>
          </>
        )}
      </h2>
      <div className="today-section-box">
        <table>
          <colgroup>
            <col className="today-col-fork" />
            <col />
            <col className="today-col-open" />
            <col className="today-col-age" />
          </colgroup>
          {head && (
            <thead>
              <tr>
                <th scope="col">Fork</th>
                <th scope="col">What</th>
                <th scope="col">Open</th>
                <th scope="col">Age</th>
              </tr>
            </thead>
          )}
          {children}
        </table>
      </div>
    </section>
  );
}

/**
 * Today's table: Blocked and Waiting on you as core's situation lines whose rows open in place, one
 * at a time, then the lower sections whose rows open their place.
 */
export function TodayTable({ snapshot }: { snapshot: ViewSnapshot }) {
  const { briefing } = snapshot;
  const lines = briefing.lines;
  const open = useOpenSelection();
  const table = useRef<HTMLDivElement>(null);
  const openers = useRef(new Map<string, HTMLButtonElement | null>());
  const close = useCallback(() => setOpenSelection(null), []);
  const rows = (lines ?? []).flatMap(rowsOf);
  const openRow = rows.find((row) => isRow(row, open));
  const openKey = openRow?.key;

  useEffect(() => {
    if (!openKey) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Element | null;
      const today = table.current?.closest(".today");
      if (!target || !today?.contains(target) || target.closest("[data-open]")) return;
      setOpenSelection(null);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [openKey]);

  useEffect(() => {
    if (openKey) {
      const row = table.current?.querySelector(`tr[data-open]`);
      row?.scrollIntoView?.({ block: "nearest" });
    }
  }, [openKey]);

  if (!lines) return null;

  const forks = new Set(snapshot.stations.map(({ service }) => service));
  const items: FocusItem[] = [...briefing.focus, ...briefing.rest];
  const originOf = (row: Row) => {
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
    const place = row.member
      ? memberPlace(row.member, forks, briefing.places)
      : linePlace(row.line, forks, briefing.places);
    const content = todayContent({
      line: row.line,
      ...(row.member ? { member: row.member } : {}),
      items,
      place,
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
        </td>
      </tr>
    );
  };

  return (
    <div ref={table} className="today-table">
      {lines.length === 0 && <p className="today-table-calm">Nothing is yours to move today.</p>}
      {SECTIONS.map(({ id, label }) => {
        const held = lines.filter((line) => line.section === id);
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
      {lowerSections(briefing.today).map(({ id, label, rows }) => (
        <Section key={id} id={id} label={label}>
          <tbody>{rows}</tbody>
        </Section>
      ))}
    </div>
  );
}
