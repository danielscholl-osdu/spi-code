// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import recorded from "../../../../../fixtures/watch/snapshot-59d6895.json?raw";
import november from "../../../../../fixtures/watch/snapshot-1106.json?raw";
import { RouteView } from "../../app/routes.js";
import { watchStore } from "../../store/watch.js";
import Security from "./index.js";

const container = document.createElement("div");
let root: ReturnType<typeof createRoot>;
const previous = watchStore.getState();

beforeEach(() => {
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  watchStore.setState(previous);
});

it.each([
  ["the populated security read", recorded],
  ["November's unread security source", november],
])(
  "renders %s through the registered Security place without manufacturing zeroes",
  async (_name, fixture) => {
    const body = ViewSnapshotSchema.parse(JSON.parse(fixture));
    watchStore.setState({ snapshot: { cursor: body.cursor, body } });
    await act(async () => root.render(<RouteView route={{ kind: "security" }} />));
    const reading = body.readings.find(({ anchor }) => anchor.kind === "security")?.content;
    if (!reading) throw new Error("Missing recorded security reading");
    expect(container.querySelector(".place-headline")?.textContent).toBe(reading.headline);
    expect([...container.querySelectorAll(".place-tile")].map((tile) => tile.textContent)).toEqual(
      reading.tiles.map((tile) => `${tile.label}${tile.value}${tile.counts}`),
    );
    expect(container.querySelectorAll(".place-item")).toHaveLength(reading.items.length);
    for (const item of reading.items) {
      const row = container.querySelector(`[data-item-id="${item.id}"]`);
      expect(row?.querySelector(".place-item-title")?.textContent).toBe(item.title);
      expect(row?.querySelector(".place-item-sub")?.textContent).toBe(item.sub);
      expect(row?.querySelector(".place-scope")?.textContent).toBe(item.scope);
      expect(row?.closest(".place-group")?.querySelector("h3")?.textContent).toBe(item.group);
    }
    expect(container.querySelector(".place-folded")?.textContent ?? null).toBe(reading.folded);
    if (fixture === november) {
      expect(
        [...container.querySelectorAll(".place-tile-value")].map((tile) => tile.textContent),
      ).toEqual(["not read yet", "not read yet", "not read yet"]);
      expect(container.querySelector(".place-groups")).toBeNull();
    } else {
      for (const campaign of body.campaigns.filter(({ kind }) => kind === "security")) {
        const row = container.querySelector(`[data-item-id="${campaign.id}"]`);
        expect(row?.querySelector(".place-item-title")?.textContent).toMatch(/^Detected: /);
        expect(row?.querySelector(".place-scope")?.textContent).toBe(
          `${campaign.forks.length} forks`,
        );
      }
    }
    expect(container.textContent).not.toMatch(
      /Threads|composer|not available yet|gate 3|fork_upstream/i,
    );
  },
);

it("shows source qualifiers and removes absent content without leaving empty parts", async () => {
  const body = ViewSnapshotSchema.parse(JSON.parse(recorded));
  const reading = body.readings.find(({ anchor }) => anchor.kind === "security");
  if (!reading?.content) throw new Error("Missing recorded security reading");
  reading.content.qualifier = "One security read failed, so findings could be missing.";
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  await act(async () => root.render(<Security />));
  expect(container.querySelector(".place-qualifier")?.textContent).toBe(reading.content.qualifier);
  reading.content = null;
  await act(async () =>
    watchStore.setState({ snapshot: { cursor: body.cursor + 1, body: structuredClone(body) } }),
  );
  expect(container.querySelector("h1")?.textContent).toBe("Security");
  expect(container.querySelector(".place-reading")).toBeNull();
  expect(container.querySelectorAll("section")).toHaveLength(1);
});
