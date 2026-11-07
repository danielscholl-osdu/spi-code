// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type Station, StationsSchema } from "@spi-code/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import briefing from "../../../../../fixtures/rib-59d6895/oracle/briefing.json?raw";
import lines from "../../../../../fixtures/rib-59d6895/oracle/lines.json?raw";
import { testSnapshot } from "../../store/test-snapshot.js";
import { Stations } from "./index.js";

const lineOracle: { columns: string[]; services: { fork: string; stations: Station[] }[] } =
  JSON.parse(lines);
const snapshot = testSnapshot(briefing, '{"lines":[],"reading":false}', {
  stations: StationsSchema.parse(
    lineOracle.services.map((service) => ({
      service: service.fork,
      stations: service.stations.map((station) => ({ ...station, substate: "ready" })),
    })),
  ),
});

it("draws every service's six stations in oracle order with exact labels, states and tones", () => {
  const dom = document.createElement("div");
  dom.innerHTML = renderToStaticMarkup(<Stations services={snapshot.stations} />);
  const services = dom.querySelectorAll("[data-service]");
  expect(Array.from(services, (row) => row.getAttribute("data-service"))).toEqual(
    lineOracle.services.map((service) => service.fork),
  );
  services.forEach((service, index) => {
    expect(
      Array.from(service.querySelectorAll("[data-station]"), (station) => ({
        id: station.getAttribute("data-station"),
        state: station.getAttribute("data-state"),
        text: station.querySelector("[data-label]")?.textContent,
      })),
    ).toEqual(lineOracle.services[index]?.stations);
  });
  for (const [service, station, tone] of [
    ["partition", "upstream", "neutral"],
    ["entitlements", "upstream", "warn"],
    ["partition", "lane", "bad"],
  ])
    expect(
      dom
        .querySelector(`[data-service="${service}"] [data-station="${station}"]`)
        ?.getAttribute("data-tone"),
    ).toBe(tone);
});

it("renders a moving station with the frozen run tone expectation", () => {
  const service = structuredClone(snapshot.stations[0]);
  if (!service) throw new Error("Missing station fixture");
  service.stations[5].state = "moving";
  service.stations[5].text = "Upgrade running";
  const dom = document.createElement("div");
  dom.innerHTML = renderToStaticMarkup(<Stations services={[service]} />);
  expect(dom.querySelector('[data-station="lane"]')?.getAttribute("data-tone")).toBe("run");
});
