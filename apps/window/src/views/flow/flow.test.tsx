// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROTOCOL_VERSION, type Station, StationsSchema, type UpTone } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import briefing from "../../../../../fixtures/rib-59d6895/oracle/briefing.json?raw";
import consoleHtml from "../../../../../fixtures/rib-59d6895/oracle/console.html?raw";
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
import { paneText } from "../repositories/pane-text.test-helper.js";
import Flow from "./index.js";

const oracle = new DOMParser().parseFromString(consoleHtml, "text/html");
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
const text = (element: Element | null) => element?.textContent?.replace(/\s+/g, " ").trim();
const pane = (view: string) => oracle.querySelector(`[data-view-pane="${view}"]`);
const send = vi.fn();
let previous: Window["spi"];

beforeEach(() => {
  previous = window.spi;
  window.spi = {
    proof: false,
    openExternal: vi.fn(),
    postMessage: send,
    onMessage: () => () => {},
  };
  send.mockClear();
});

afterEach(() => {
  watchStore.getState().clear();
  watchStore.setState({ snapshot: null });
  window.spi = previous;
});

it("draws every service's six stations in oracle order with exact labels, states and tones", () => {
  const dom = document.createElement("div");
  dom.innerHTML = renderToStaticMarkup(<Stations services={snapshot.stations} />);
  const services = dom.querySelectorAll("[data-service]");
  expect(Array.from(services, (row) => row.getAttribute("data-service"))).toEqual(
    lineOracle.services.map((service: { fork: string }) => service.fork),
  );
  services.forEach((service, index) => {
    expect(
      Array.from(service.querySelectorAll("[data-station]"), (station) => ({
        id: station.getAttribute("data-station"),
        state: station.getAttribute("data-state"),
        text: text(station.querySelector("[data-label]")),
      })),
    ).toEqual(
      lineOracle.services[index]?.stations.map(
        (station: { id: string; state: string; text: string }) => ({
          ...station,
        }),
      ),
    );
  });
  expect(
    dom
      .querySelector('[data-service="partition"] [data-station="upstream"]')
      ?.getAttribute("data-tone"),
  ).toBe("neutral");
  expect(
    dom
      .querySelector('[data-service="entitlements"] [data-station="upstream"]')
      ?.getAttribute("data-tone"),
  ).toBe("warn");
  expect(
    dom
      .querySelector('[data-service="partition"] [data-station="lane"]')
      ?.getAttribute("data-tone"),
  ).toBe("bad");
});

it("renders a moving station with the frozen run tone expectation", () => {
  const service = structuredClone(snapshot.stations[0]);
  if (!service) throw new Error("Missing station fixture");
  service.stations[5].state = "moving";
  service.stations[5].text = "Upgrade running";
  const dom = document.createElement("div");
  dom.innerHTML = renderToStaticMarkup(<Stations services={[service]} />);
  expect(
    Array.from(dom.querySelectorAll('[data-station="lane"]'), (station) => ({
      id: station.getAttribute("data-station"),
      state: station.getAttribute("data-state"),
      tone: station.getAttribute("data-tone"),
      text: text(station.querySelector("[data-label]")),
    })),
  ).toEqual([{ id: "lane", state: "moving", tone: "run", text: "Upgrade running" }]);
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
])(
  "matches the rib's flight next colour for $tone, strong=$strong",
  async ({ tone, strong, colour }) => {
    const body = structuredClone(snapshot);
    const row = body.briefing.flow.rows[0];
    if (!row) throw new Error("Missing flow fixture");
    body.briefing.flow.mode = "flight";
    row.next = { text: "Next step", tone, strong };
    watchStore.setState({ snapshot: { cursor: 1, body } });
    const dom = document.createElement("div");
    dom.style.setProperty("--text", "rgb(40, 50, 60)");
    dom.style.setProperty("--text-muted", "rgb(100, 100, 100)");
    dom.style.setProperty("--text-strong", "rgb(10, 20, 30)");
    dom.style.setProperty("--error-text", "rgb(100, 0, 0)");
    dom.style.setProperty("--warning-text", "rgb(100, 80, 0)");
    dom.style.setProperty("--success-text", "rgb(0, 100, 0)");
    dom.style.setProperty("--accent-text", "rgb(0, 0, 100)");
    const style = document.createElement("style");
    style.textContent = stationStyles;
    document.head.append(style);
    document.body.append(dom);
    const root = createRoot(dom);
    try {
      await act(async () => root.render(<Flow />));
      const next = dom.querySelector(`tr[data-up="${row.fork}"] td:last-child`);
      if (!next) throw new Error("Missing flight next cell");
      expect(next.textContent).toBe("Next step");
      expect(getComputedStyle(next).color).toBe(colour);
      if (strong) {
        const emphasis = next.querySelector("strong");
        if (!emphasis) throw new Error("Missing next-cell emphasis");
        expect(getComputedStyle(emphasis).color).toBe(colour);
      }
    } finally {
      await act(async () => root.unmount());
      style.remove();
      dom.remove();
    }
  },
);

it.each(["flow", "horizon"])("%s renders the oracle pane's exact text", async (view) => {
  watchStore.setState({ snapshot: { cursor: 1, body: snapshot } });
  const dom = document.createElement("div");
  const root = createRoot(dom);
  try {
    await act(async () => root.render(view === "flow" ? <Flow /> : <Horizon />));
    const actual = dom.querySelector(`[data-view-pane="${view}"]`);
    expect(actual).not.toBeNull();
    expect(paneText(actual)).toBe(paneText(pane(view)));
  } finally {
    await act(async () => root.unmount());
  }
});

it("leaves running tiles and detail titles uncoloured without stripping running line tones", async () => {
  const body = structuredClone(snapshot);
  const tile = body.briefing.flow.tiles[0];
  const row = body.briefing.flow.rows[0];
  if (!tile || !row) throw new Error("Missing flow fixture");
  tile.tone = "run";
  row.next.tone = "run";
  row.ready.tone = "run";
  watchStore.setState({ snapshot: { cursor: 1, body } });
  const dom = document.createElement("div");
  const root = createRoot(dom);
  try {
    await act(async () => root.render(<Flow />));
    expect(dom.querySelector(".watch-tile")?.getAttribute("data-tone")).toBe("neutral");
    expect(dom.querySelector(`[data-up-detail="${row.fork}"] h3`)?.getAttribute("data-tone")).toBe(
      "neutral",
    );
    expect(dom.querySelector(`tr[data-up="${row.fork}"] td[data-tone="run"]`)).not.toBeNull();
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
    expect(send).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        version: PROTOCOL_VERSION,
        kind: "request",
        type: "inspect.request",
        payload: { id: "upstream:entitlements" },
      }),
    );
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
    expect(send).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        version: PROTOCOL_VERSION,
        kind: "request",
        type: "inspect.request",
        payload: { id: "mr:legal:756" },
      }),
    );
    expect(send).toHaveBeenCalledTimes(2);
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

async function mounted(view: React.ReactNode, body = snapshot) {
  watchStore.setState({ snapshot: { cursor: 1, body } });
  const dom = document.createElement("div");
  const root = createRoot(dom);
  await act(async () => root.render(view));
  return { dom, unmount: () => act(async () => root.unmount()) };
}

it("badges flow and every service's stations by area and marks the lifecycle-only lane stations", async () => {
  const body = mixedSnapshot(mixed);
  const { dom, unmount } = await mounted(<Flow />, body);
  try {
    expectEvidenceMarks(dom, body, {
      prefixes: ["/briefing/flow", "/stations"],
      // The oracle is planning: the mode only picks the layout, and next is not drawn.
      skip: ["/briefing/flow/mode", "/briefing/flow/next"],
      sections: [
        ["/briefing/flow/mode", "/briefing/flow/headline", "/briefing/flow/sub"],
        ["/briefing/flow/tiles"],
        ["/briefing/flow/rows"],
        ["/briefing/flow/plan", "/briefing/flow/schedule"],
        ...body.stations.map((_, row) => [`/stations/${row}`]),
      ],
    });
    expect(
      [...dom.querySelectorAll('[data-station="lane"]')].map(
        (station) => station.querySelector("[data-inferred]") !== null,
      ),
    ).toEqual(body.stations.map(() => true));
    expect(dom.querySelectorAll("li[data-station] [data-inferred]").length).toBe(
      body.stations.length,
    );
  } finally {
    await unmount();
  }
});

it("badges horizon sections by area and marks a theme fed only by inferred areas", async () => {
  const body = mixedSnapshot(mixed, [{ path: "/briefing/themes/1", areas: ["lifecycle"] }]);
  const { dom, unmount } = await mounted(<Horizon />, body);
  try {
    expectEvidenceMarks(dom, body, {
      prefixes: ["/briefing/horizon", "/briefing/themes"],
      sections: [["/briefing/horizon"], ["/briefing/themes"]],
    });
    expect(dom.querySelectorAll('[data-pointer="/briefing/themes/1"] [data-inferred]').length).toBe(
      2,
    );
  } finally {
    await unmount();
  }
});

it.each([
  ["flow", <Flow key="f" />],
  ["horizon", <Horizon key="h" />],
] as const)("draws no envelope or marker on the plain %s fixture", async (_, view) => {
  const { dom, unmount } = await mounted(view);
  try {
    expectNoEvidenceMarks(dom);
  } finally {
    await unmount();
  }
});
