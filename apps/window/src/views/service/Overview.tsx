// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ServiceHomeRow } from "@spi-code/contracts";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { navigate, routeHash } from "../../app/navigation.js";
import { shortcutLabel } from "../../app/shortcuts.js";
import { useNow } from "../../components/evidence/useNow.js";
import { LinkPill, linkPillText } from "../../components/kit/LinkPill.js";
import type { BodyPlace, OpenedContent } from "../../components/opened-body/content.js";
import { OpenedBody } from "../../components/opened-body/OpenedBody.js";
import { plainTitle } from "../../text.js";
import { When, when } from "../../time.js";
import { ageInOneUnit } from "../today/parts.js";
import { todayRowOf } from "../today/Table.js";
import type { TabProps } from "./tabs.js";

const SECTIONS = [
  { id: "blocked", label: "Blocked" },
  { id: "waiting", label: "Waiting on you" },
] as const;

const FOLDS = [
  { id: "shared", label: "Shared work", count: false },
  { id: "can-wait", label: "Can wait", count: true },
] as const;

const TODAY = { label: "Today", destination: { kind: "today" } } satisfies BodyPlace;

function contentOf(row: ServiceHomeRow, place: BodyPlace, fork: string): OpenedContent {
  const section = row.section === "blocked" || row.section === "waiting" ? row.section : undefined;
  const [primary] = row.links;
  return {
    title: row.headline,
    place,
    subject: section ? { kind: "item", id: row.id } : null,
    ...(section ? { section, scope: fork } : {}),
    ...(section ? (row.jobs ? { cause: row.jobs } : {}) : { cause: row.cause }),
    ...(row.effect && !section ? { effect: row.effect } : {}),
    steps: section ? [] : row.steps,
    ...(primary ? { primary } : {}),
    links: row.links,
  };
}

/** A closed Blocked or Waiting row's cause, its proof and its next move, all from core. */
function RowLines({ row }: { row: ServiceHomeRow }) {
  const { failure } = row;
  return (
    <>
      <p className="service-row-cause">
        {failure ? (
          <>
            <span className="service-row-path">{plainTitle(failure.path)}</span>
            {failure.reason && ` · ${plainTitle(failure.reason)}`}{" "}
            <span className="service-row-verdict">{failure.verdict}</span>
          </>
        ) : (
          plainTitle(row.cause)
        )}
      </p>
      {row.evidence && <p className="service-row-evidence">{plainTitle(row.evidence)}</p>}
      {row.next && (
        <p className="service-row-next">
          <span className="service-row-arrow" aria-hidden="true">
            →
          </span>
          <span>
            {row.rerunning && <span className="service-row-spin" aria-hidden="true" />}
            {plainTitle(row.next)}
          </span>
        </p>
      )}
    </>
  );
}

/** The fork's rows in Today's words; a row opens in place, and its typed pill is the link out. */
export function Overview({ id, home, snapshot, row: open, focus }: TabProps) {
  const heads = useRef(new Map<string, HTMLButtonElement | null>());
  const lines = snapshot.briefing.lines ?? [];
  const toggle = (row: string | undefined) =>
    navigate({ kind: "service", id, tab: "overview", ...(row ? { row } : {}) });

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new focus request moves focus to the same open row
  useEffect(() => {
    const head = open ? heads.current.get(open) : undefined;
    head?.focus({ preventScroll: true });
    head?.closest("li")?.scrollIntoView?.({ block: "nearest" });
  }, [open, focus]);

  const placeOf = (row: ServiceHomeRow): BodyPlace => {
    if (row.section === "shared") return { label: "Upstream", destination: { kind: "upstream" } };
    if (row.section === "can-wait") return TODAY;
    const selection = todayRowOf(lines, row.id);
    return {
      label: row.section === "blocked" ? "Today · Blocked" : "Today · Waiting on you",
      destination: { kind: "today" },
      ...(selection ? { selection } : {}),
    };
  };
  const yours = home.overview.filter(
    ({ section }) => section === "blocked" || section === "waiting",
  ).length;

  const lead = home.stations.find(
    (station) => station.id === "main" && station.state === "stopped",
  )?.row;
  const item = (row: ServiceHomeRow) => {
    const opened = row.id === open;
    const yoursRow = row.section === "blocked" || row.section === "waiting";
    const [pill] = row.links;
    const leads = row.id === lead;
    return (
      <li
        key={row.id}
        data-row={row.id}
        data-open={opened || undefined}
        data-lead={leads || undefined}
      >
        <div className="service-row">
          <span className="service-row-what">
            <button
              type="button"
              className="service-row-head"
              aria-expanded={opened}
              ref={(button) => {
                heads.current.set(row.id, button);
              }}
              onClick={() => toggle(opened ? undefined : row.id)}
            >
              {row.headline}
            </button>
            {row.section === "shared" && <span className="service-tag">Counted on Upstream</span>}
            {row.gate && <span className="service-row-gate">{row.gate}</span>}
          </span>
          <span className="service-row-open">
            {pill && <LinkPill link={pill} {...(row.failure ? { label: pill.label } : {})} />}
            {leads && opened && <kbd className="service-row-key">{shortcutLabel("↵")}</kbd>}
          </span>
          <span className="service-row-age">
            {row.since && <Age since={row.since} age={row.age} />}
          </span>
        </div>
        {yoursRow && <RowLines row={row} />}
        {opened && (
          <div className="service-row-body">
            <OpenedBody
              content={contentOf(row, placeOf(row), id)}
              selection={{ kind: "row", id: row.id }}
              origin="today"
              {...(pill ? { rowUrl: pill.url } : {})}
              onClose={() => {
                toggle(undefined);
                heads.current.get(row.id)?.focus();
              }}
            />
          </div>
        )}
      </li>
    );
  };
  const folds = FOLDS.map((fold) => ({
    ...fold,
    rows: home.overview.filter((row) => row.section === fold.id),
  })).filter(({ rows }) => rows.length > 0);

  return (
    <div className="service-overview">
      {yours === 0 && (
        <p className="service-quiet" data-quiet={home.mark.kind}>
          {home.mark.kind === "unread" ? (
            <>
              ⌀ Part of this fork was not read.{" "}
              <a
                href={routeHash({ kind: "evidence", from: { kind: "service", id } })}
                onClick={(event) => {
                  event.preventDefault();
                  navigate({ kind: "evidence", from: { kind: "service", id } });
                }}
              >
                Evidence ›
              </a>
            </>
          ) : (
            "Nothing waiting on you"
          )}
        </p>
      )}
      {SECTIONS.map((section) => {
        const rows = home.overview.filter((row) => row.section === section.id);
        if (rows.length === 0) return null;
        return (
          <Section key={section.id} id={section.id} label={section.label} count={rows.length}>
            {rows.map(item)}
          </Section>
        );
      })}
      {folds.length > 0 && (
        <ul className="service-section-box service-folds">
          {folds.map((fold) => (
            <Fold
              key={fold.id}
              fold={fold}
              open={open}
              item={item}
              close={() => toggle(undefined)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** Shared work and Can wait as one line each that opens their rows. */
function Fold({
  fold,
  open,
  item,
  close,
}: {
  fold: { id: string; label: string; count: boolean; rows: ServiceHomeRow[] };
  open: string | undefined;
  item: (row: ServiceHomeRow) => ReactNode;
  close: () => void;
}) {
  const holds = fold.rows.some((row) => row.id === open);
  const [expanded, setExpanded] = useState(holds);
  const body = useId();
  useEffect(() => {
    if (holds) setExpanded(true);
  }, [holds]);
  const shown = expanded || holds;
  const names = fold.rows.map(({ links: [link], headline }) =>
    link ? linkPillText(link) : headline,
  );
  return (
    <li className="service-fold" data-section={fold.id}>
      <button
        type="button"
        className="service-fold-head"
        aria-expanded={shown}
        {...(shown ? { "aria-controls": body } : {})}
        onClick={() => {
          if (shown && holds) close();
          setExpanded(!shown);
        }}
      >
        <span className="service-fold-words">
          <b>
            {fold.label}
            {fold.count && ` ${fold.rows.length}`}
          </b>
          {" · "}
          {fold.id === "shared"
            ? `${fold.rows[0]?.headline} · Counted on Upstream`
            : names.join(" · ")}
        </span>
        <span className="service-fold-chevron" aria-hidden="true">
          ▸
        </span>
      </button>
      {shown && (
        <ul id={body} className="service-fold-rows">
          {fold.rows.map(item)}
        </ul>
      )}
    </li>
  );
}

function Section({
  id,
  label,
  count,
  children,
}: {
  id: string;
  label: string;
  count: number | undefined;
  children: ReactNode;
}) {
  const heading = useId();
  return (
    <section className="service-section" data-section={id} aria-labelledby={heading}>
      <h2 className="service-section-head" id={heading}>
        <span className="service-section-dot" aria-hidden="true" />
        {label}
        {count !== undefined && <span className="service-section-count">{count}</span>}
      </h2>
      <ul className="service-section-box">{children}</ul>
    </section>
  );
}

/** The age Today shows for the same row, with its clock time on hover. */
function Age({ since, age }: { since: string; age: string | undefined }) {
  const now = useNow();
  if (!age) return <When at={since} />;
  return (
    <time dateTime={since} title={when(since, { now })}>
      {ageInOneUnit(age)}
    </time>
  );
}
