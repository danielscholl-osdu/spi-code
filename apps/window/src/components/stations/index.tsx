// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ServiceStations, Station, UpTone } from "@spi-code/contracts";
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

export function Stations({ services }: { services: readonly ServiceStations[] }) {
  return (
    <div className="service-stations">
      {services.map(({ service, stations }) => (
        <section key={service} data-service={service} aria-label={`${service} stations`}>
          <h3>{service}</h3>
          <ol>
            {stations.map((station) => (
              <li
                key={station.id}
                data-station={station.id}
                data-state={station.state}
                data-tone={tones[station.state]}
              >
                <strong>{labels[station.id]}</strong>
                <span data-label="">{station.text}</span>
                <small>{station.state}</small>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
