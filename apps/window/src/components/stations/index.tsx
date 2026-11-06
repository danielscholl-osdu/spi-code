// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ServiceStations, Station, UpTone } from "@spi-code/contracts";
import type { HTMLAttributes } from "react";
import type { Evidence } from "../../store/evidence.js";
import { SectionEvidence } from "../evidence/SectionEvidence.js";
import "./stations.css";

export const lineColumns = ["Sync PR", "Cascade", "Sync to Main", "Main run"];
const labels: Record<Station["id"], string> = {
  upstream: "Upstream",
  sync: "Sync PR",
  cascade: "Cascade",
  main: "Sync to Main",
  release: "Release",
  lane: "Stack lane",
};
const tones: Record<Station["state"], UpTone> = {
  idle: "neutral",
  moving: "run",
  waiting: "warn",
  stopped: "bad",
  unknown: "neutral",
};

const NO_EVIDENCE: Evidence = { areas: [], provenance: [] };

/**
 * Pass `evidence` (the snapshot the services came from) for envelopes and inferred markers, and
 * `tileProps` to make each tile a selectable option; `named={false}` drops the service heading.
 * `from` is the first service's index in the snapshot's stations, so pointers resolve there.
 */
export function Stations({
  services,
  evidence = NO_EVIDENCE,
  tileProps,
  named = true,
  from = 0,
}: {
  services: readonly ServiceStations[];
  evidence?: Evidence;
  tileProps?(service: string, station: Station): HTMLAttributes<HTMLElement>;
  named?: boolean;
  from?: number;
}) {
  return (
    <div className="service-stations">
      {services.map(({ service, stations }, offset) => {
        const row = from + offset;
        return (
          <section key={service} data-service={service} aria-label={`${service} stations`}>
            {named && <h3>{service}</h3>}
            <SectionEvidence evidence={evidence} prefixes={[`/stations/${row}`]} />
            <ol
              {...(tileProps
                ? {
                    role: "listbox",
                    "aria-label": `${service} stations`,
                    "data-selection-list": "",
                  }
                : {})}
            >
              {stations.map((station, index) => {
                const pointer = `/stations/${row}/stations/${index}`;
                return (
                  <li
                    key={station.id}
                    {...(tileProps ? { role: "option", ...tileProps(service, station) } : {})}
                    data-station={station.id}
                    data-state={station.state}
                    data-tone={tones[station.state]}
                    data-pointer={pointer}
                  >
                    <strong>{labels[station.id]}</strong>
                    <span data-label="">{station.text}</span>
                    <small>{station.state}</small>
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })}
    </div>
  );
}
