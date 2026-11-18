// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ServiceHomeRow } from "@spi-code/contracts";
import { type ReactNode, useEffect, useId, useRef } from "react";
import { navigate, routeHash } from "../../app/navigation.js";
import { LinkPill } from "../../components/kit/LinkPill.js";
import type { BodyPlace, OpenedContent } from "../../components/opened-body/content.js";
import { OpenedBody } from "../../components/opened-body/OpenedBody.js";
import { When } from "../../time.js";
import { todayRowOf } from "../today/Table.js";
import type { TabProps } from "./tabs.js";

const SECTIONS = [
  { id: "blocked", label: "Blocked", count: true },
  { id: "waiting", label: "Waiting on you", count: true },
  { id: "shared", label: "Shared work", count: false },
  { id: "can-wait", label: "Can wait", count: true },
] as const;

const TODAY = { label: "Today", destination: { kind: "today" } } satisfies BodyPlace;

function contentOf(row: ServiceHomeRow, place: BodyPlace): OpenedContent {
  const section = row.section === "blocked" || row.section === "waiting" ? row.section : undefined;
  const [primary] = row.links;
  return {
    title: row.headline,
    place,
    subject: section ? { kind: "item", id: row.id } : null,
    ...(section ? { section } : {}),
    cause: row.cause,
    ...(row.effect ? { effect: row.effect } : {}),
    steps: row.steps,
    ...(primary ? { primary } : {}),
    links: row.links,
  };
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
          <Section
            key={section.id}
            id={section.id}
            label={section.label}
            count={section.count ? rows.length : undefined}
          >
            {rows.map((row) => {
              const opened = row.id === open;
              const [pill] = row.links;
              return (
                <li key={row.id} data-row={row.id} data-open={opened || undefined}>
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
                      {row.section === "shared" && (
                        <span className="service-tag">Counted on Upstream</span>
                      )}
                    </span>
                    <span className="service-row-open">{pill && <LinkPill link={pill} />}</span>
                    <span className="service-row-age">{row.since && <When at={row.since} />}</span>
                  </div>
                  {opened && (
                    <div className="service-row-body">
                      <OpenedBody
                        content={contentOf(row, placeOf(row))}
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
            })}
          </Section>
        );
      })}
    </div>
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
