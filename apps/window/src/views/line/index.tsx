// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Station, StationSubstate } from "@spi-code/contracts";
import { useState } from "react";
import { useStore } from "zustand";
import {
  closeSheet,
  type LineColumn,
  navigate,
  pinSheet,
  type SheetPresentation,
  unpinSheet,
  useLineSheetRequest,
} from "../../app/navigation.js";
import { PinMenu } from "../../components/pin/PinMenu.js";
import { FreshItems } from "../../components/place/FreshItems.js";
import { selectionStore } from "../../panels/selection.js";
import { selectionRows } from "../../panels/selection-rows.js";
import { watchStore } from "../../store/watch.js";
import { TimedText } from "../../time.js";
import "./line.css";

const columns: readonly { id: Station["id"]; label: string }[] = [
  { id: "upstream", label: "Upstream" },
  { id: "sync", label: "Sync PR" },
  { id: "cascade", label: "Cascade" },
  { id: "main", label: "Main" },
  { id: "release", label: "Release PR" },
  { id: "lane", label: "Stack lane" },
];
const glyphs: Record<StationSubstate, { mark: string; name: string }> = {
  stopped: { mark: "✕", name: "Stopped" },
  "waiting-on-person": { mark: "!", name: "Needs a person" },
  "in-progress": { mark: "◐", name: "In progress" },
  "waiting-on-clock": { mark: "◷", name: "Scheduled" },
  ready: { mark: "·", name: "Nothing to do" },
};

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
  const selected = useStore(selectionStore, (state) => state.selected);
  const [columnId, setColumnId] = useState(initialColumn);
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const campaigns = snapshot?.campaigns ?? [];
  const column = columns.find(({ id }) => id === columnId);
  const campaign = campaigns.find(({ id }) => id === campaignId);
  const rows = (snapshot?.stations ?? []).filter(
    ({ service, stations }) =>
      (!columnId || stations.some(({ id, text }) => id === columnId && text.trim())) &&
      (campaign ? campaign.forks.includes(service) : stations.some(({ text }) => text.trim())),
  );
  const quiet = rows.filter(({ stations }) =>
    stations.every(({ substate }) => substate !== "stopped" && substate !== "waiting-on-person"),
  );
  const folded = campaign || column ? [] : quiet;
  const visible = rows.filter((row) => expanded || !folded.includes(row));
  const populatedColumns = columns.filter(({ id }) =>
    rows.some(({ stations }) =>
      stations.some((station) => station.id === id && station.text.trim()),
    ),
  );
  const selections = new Map(snapshot ? selectionRows(snapshot).map((row) => [row.id, row]) : []);
  return (
    <div className="line-content">
      <div className="line-toolbar pane-header">
        <h1>Line</h1>
        {rows.length > 0 && <span>{rows.length} services</span>}
        <div className="line-controls">
          <button type="button" onClick={presentation === "pinned" ? unpinSheet : pinSheet}>
            {presentation === "pinned" ? "Unpin" : "Pin"}
          </button>
          <button type="button" aria-label="Close Line" onClick={closeSheet}>
            Close
          </button>
        </div>
      </div>
      <div className="line-body">
        {!snapshot && (
          <p className="line-before-sweep">Service rows appear after the first sweep.</p>
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
                  <th scope="col">Service</th>
                  {populatedColumns.map(({ id, label }) => (
                    <th scope="col" key={id}>
                      {label}
                    </th>
                  ))}
                  {campaign && <th scope="col">Campaign</th>}
                </tr>
              </thead>
              <tbody>
                {visible.map(({ service, stations }) => (
                  <PinMenu
                    key={service}
                    service={service}
                    render={
                      <tr data-service={service}>
                        <th scope="row">
                          <button
                            type="button"
                            onClick={() => navigate({ kind: "service", id: service })}
                          >
                            {service}
                          </button>
                        </th>
                        {populatedColumns.map(({ id, label }) => {
                          const station = stations.find((station) => station.id === id);
                          const selection = selections.get(`station:${service}:${id}`);
                          const glyph = station && glyphs[station.substate];
                          return (
                            <td key={id} data-station={id}>
                              {station?.text.trim() && glyph && selection && (
                                <button
                                  type="button"
                                  data-station={id}
                                  data-selection-id={selection.id}
                                  aria-pressed={selected === selection.id}
                                  onClick={() =>
                                    selectionStore.getState().select(selection.id, selection)
                                  }
                                >
                                  <span className="visually-hidden">
                                    {label} · {service}:{" "}
                                  </span>
                                  <span
                                    className="line-glyph"
                                    data-substate={station.substate}
                                    role="img"
                                    aria-label={glyph.name}
                                  >
                                    {glyph.mark}
                                  </span>{" "}
                                  <TimedText text={station.text} hint={false} />
                                </button>
                              )}
                            </td>
                          );
                        })}
                        {campaign && <td data-campaign="">Included</td>}
                      </tr>
                    }
                  />
                ))}
                {folded.length > 0 && (
                  <tr>
                    <td colSpan={populatedColumns.length + 1}>
                      <button
                        type="button"
                        className="line-fold"
                        aria-expanded={expanded}
                        onClick={() => setExpanded(!expanded)}
                      >
                        {folded.length} services need nothing:{" "}
                        {folded.map(({ service }) => service).join(", ")}
                      </button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
