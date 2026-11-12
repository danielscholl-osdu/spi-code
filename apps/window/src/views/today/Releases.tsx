// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Envelope, Forming, ReleasesToday, ViewSnapshot } from "@spi-code/contracts";
import type { CSSProperties } from "react";
import { useStore } from "zustand";
import { type Navigation, navigate } from "../../app/navigation.js";
import { sectionSources } from "../../components/evidence/SectionEvidence.js";
import { stateWord } from "../../components/evidence/words.js";
import { SegmentedBar } from "../../components/kit/SegmentedBar.js";
import { StackedBar, type StackTone } from "../../components/kit/StackedBar.js";
import { type SelectionStore, selectionStore } from "../../panels/selection.js";
import {
  notableRow,
  releasePrRow,
  releaseVersionRow,
  type SelectionRow,
} from "../../panels/selection-rows.js";
import { plainTitle } from "../../text.js";
import { clockTime, Time } from "../../time.js";
import { FORMING_RELEASES_ANCHOR, SHARED_COMPONENTS_ANCHOR } from "../releases/anchors.js";
import "./releases.css";

const TODAY = "/releases/today";
const FORMING = "/releases/forming";
const KINDS: readonly [keyof NonNullable<Forming["kinds"]>, StackTone][] = [
  ["breaking", "bad"],
  ["new", "accent"],
  ["improved", "accent"],
  ["fixed", "ok"],
  ["security", "warn"],
  ["other", "neutral"],
];
type Source = { name: string; envelope: Envelope };

/** Sources feeding the prefixes that were not read this sweep, or read only in part. */
function held(snapshot: ViewSnapshot, prefixes: readonly string[]): Source[] {
  return sectionSources(snapshot, prefixes).filter(
    ({ envelope }) =>
      envelope.state === "unread" ||
      envelope.state === "failed" ||
      envelope.completeness?.kind === "cut",
  );
}

const word = (envelope: Envelope) =>
  envelope.state === "incomplete" ? "read only in part" : stateWord(envelope);

const notRead = (sources: readonly Source[]) =>
  sources.some(({ envelope }) => envelope.state === "unread" || envelope.state === "failed");

/** Core's last good time for the releases area, else the oldest last good read among the held. */
function lastGood(today: ReleasesToday | undefined, sources: readonly Source[]) {
  if (today?.unread?.lastGood) return today.unread.lastGood;
  return sources
    .flatMap(({ envelope }) =>
      envelope.state !== "unread" && envelope.observedAt ? [envelope.observedAt] : [],
    )
    .sort()[0];
}

function revealSource(selection: SelectionStore, source: string | undefined) {
  selection.getState().openSweepEvidence();
  if (!source) return;
  const reveal = (remaining: number) => {
    const row = document.querySelector<HTMLElement>(
      `[data-evidence="sweep"] [data-source="${source}"]`,
    );
    if (row) {
      row.tabIndex = -1;
      row.scrollIntoView?.({ block: "center" });
      row.focus({ preventScroll: true });
    } else if (remaining > 0) requestAnimationFrame(() => reveal(remaining - 1));
  };
  requestAnimationFrame(() => reveal(10));
}

function Held({
  sources,
  today,
  selection,
}: {
  sources: readonly Source[];
  today: ReleasesToday | undefined;
  selection: SelectionStore;
}) {
  const at = lastGood(today, sources);
  const title = sources
    .map(
      ({ name, envelope }) =>
        `${name}: ${word(envelope)}${envelope.state !== "unread" && envelope.observedAt ? `, last good ${clockTime(envelope.observedAt, { hint: false })}` : ""}`,
    )
    .join("; ");
  return (
    <button
      type="button"
      className="kit-chip kit-chip--plain today-releases-held"
      data-areas={today?.unread?.areas.join(" ")}
      title={title}
      aria-label={`${title}. Open Evidence.`}
      onClick={() => revealSource(selection, sources[0]?.envelope.source)}
    >
      <span aria-hidden="true">⌀</span>
      {at ? (
        <>
          from <Time at={at} hint={false} />
        </>
      ) : (
        "not read"
      )}
    </button>
  );
}

/** `data-unread` when a field's own sources were not read this sweep, or read only in part. */
const unreadIf = (isHeld: boolean) => (isHeld ? "" : undefined);

function Versions({
  today,
  forming,
  isHeld,
  selected,
  select,
}: {
  today: ReleasesToday;
  forming: Forming | undefined;
  isHeld: (pointers: readonly string[]) => boolean;
  selected: string | null;
  select: (row: SelectionRow) => void;
}) {
  const { versions } = today;
  return (
    <ul
      className="today-release-versions"
      style={
        {
          "--release-rows": Math.ceil(versions.length / 3),
          "--release-narrow-rows": Math.ceil(versions.length / 2),
        } as CSSProperties
      }
    >
      {versions.map((version, index) => {
        const pointer = `${TODAY}/versions/${index}`;
        if (version.state !== "released")
          return (
            <li
              className="today-release"
              key={version.service}
              data-pointer={pointer}
              data-service={version.service}
              data-state={version.state}
            >
              <span className="today-release-service">{version.service}</span>
              <span className="today-release-none">{version.text}</span>
            </li>
          );
        const row = releaseVersionRow(version, index);
        const pr = version.pr;
        const prRow = pr && releasePrRow({ ...version, pr }, index, forming);
        return (
          <li
            className="today-release"
            key={version.service}
            data-pointer={pointer}
            data-service={version.service}
            data-state={version.state}
          >
            <span className="today-release-service">{version.service}</span>
            <fieldset className="today-release-pair" aria-label={plainTitle(version.text)}>
              <button
                type="button"
                className="today-release-released"
                data-unread={unreadIf(Boolean(today.unread) || isHeld([`${pointer}/released`]))}
                data-selection-id={row.id}
                aria-pressed={selected === row.id}
                onClick={() => select(row)}
              >
                {version.released}
              </button>
              {pr && prRow && version.proposed ? (
                <button
                  type="button"
                  className="today-release-arrow"
                  data-unread={unreadIf(isHeld([`${pointer}/proposed`, `${pointer}/pr`]))}
                  title={`release PR #${pr.number}`}
                  aria-label={`release PR #${pr.number}`}
                  data-selection-id={prRow.id}
                  aria-pressed={selected === prRow.id}
                  data-pr-number={pr.number}
                  data-pr-url={pr.url}
                  data-pr-inspect={pr.inspect}
                  onClick={() => select(prRow)}
                >
                  <span aria-hidden="true">→ </span>
                  <span className="today-release-proposed">{version.proposed}</span>
                </button>
              ) : (
                <span />
              )}
            </fieldset>
          </li>
        );
      })}
    </ul>
  );
}

function Platform({
  platform,
  released,
  isHeld,
  onNavigate,
}: {
  platform: ReleasesToday["platform"];
  released: boolean;
  isHeld: (pointers: readonly string[]) => boolean;
  onNavigate: Navigation["navigate"];
}) {
  const { stack, template, coreLibAzure } = platform;
  const at = `${TODAY}/platform`;
  const fromReleases = (field: string) => unreadIf(!released || isHeld([`${at}/${field}`]));
  const text = plainTitle(platform.text);
  return (
    <div className="today-release-line today-release-platform" data-pointer={at}>
      <button
        type="button"
        className="today-release-open"
        title={text}
        aria-label={`Platform: ${text}. Open Releases at the shared components.`}
        onClick={() => onNavigate({ kind: "releases", section: SHARED_COMPONENTS_ANCHOR })}
      >
        Platform
      </button>
      <span className="today-release-value">
        {stack && (
          <span>
            stack <b data-unread={fromReleases("stack")}>{stack}</b>
          </span>
        )}
        {template && (
          <span
            className="today-release-template"
            title={template.pr ? `release PR #${template.pr.number}` : undefined}
          >
            template <b data-unread={fromReleases("template/released")}>{template.released}</b>
            {template.proposed && (
              <span
                className="today-release-template-proposed"
                data-unread={unreadIf(isHeld([`${at}/template/proposed`, `${at}/template/pr`]))}
              >
                {" "}
                → {template.proposed}
              </span>
            )}
          </span>
        )}
        {coreLibAzure.length > 0 && (
          <span className="today-release-library" data-unread={fromReleases("coreLibAzure")}>
            core-lib-azure
            <SegmentedBar
              figure={coreLibAzure.map(({ version, count }) => `${version} ×${count}`).join(" · ")}
              text={text}
              segments={coreLibAzure.map(({ version, count }) => ({
                id: version,
                label: version,
                count,
              }))}
            />
          </span>
        )}
      </span>
      <span className="today-release-chev" aria-hidden="true">
        ›
      </span>
    </div>
  );
}

function Changes({
  forming,
  unread,
  selected,
  select,
  onNavigate,
}: {
  forming: Forming;
  unread: boolean;
  selected: string | null;
  select: (row: SelectionRow) => void;
  onNavigate: Navigation["navigate"];
}) {
  const kinds = !unread && forming.state !== "not-read" ? forming.kinds : undefined;
  const segments = kinds
    ? KINDS.map(([kind, tone]) => ({ id: kind, label: kind, count: kinds[kind], tone }))
    : [];
  const counted = segments.some(({ count }) => count > 0);
  const text = plainTitle(forming.text);
  return (
    <>
      <div
        className="today-release-line today-release-changes"
        data-pointer={FORMING}
        data-state={forming.state}
        data-unread={kinds ? undefined : ""}
      >
        <button
          type="button"
          className="today-release-open"
          title={kinds ? text : "not read this sweep"}
          aria-label={`${kinds ? text : "Unreleased: not read this sweep"}. Open Releases at the forming changes.`}
          onClick={() => onNavigate({ kind: "releases", section: FORMING_RELEASES_ANCHOR })}
        >
          Unreleased
        </button>
        <span className="today-release-value">
          {!kinds ? (
            <span className="today-release-unread">not read this sweep</span>
          ) : counted ? (
            <StackedBar segments={segments} text={text} />
          ) : (
            <span className="today-release-quiet">{forming.text}</span>
          )}
        </span>
        <span className="today-release-chev" aria-hidden="true">
          ›
        </span>
      </div>
      {kinds && forming.notable.length > 0 && (
        <ul className="today-release-notable" aria-label="Notable, unreleased">
          {forming.notable.map((notable, index) => {
            const row = notableRow(notable, index);
            return (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: two notable changes can share a title
                key={index}
                data-pointer={`${FORMING}/notable/${index}`}
                data-kind={notable.kind}
                data-services={notable.services.join(" ")}
                data-pr-number={notable.pr.number}
                data-pr-url={notable.pr.url}
                data-pr-inspect={notable.pr.inspect}
              >
                <button
                  type="button"
                  data-selection-id={row.id}
                  aria-pressed={selected === row.id}
                  onClick={() => select(row)}
                >
                  {notable.text}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

/** Today's Releases slot: drawn when core sends the versions or the forming releases. */
export function releasesSlot(snapshot: ViewSnapshot) {
  const { today, forming } = snapshot.releases;
  return today || forming ? <Releases snapshot={snapshot} /> : null;
}

/**
 * Releases on Today: every released version with the proposed one beside it, the platform line,
 * and what the forming releases carry. ⌀ names every source the block draws from; each field is
 * muted by its own sources.
 */
export function Releases({
  snapshot,
  onNavigate = navigate,
  selection = selectionStore,
}: {
  snapshot: ViewSnapshot;
  onNavigate?: Navigation["navigate"] | undefined;
  selection?: SelectionStore;
}) {
  const selected = useStore(selection, (state) => state.selected);
  const { today, forming } = snapshot.releases;
  const select = (row: SelectionRow) => selection.getState().select(row.id, row);
  const sources = held(snapshot, [TODAY, FORMING]);
  const isHeld = (pointers: readonly string[]) => held(snapshot, pointers).length > 0;
  const formingUnread = notRead(held(snapshot, [FORMING]));
  return (
    <section
      className="today-releases"
      aria-label="Releases"
      data-held={sources.length > 0 || today?.unread ? "" : undefined}
    >
      <header className="today-releases-head">
        <h2>
          <button
            type="button"
            className="today-releases-heading"
            onClick={() => onNavigate({ kind: "releases" })}
          >
            Releases
          </button>
        </h2>
        {today?.readyLine && <span className="today-releases-ready">{today.readyLine}</span>}
        {(sources.length > 0 || today?.unread) && (
          <Held sources={sources} today={today} selection={selection} />
        )}
      </header>
      {today && (
        <Versions
          today={today}
          forming={forming}
          isHeld={isHeld}
          selected={selected}
          select={select}
        />
      )}
      {today && (
        <Platform
          platform={today.platform}
          released={!today.unread}
          isHeld={isHeld}
          onNavigate={onNavigate}
        />
      )}
      {forming && (
        <Changes
          forming={forming}
          unread={formingUnread}
          selected={selected}
          select={select}
          onNavigate={onNavigate}
        />
      )}
    </section>
  );
}
