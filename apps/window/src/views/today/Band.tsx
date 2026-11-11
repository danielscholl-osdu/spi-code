// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type {
  AmbientLine,
  LineStation as CoreStation,
  DecisionGroup,
  PlaceId,
  Mark as PlaceMark,
  ViewSnapshot,
  WatchItem,
} from "@spi-code/contracts";
import { useRef } from "react";
import { useStore } from "zustand";
import { type Destination, LINE, navigate } from "../../app/navigation.js";
import { treeServices } from "../../app/queue.js";
import {
  AgeChip,
  Chip,
  type ChipTone,
  PrBadge,
  ServiceChip,
  UpstreamChip,
} from "../../components/kit/Chip.js";
import { LineGlyph, LineGlyphLegend, type LineStation } from "../../components/kit/LineGlyph.js";
import { Mark, type MarkTier } from "../../components/kit/Mark.js";
import { type SelectionStore, selectionStore } from "../../panels/selection.js";
import { selectionRows, todayGroupRow } from "../../panels/selection-rows.js";
import { More, useFold } from "./folding.js";
import { interruptsOf } from "./selectors.js";
import "./band.css";

const TIER: Readonly<Record<PlaceMark, MarkTier>> = {
  stopped: "interrupt",
  "needs-person": "surface",
  "in-progress": "ambient",
  "nothing-due": "background",
};

const PLACE: Readonly<Record<PlaceId, { name: string; to: Destination }>> = {
  line: { name: "Line", to: LINE },
  environment: { name: "Environment", to: { kind: "environment" } },
  engineering: { name: "Engineering", to: { kind: "engineering-system" } },
  security: { name: "Security", to: { kind: "security" } },
};

const STATION: Readonly<Record<CoreStation, LineStation>> = {
  sync: "sync-pr",
  cascade: "release-upstream-pr",
  main: "main",
  release: "release",
};

const KIND: Readonly<Partial<Record<NonNullable<DecisionGroup["kind"]>, [string, string]>>> = {
  toolchain: ["⇡", "Toolchain move"],
  halt: ["⏸", "Sync halt"],
};

const RANK_TONE: Readonly<Record<WatchItem["rung"], ChipTone>> = {
  0: "bad",
  1: "warn",
  2: "plain",
};

type Open = {
  select(id: string): void;
  service(id: string): void;
  known: ReadonlySet<string>;
  selected: string | null;
};

function Service({ id, open, className }: { id: string; open: Open; className: string }) {
  return open.known.has(id) ? (
    <button
      type="button"
      className={className}
      title={`Open ${id}`}
      onClick={() => open.service(id)}
    >
      {id}
    </button>
  ) : (
    <span className={className}>{id}</span>
  );
}

function NeedCard({ item, open }: { item: WatchItem; open: Open }) {
  const upstream = item.origin === "upstream";
  return (
    <li
      className="today-need"
      data-item-id={item.id}
      data-rung={item.rung}
      data-origin={item.origin ?? "system"}
      aria-current={open.selected === item.id || undefined}
    >
      <Chip label={`P${item.rung}`} text={`P${item.rung}`} tone={RANK_TONE[item.rung]} />
      <Service id={item.scope} open={open} className="today-need-scope" />
      <button type="button" className="today-need-title" onClick={() => open.select(item.id)}>
        {item.title}
      </button>
      <span className="today-need-act">
        {upstream && <UpstreamChip text="From upstream GitLab" />}
        {item.age && <AgeChip age={item.age} text={item.sub || item.age} />}
        {item.blocks && (
          <span className="today-need-blocks">
            <Chip label={item.blocks.text} text={item.effect} tone="warn" />
          </span>
        )}
        <button type="button" className="today-verb" onClick={() => open.select(item.id)}>
          {item.verb} ›
        </button>
      </span>
    </li>
  );
}

function NeedsYou({ items, open }: { items: readonly WatchItem[]; open: Open }) {
  if (items.length === 0) return null;
  return (
    <div className="today-band-group today-needs" data-group="needs">
      <h3 className="today-band-heading">
        Needs you <span className="today-band-count">· {items.length}</span>
      </h3>
      <ul className="today-band-list">
        {items.map((item) => (
          <NeedCard key={item.id} item={item} open={open} />
        ))}
      </ul>
    </div>
  );
}

function Decision({
  group,
  open,
  themes,
}: {
  group: DecisionGroup;
  open: Open;
  themes: ReadonlySet<string>;
}) {
  const [first] = group.itemIds;
  const target =
    group.itemIds.length > 1 && themes.has(group.theme) ? `theme:${group.theme}` : first;
  const kind = group.kind ? KIND[group.kind] : undefined;
  const openGroup = () => target && open.select(target);
  return (
    <li
      className="today-decision"
      data-decision-id={group.id}
      data-theme={group.theme}
      data-item-ids={group.itemIds.join(" ")}
      data-kind={group.kind}
      title={group.text}
      aria-current={(target !== undefined && open.selected === target) || undefined}
    >
      {kind && (
        <span className="today-decision-kind" role="img" aria-label={kind[1]} title={kind[1]}>
          {kind[0]}
        </span>
      )}
      <span className="today-decision-scope">
        {group.scope.map(({ service, pr }) => {
          const badge = pr && {
            number: pr.number,
            text: `PR #${pr.number}`,
            ...(pr.inspect ? { onOpen: () => open.select(pr.inspect as string) } : {}),
          };
          return (
            <span
              key={service}
              className="today-decision-fork"
              data-service={service}
              data-pr-url={pr?.url}
              data-inspect={pr?.inspect}
            >
              {open.known.has(service) ? (
                <ServiceChip
                  service={service}
                  text={`Open ${service}`}
                  onOpen={() => open.service(service)}
                  {...(badge ? { pr: badge } : {})}
                />
              ) : (
                <>
                  <span className="kit-chip kit-chip--service">{service}</span>
                  {badge && <PrBadge {...badge} />}
                </>
              )}
            </span>
          );
        })}
      </span>
      <button
        type="button"
        className={group.token ? "today-decision-cause kit-chip" : "today-decision-cause"}
        aria-label={group.text}
        onClick={openGroup}
      >
        {group.token ?? group.text}
      </button>
      {group.verb && (
        <button type="button" className="today-verb" onClick={openGroup}>
          {group.verb} ›
        </button>
      )}
    </li>
  );
}

function DecisionsWaiting({ snapshot, open }: { snapshot: ViewSnapshot; open: Open }) {
  const decisions = snapshot.briefing.decisions;
  const fold = useFold(decisions?.groups ?? [], open.selected, (row) => [
    `theme:${row.theme}`,
    ...row.scope.flatMap(({ pr }) => (pr?.inspect ? [pr.inspect] : [])),
  ]);
  if (!decisions || decisions.groups.length === 0) return null;
  const themes = new Set(snapshot.briefing.themes.map(({ id }) => id));
  return (
    <div className="today-band-group today-decisions" data-group="decisions">
      <h3 className="today-band-heading">
        Decisions waiting <span className="today-band-count">· {decisions.text}</span>
      </h3>
      <ul className="today-band-list">
        {fold.visible.map((group) => (
          <Decision key={group.id} group={group} open={open} themes={themes} />
        ))}
      </ul>
      <More
        group="decisions"
        count={fold.more}
        hasMore={fold.hidden}
        row={todayGroupRow(snapshot, "decisions")}
        select={(row) => open.select(row.id)}
      />
    </div>
  );
}

function FailingRow({ line, open }: { line: AmbientLine; open: Open }) {
  const [first] = line.itemIds;
  return (
    <li
      className="today-item-row"
      data-line-id={line.id}
      data-item-ids={line.itemIds.join(" ")}
      data-count={line.count}
      data-origin={line.origin}
      title={line.text}
      aria-current={(first !== undefined && open.selected === first) || undefined}
    >
      <span className="today-item-fork">
        {line.service && <Service id={line.service} open={open} className="today-item-service" />}
      </span>
      <span className="today-item-glyph" data-station={line.station}>
        {line.station && (
          <LineGlyph station={STATION[line.station]} state="broken" text={line.text} />
        )}
      </span>
      <span className="today-item-pr" data-pr-url={line.pr?.url} data-inspect={line.pr?.inspect}>
        {line.pr && (
          <PrBadge
            number={line.pr.number}
            text={`PR #${line.pr.number}`}
            {...(line.pr.inspect ? { onOpen: () => open.select(line.pr?.inspect as string) } : {})}
          />
        )}
      </span>
      <span className="today-item-state" data-tone={line.state?.tone}>
        {line.state && <Chip label={line.state.text} text={line.text} tone={line.state.tone} />}
        {line.followUp && <Chip label={line.followUp} text={line.followUp} tone="plain" />}
        {line.origin === "upstream" && <UpstreamChip text="From upstream GitLab" />}
      </span>
      <span className="today-item-age">
        {line.age && <AgeChip age={line.age} text={line.text} />}
      </span>
      <button
        type="button"
        className="today-item-open"
        aria-label={line.text}
        onClick={() => first && open.select(first)}
      >
        ›
      </button>
    </li>
  );
}

function Failing({ snapshot, open }: { snapshot: ViewSnapshot; open: Open }) {
  const failing = snapshot.briefing.ambient?.failing;
  const fold = useFold(failing?.lines ?? [], open.selected, (row) =>
    row.pr?.inspect ? [row.pr.inspect] : [],
  );
  if (!failing || failing.lines.length === 0) return null;
  return (
    <div className="today-band-group today-failing" data-group="failing">
      <h3 className="today-band-heading">
        Failing <span className="today-band-count">· {failing.text}</span>
      </h3>
      <ul className="today-band-list">
        {fold.visible.map((line) => (
          <FailingRow key={line.id} line={line} open={open} />
        ))}
      </ul>
      <More
        group="failing"
        count={fold.more}
        hasMore={fold.hidden}
        row={todayGroupRow(snapshot, "failing")}
        select={(row) => open.select(row.id)}
      />
      {failing.lines.some(({ station }) => station) && <LineGlyphLegend />}
    </div>
  );
}

function BandTop({
  snapshot,
  onHorizon,
  onPlace,
}: {
  snapshot: ViewSnapshot;
  onHorizon: () => void;
  onPlace: (to: Destination) => void;
}) {
  const counts = snapshot.briefing.horizon.counts;
  const places = snapshot.briefing.places ?? [];
  const need = counts?.needYouCards ?? 0;
  if (need === 0 && places.length === 0) return null;
  return (
    <div className="today-band-top">
      {counts && need > 0 && (
        <UpstreamChip
          label={`${need} upstream need you first`}
          text={counts.text}
          onOpen={onHorizon}
        />
      )}
      {places.length > 0 && (
        <span className="today-band-marks">
          {places.map((row) => (
            <button
              key={row.place}
              type="button"
              className="today-band-mark"
              data-place={row.place}
              data-mark={row.mark}
              title={row.line}
              aria-label={`${PLACE[row.place].name}: ${row.line}`}
              onClick={() => onPlace(PLACE[row.place].to)}
            >
              <Mark tier={TIER[row.mark]} />
              <span className="today-band-mark-name">{PLACE[row.place].name}</span>
            </button>
          ))}
        </span>
      )}
    </div>
  );
}

/** The band holds something: an Interrupt, an in-system decision, or a Failing line. */
export function bandHolds({ briefing }: Pick<ViewSnapshot, "briefing">): boolean {
  return (
    interruptsOf(briefing).length > 0 ||
    (briefing.decisions?.groups.length ?? 0) > 0 ||
    (briefing.ambient?.failing.lines.length ?? 0) > 0
  );
}

/**
 * What asks for the operator: every Interrupt in Needs you, the in-system Surface decisions and the
 * Failing run. Drawn only when one of them holds something.
 */
export function AttentionBand({
  snapshot,
  inspector = selectionStore,
  onNavigate = navigate,
}: {
  snapshot: ViewSnapshot;
  inspector?: SelectionStore;
  onNavigate?: (to: Destination) => void;
}) {
  const band = useRef<HTMLElement>(null);
  const selected = useStore(inspector, (state) => state.selected);
  const { briefing } = snapshot;
  if (!bandHolds(snapshot)) return null;
  const needs = interruptsOf(briefing).sort((a, b) => a.rung - b.rung);
  const decisions = briefing.decisions?.groups.length ?? 0;
  const open: Open = {
    select(id) {
      const row = selectionRows(snapshot).find((candidate) => candidate.id === id);
      inspector.getState().select(id, row);
      inspector.getState().setTab("detail");
    },
    service: (id) => onNavigate({ kind: "service", id }),
    known: new Set(treeServices(snapshot.tree)),
    selected,
  };
  const toHorizon = () =>
    band.current
      ?.closest(".today-frame")
      ?.querySelector('[data-today-slot="horizon"]')
      ?.scrollIntoView({ block: "start" });
  const paired = needs.length > 0 && decisions > 0;
  return (
    <section
      ref={band}
      className="today-band card"
      aria-label="Needs your attention, in your system"
    >
      <BandTop snapshot={snapshot} onHorizon={toHorizon} onPlace={onNavigate} />
      {(needs.length > 0 || decisions > 0) && (
        <div className={paired ? "today-band-grid" : "today-band-grid today-band-one"}>
          <NeedsYou items={needs} open={open} />
          <DecisionsWaiting snapshot={snapshot} open={open} />
        </div>
      )}
      <Failing snapshot={snapshot} open={open} />
    </section>
  );
}
