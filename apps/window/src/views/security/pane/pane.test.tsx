// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import november from "../../../../../../fixtures/watch/snapshot-1106.json?raw";
import { readFixture } from "../../../../../../scripts/watch-generated.mjs";
import { watchStore } from "../../../store/watch.js";
import { watchFixtureText } from "../../../test-utils/watch-fixtures.test-helper.js";
import { SecurityPane } from "./Pane.js";

const recorded = watchFixtureText("snapshot-59d6895.json", readFixture);
const previous = watchStore.getState();
const cleanups: (() => Promise<void>)[] = [];

async function mount(content: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(content));
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return container;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  watchStore.setState(previous);
});

const parse = (text: string) => ViewSnapshotSchema.parse(JSON.parse(text));
const withoutPane = () => {
  const { security: _, ...body } = parse(recorded);
  return body;
};

it.each<[string, () => ViewSnapshot | undefined, string | null]>([
  ["no list read", () => parse(november), "Security not read."],
  ["a snapshot with no pane", withoutPane, null],
  ["no snapshot", () => undefined, null],
])("draws the title and only the pane's own words with %s", async (_name, body, headline) => {
  const snapshot = body();
  if (snapshot?.security) expect(snapshot.security.read).toBe(false);
  watchStore.setState({ snapshot: snapshot ? { cursor: snapshot.cursor, body: snapshot } : null });
  const pane = await mount(<SecurityPane />);
  expect(pane.querySelector("h1[data-place]")?.textContent).toBe("Security");
  expect(pane.querySelector(".security-headline")?.textContent ?? null).toBe(headline);
  expect(
    pane.querySelector(".place-reading, .place-tile, .place-item, [data-fresh-item]"),
  ).toBeNull();
  expect(pane.querySelector(".security-figure, .security-views")).toBeNull();
});

it("draws the frame once a list was read, with the switch in the pane's words", async () => {
  const read = parse(recorded).security;
  if (!read?.read) throw new Error("The recorded snapshot read no security list");
  const pane = { ...read, views: { rule: "Rules", repository: "Repos" } };
  const container = await mount(<SecurityPane pane={pane} />);
  expect(container.querySelector(".place-headline")).toBeNull();
  expect(
    [...container.querySelectorAll(".security-views button")].map((b) => b.textContent),
  ).toEqual(["Rules", "Repos"]);
});
