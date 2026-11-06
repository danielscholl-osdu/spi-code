// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Station, StationsSchema, type UpTone } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import briefing from "../../../../../fixtures/rib-59d6895/oracle/briefing.json?raw";
import lines from "../../../../../fixtures/rib-59d6895/oracle/lines.json?raw";
import mixed from "../../../../../fixtures/watch/snapshot-mixed-59d6895.json?raw";
import {
  expectEvidenceMarks,
  expectNoEvidenceMarks,
} from "../../components/evidence/marks.test-helper.js";
import { Stations } from "../../components/stations/index.js";
import { mixedSnapshot, testSnapshot } from "../../store/test-snapshot.js";
import { watchStore } from "../../store/watch.js";
import Horizon from "../horizon/index.js";
import Flow from "./index.js";

const stationStyles = readFileSync(
  resolve("apps/window/src/components/stations/stations.css"),
  "utf8",
);
const lineOracle: { columns: string[]; services: { fork: string; stations: Station[] }[] } =
  JSON.parse(lines);
const snapshot = testSnapshot(briefing, '{"lines":[],"reading":false}', {
  stations: StationsSchema.parse(
    lineOracle.services.map((service) => ({
      service: service.fork,
      stations: service.stations,
    })),
  ),
});

afterEach(() => watchStore.setState({ snapshot: null }));

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

it.each<{ tone: UpTone; strong: boolean; colour: string }>([
  { tone: "neutral", strong: false, colour: "rgb(100, 100, 100)" },
  { tone: "bad", strong: false, colour: "rgb(100, 100, 100)" },
  { tone: "warn", strong: false, colour: "rgb(100, 100, 100)" },
  { tone: "ok", strong: false, colour: "rgb(100, 100, 100)" },
  { tone: "run", strong: false, colour: "rgb(100, 100, 100)" },
  { tone: "neutral", strong: true, colour: "rgb(10, 20, 30)" },
  { tone: "bad", strong: true, colour: "rgb(100, 0, 0)" },
  { tone: "warn", strong: true, colour: "rgb(100, 80, 0)" },
  { tone: "ok", strong: true, colour: "rgb(10, 20, 30)" },
  { tone: "run", strong: true, colour: "rgb(10, 20, 30)" },
])("keeps the rib's next colour for $tone, strong=$strong", async ({ tone, strong, colour }) => {
  const body = structuredClone(snapshot);
  const row = body.briefing.flow.rows[0];
  if (!row) throw new Error("Missing flow fixture");
  row.next = { text: "Next step", tone, strong };
  watchStore.setState({ snapshot: { cursor: 1, body } });
  const dom = document.createElement("div");
  for (const [key, value] of Object.entries({
    "--text-muted": "rgb(100, 100, 100)",
    "--text-strong": "rgb(10, 20, 30)",
    "--error-text": "rgb(100, 0, 0)",
    "--warning-text": "rgb(100, 80, 0)",
  }))
    dom.style.setProperty(key, value);
  const style = document.createElement("style");
  style.textContent = stationStyles;
  document.head.append(style);
  document.body.append(dom);
  const root = createRoot(dom);
  try {
    await act(async () => root.render(<Flow />));
    const next = dom.querySelector(`[data-selection-id="${row.inspect}"] .flow-next`);
    if (!next) throw new Error("Missing next cell");
    expect(next.textContent).toBe("Next step");
    expect(getComputedStyle(next).color).toBe(colour);
    if (strong) expect(next.querySelector("strong")?.textContent).toBe("Next step");
  } finally {
    await act(async () => root.unmount());
    style.remove();
    dom.remove();
  }
});

it.each(["flow", "horizon"] as const)(
  "keeps coarse section evidence on the %s lens",
  async (view) => {
    const body = mixedSnapshot(mixed);
    watchStore.setState({ snapshot: { cursor: 1, body } });
    const dom = document.createElement("div");
    const root = createRoot(dom);
    try {
      await act(async () => root.render(view === "flow" ? <Flow /> : <Horizon />));
      expectEvidenceMarks(dom, body, {
        sections:
          view === "flow"
            ? [
                ["/briefing/flow/mode", "/briefing/flow/headline", "/briefing/flow/sub"],
                ["/briefing/flow/tiles"],
                ["/briefing/flow/rows"],
                ["/briefing/flow/next", "/briefing/flow/also", "/briefing/flow/schedule"],
              ]
            : [["/briefing/horizon"], ["/briefing/themes"]],
      });
      await act(async () => watchStore.setState({ snapshot: { cursor: 2, body: snapshot } }));
      expectNoEvidenceMarks(dom);
    } finally {
      await act(async () => root.unmount());
    }
  },
);
