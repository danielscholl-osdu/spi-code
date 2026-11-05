// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type Station, StationsSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import briefing from "../../../../../fixtures/rib-59d6895/oracle/briefing.json?raw";
import consoleHtml from "../../../../../fixtures/rib-59d6895/oracle/console.html?raw";
import lines from "../../../../../fixtures/rib-59d6895/oracle/lines.json?raw";
import { Stations } from "../../components/stations/index.js";
import { testSnapshot } from "../../store/test-snapshot.js";
import { watchStore } from "../../store/watch.js";
import Horizon from "../horizon/index.js";
import Flow from "./index.js";

const oracle = new DOMParser().parseFromString(consoleHtml, "text/html");
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
const text = (element: Element | null) => element?.textContent?.replace(/\s+/g, " ").trim();
const pane = (view: string) => oracle.querySelector(`[data-view-pane="${view}"]`);

afterEach(() => watchStore.setState({ snapshot: null, selection: null }));

it("draws every service's six stations in oracle order with exact labels, states and tones", () => {
  const dom = document.createElement("div");
  dom.innerHTML = renderToStaticMarkup(<Stations services={snapshot.stations} />);
  const services = dom.querySelectorAll("[data-service]");
  expect(Array.from(services, (row) => row.getAttribute("data-service"))).toEqual(
    lineOracle.services.map((service: { fork: string }) => service.fork),
  );
  const tones: Record<string, string> = {
    idle: "neutral",
    moving: "run",
    waiting: "warn",
    stopped: "bad",
    unknown: "neutral",
  };
  services.forEach((service, index) => {
    expect(
      Array.from(service.querySelectorAll("[data-station]"), (station) => ({
        id: station.getAttribute("data-station"),
        state: station.getAttribute("data-state"),
        text: text(station.querySelector("[data-label]")),
        tone: station.getAttribute("data-tone"),
      })),
    ).toEqual(
      lineOracle.services[index]?.stations.map(
        (station: { id: string; state: string; text: string }) => ({
          ...station,
          tone: tones[station.state],
        }),
      ),
    );
  });
});

it.each(["flow", "horizon"])("%s renders the oracle pane's exact text", async (view) => {
  watchStore.setState({ snapshot: { cursor: 1, body: snapshot } });
  const dom = document.createElement("div");
  const root = createRoot(dom);
  try {
    await act(async () => root.render(view === "flow" ? <Flow /> : <Horizon />));
    const actual = dom.querySelector(`[data-view-pane="${view}"]`);
    expect(actual).not.toBeNull();
    expect(text(actual)?.replace(/\s/g, "")).toBe(text(pane(view))?.replace(/\s/g, ""));
  } finally {
    await act(async () => root.unmount());
  }
});

it("selects fork and theme details and sends their inspector selections", async () => {
  watchStore.setState({ snapshot: { cursor: 1, body: snapshot } });
  const dom = document.createElement("div");
  const root = createRoot(dom);
  const click = async (selector: string) => {
    const button = dom.querySelector<HTMLButtonElement>(selector);
    expect(button).not.toBeNull();
    await act(async () => button?.click());
  };
  try {
    await act(async () => root.render(<Flow />));
    await click('button[data-up="entitlements"]');
    expect(dom.querySelector<HTMLElement>('[data-up-detail="entitlements"]')?.hidden).toBe(false);
    await click('[data-inspect="upstream:entitlements"]');
    expect(watchStore.getState().selection?.id).toBe("upstream:entitlements");
    await click('[data-up-detail="entitlements"] button[data-up="plan"]');
    expect(dom.querySelector<HTMLElement>('[data-up-detail="plan"]')?.hidden).toBe(false);
    await act(async () => root.render(<Horizon />));
    await click('[data-theme-sel="halt:top_level:schemathesis-tests"]');
    expect(
      dom.querySelector<HTMLElement>('[data-theme-detail="halt:top_level:schemathesis-tests"]')
        ?.hidden,
    ).toBe(false);
    await click('[data-inspect="mr:legal:756"]');
    expect(watchStore.getState().selection?.id).toBe("mr:legal:756");
  } finally {
    await act(async () => root.unmount());
  }
});

it("renders flight columns and next-step detail and falls back when a selected row disappears", async () => {
  const flight = structuredClone(snapshot);
  flight.briefing.flow.mode = "flight";
  flight.briefing.flow.also = [{ text: "Another gate", inspect: "gate1:legal" }];
  watchStore.setState({ snapshot: { cursor: 1, body: flight } });
  const dom = document.createElement("div");
  const root = createRoot(dom);
  try {
    await act(async () => root.render(<Flow />));
    expect(Array.from(dom.querySelectorAll("thead th"), text)).toEqual([
      "Fork",
      ...lineOracle.columns,
      "Next",
    ]);
    expect(text(dom.querySelector('[data-up-detail="plan"] h3'))).toBe(
      flight.briefing.flow.next.title,
    );
    await act(async () => dom.querySelector<HTMLButtonElement>('button[data-up="legal"]')?.click());
    await act(async () => {
      flight.briefing.flow.rows = [];
      watchStore.setState({ snapshot: { cursor: 2, body: structuredClone(flight) } });
    });
    expect(dom.querySelector<HTMLElement>('[data-up-detail="plan"]')?.hidden).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
});

it("shows a waiting state before a snapshot and tolerates empty themes", async () => {
  expect(renderToStaticMarkup(<Flow />)).toContain("Waiting for a Watch snapshot");
  expect(renderToStaticMarkup(<Horizon />)).toContain("Waiting for a Watch snapshot");
  const empty = structuredClone(snapshot);
  empty.briefing.themes = [];
  watchStore.setState({ snapshot: { cursor: 1, body: empty } });
  const dom = document.createElement("div");
  const root = createRoot(dom);
  try {
    await act(async () => root.render(<Horizon />));
    expect(text(dom.querySelector("h2"))).toBe(empty.briefing.horizon.headline);
    expect(dom.querySelector("[data-theme-detail]")).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

it("hides the exposure list for a theme with no forks, as the rib console does", async () => {
  const bare = structuredClone(snapshot);
  const theme = bare.briefing.themes[0];
  if (!theme) throw new Error("Missing theme fixture");
  theme.certain = [];
  theme.possible = [];
  watchStore.setState({ snapshot: { cursor: 1, body: bare } });
  const dom = document.createElement("div");
  const root = createRoot(dom);
  try {
    await act(async () => root.render(<Horizon />));
    const detail = dom.querySelector(`[data-theme-detail="${theme.id}"]`);
    expect(text(detail?.querySelector("h3") ?? null)).toBe(theme.title);
    expect(detail?.textContent).not.toContain("Exposure by fork");
    expect(detail?.querySelector("ul")).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});
