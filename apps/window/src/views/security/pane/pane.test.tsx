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
import Security from "../index.js";
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

it.each<[string, () => ViewSnapshot | undefined]>([
  ["no list read", () => parse(november)],
  ["a snapshot with no pane", withoutPane],
  ["no snapshot", () => undefined],
])("draws what the Security place draws with %s", async (_name, body) => {
  const snapshot = body();
  if (snapshot?.security) expect(snapshot.security.read).toBe(false);
  watchStore.setState({ snapshot: snapshot ? { cursor: snapshot.cursor, body: snapshot } : null });
  const place = await mount(<Security />);
  const pane = await mount(<SecurityPane />);
  expect(pane.innerHTML).toBe(place.innerHTML);
  if (!snapshot) expect(pane.querySelector(".place-headline")).toBeNull();
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
