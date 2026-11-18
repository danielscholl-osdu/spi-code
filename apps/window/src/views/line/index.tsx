// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useCallback, useState } from "react";
import { useStore } from "zustand";
import {
  closeSheet,
  type LineColumn,
  navigate,
  pinSheet,
  type SheetPresentation,
  setOpenSelection,
  unpinSheet,
  useLineSheetRequest,
  useOpenSelection,
} from "../../app/navigation.js";
import { Icon } from "../../components/icons/Icon.js";
import { PinControl } from "../../components/pin/PinControl.js";
import { PinMenu } from "../../components/pin/PinMenu.js";
import { FreshItems } from "../../components/place/FreshItems.js";
import { placeMembers } from "../../components/place/members.js";
import { PlaceHead } from "../../components/place/PlaceHead.js";
import { Popover } from "../../components/popover/Popover.js";
import { watchStore } from "../../store/watch.js";
import { plainTitle } from "../../text.js";
import { TimedText } from "../../time.js";
import { cellOpening } from "./cell-content.js";
import { cellItems, cellState, cellText, columns, glyphs, memberStations } from "./cells.js";
import "./line.css";

export default function Line({
  presentation,
}: {
  presentation: Exclude<SheetPresentation, "closed">;
}) {
  const request = useLineSheetRequest();
  return (
    <LineContent key={request.id} presentation={presentation} initialColumn={request.column} />
  );
}

function LineContent({
  presentation,
  initialColumn,
}: {
  presentation: Exclude<SheetPresentation, "closed">;
  initialColumn: LineColumn | undefined;
}) {
  const snapshot = useStore(watchStore, (state) => state.snapshot?.body);
  const marked = useOpenSelection();
  const members = placeMembers(snapshot, "line");
  const member = members.find(
    ({ member }) => marked?.kind === "item" && member.id === marked.id,
  )?.member;
  const opening = cellOpening(snapshot, marked);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const close = useCallback(() => setOpenSelection(null), []);
  const [columnId, setColumnId] = useState(initialColumn);
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const campaigns = (snapshot?.campaigns ?? [])
    .filter(({ kind }) => kind === "toolchain")
    .slice(0, 4);
  const column = columns.find(({ id }) => id === columnId);
  const campaign = campaigns.find(({ id }) => id === campaignId);
  const items = [...(snapshot?.briefing.focus ?? []), ...(snapshot?.briefing.rest ?? [])];
  const rows = (snapshot?.stations ?? []).filter(
    ({ stations }) => !column || stations.some(({ id, text }) => id === column.id && text.trim()),
  );
  const quiet = rows.filter(({ service, stations }) =>
    stations
      .filter(({ id }) => columns.some((column) => column.id === id))
      .every(
        (station) =>
          ["ready", "waiting-on-clock"].includes(cellState(station)) &&
          !cellItems(items, service, station.id).length,
      ),
  );
  const folded = column || quiet.length === rows.length ? [] : quiet;
  const visible = rows.filter(
    (row) =>
      expanded ||
      row.service === member?.fork ||
      opening?.cell.startsWith(`${row.service}:`) ||
      !folded.includes(row),
  );
  const plan = snapshot?.briefing.flow.plan;
  return (
    <div className="line-content">
      <PlaceHead
        name="Line"
        place="line"
        snapshot={snapshot}
        heading={
          <div className="line-toolbar pane-header">
            <h1>Line</h1>
            {rows.length > 0 && <span>{rows.length} forks</span>}
            <div className="line-controls">
              <button
                type="button"
                className="line-dock"
                onClick={presentation === "pinned" ? unpinSheet : pinSheet}
              >
                <Icon name="panelRight" size={14} />
                {presentation === "pinned" ? "Undock" : "Dock"}
              </button>
              <button type="button" aria-label="Close Line" onClick={closeSheet}>
                Close
              </button>
            </div>
          </div>
        }
      />
      <div className="line-body">
        {!snapshot && (
          <p className="line-before-sweep">Service rows appear after the first sweep.</p>
        )}
        {plan && (
          <div className="line-plan">
            <strong>{plan.title}</strong>
            {plan.lines.map(({ label, text }) => (
              <span key={label}>
                {label}:{" "}
                <b>
                  <TimedText
                    text={(label === "Wave 1" ? `${text.split(", ").length} forks` : text)
                      .replace(
                        "workflow (SNAPSHOT)",
                        "workflow (waits for a released os-core-common)",
                      )
                      .replace("(filter rule)", "(needs a filter rule)")}
                    hint={false}
                  />
                </b>
              </span>
            ))}
          </div>
        )}
        {column && (
          <fieldset className="line-campaigns" aria-label="Station filter">
            <button
              type="button"
              aria-label={`Clear ${column.label} filter`}
              aria-pressed="true"
              onClick={() => setColumnId(undefined)}
            >
              {column.label} · Clear
            </button>
          </fieldset>
        )}
        {campaigns.length > 0 && (
          <fieldset className="line-campaigns" aria-label="Campaigns">
            {campaigns.map(({ id, fact, forks }) => (
              <button
                type="button"
                key={id}
                aria-pressed={campaign?.id === id}
                onClick={() => setCampaignId(campaign?.id === id ? null : id)}
              >
                {fact} · {forks.length} forks
              </button>
            ))}
          </fieldset>
        )}
        <FreshItems snapshot={snapshot} place="line" />
        {rows.length > 0 && (
          <div className="line-grid-scroll">
            <table className="line-grid" aria-label="Service stations">
              <thead>
                <tr>
                  <th scope="col">Fork</th>
                  {columns.map(({ id, label }) => (
                    <th scope="col" key={id}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map(({ service, stations }) => (
                  <PinMenu
                    key={service}
                    service={service}
                    onOpen={() => navigate({ kind: "service", id: service })}
                    render={
                      <tr
                        data-service={service}
                        data-highlighted={campaign ? campaign.forks.includes(service) : undefined}
                      >
                        <th scope="row">
                          <span className="line-service">
                            <button
                              type="button"
                              onClick={() => navigate({ kind: "service", id: service })}
                            >
                              {service}
                            </button>
                            <PinControl pin={service} name={service} size="row" shortcut={false} />
                          </span>
                        </th>
                        {columns.map(({ id, label }) => {
                          const station = stations.find((station) => station.id === id);
                          const cell = `${service}:${id}`;
                          const isOpen = opening?.cell === cell;
                          const state = station && cellState(station);
                          const glyph = state && glyphs[state];
                          const onToday = members.some(
                            ({ member }) =>
                              member.fork === service && memberStations(member).includes(id),
                          );
                          const text = station
                            ? cellText(station, cellItems(items, service, id))
                            : "not read";
                          return (
                            <td key={id} data-station={id}>
                              {station && glyph && (
                                <button
                                  ref={isOpen ? setAnchor : undefined}
                                  type="button"
                                  className="line-cell"
                                  data-on-today={onToday || undefined}
                                  data-station={id}
                                  data-cell={cell}
                                  data-member-marked={
                                    (service === member?.fork &&
                                      memberStations(member).includes(id)) ||
                                    undefined
                                  }
                                  aria-haspopup="dialog"
                                  aria-expanded={isOpen}
                                  onClick={() =>
                                    setOpenSelection(isOpen ? null : { kind: "cell", id: cell })
                                  }
                                >
                                  <span className="visually-hidden">
                                    {label} · {service}:{" "}
                                  </span>
                                  <span
                                    className="line-glyph"
                                    data-substate={state}
                                    role="img"
                                    aria-label={glyph.name}
                                  >
                                    {glyph.mark}
                                  </span>{" "}
                                  <span className="line-cell-text" title={text}>
                                    <TimedText text={text} hint={false} />
                                  </span>
                                  {onToday && <span className="visually-hidden"> · on Today</span>}
                                </button>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    }
                  />
                ))}
                {folded.length > 0 && (
                  <tr>
                    <td colSpan={columns.length + 1}>
                      <button
                        type="button"
                        className="line-fold"
                        aria-expanded={expanded}
                        onClick={() => setExpanded(!expanded)}
                      >
                        {expanded ? "▾" : "▸"} {folded.length} moving normally:{" "}
                        {folded.map(({ service }) => service).join(", ")}
                      </button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        {opening && marked && anchor?.isConnected && anchor.dataset.cell === opening.cell && (
          <Popover anchor={anchor} selection={marked} content={opening.content} onClose={close}>
            {opening.related.length > 0 && (
              <div className="popover-rows">
                {opening.related.map(({ line, member }) => (
                  <button
                    type="button"
                    key={member.id}
                    onClick={() => setOpenSelection({ kind: "item", id: member.id })}
                  >
                    {member.fork} · {plainTitle(line.headline)}
                    {"\u00a0›"}
                  </button>
                ))}
              </div>
            )}
          </Popover>
        )}
        {rows.length > 0 && (
          <div className="line-legend">
            {Object.entries(glyphs).map(([state, glyph]) => (
              <span key={state}>
                <span className="line-glyph" data-substate={state}>
                  {glyph.mark}
                </span>{" "}
                {glyph.name}
              </span>
            ))}
            <span>
              <span className="line-today-dot" /> on Today
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
