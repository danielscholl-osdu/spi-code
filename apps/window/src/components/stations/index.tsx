// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ServiceStations, Station, UpTone } from "@spi-code/contracts";
import type { Evidence } from "../../store/evidence.js";
import { AreaEnvelopes, InferredMark } from "../evidence/AreaEnvelopes.js";
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

/** Pass `evidence` (the snapshot the services came from) for envelopes and inferred markers. */
export function Stations({
  services,
  evidence = NO_EVIDENCE,
}: {
  services: readonly ServiceStations[];
  evidence?: Evidence;
}) {
  return (
    <div className="service-stations">
      {services.map(({ service, stations }, row) => (
        <section key={service} data-service={service} aria-label={`${service} stations`}>
          <h3>{service}</h3>
          <AreaEnvelopes evidence={evidence} prefixes={[`/stations/${row}`]} />
          <ol>
            {stations.map((station, index) => {
              const pointer = `/stations/${row}/stations/${index}`;
              return (
                <li
                  key={station.id}
                  data-station={station.id}
                  data-state={station.state}
                  data-tone={tones[station.state]}
                  data-pointer={pointer}
                >
                  <strong>{labels[station.id]}</strong>
                  <span data-label="">{station.text}</span>
                  <small>{station.state}</small>
                  <InferredMark evidence={evidence} pointer={pointer} />
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
