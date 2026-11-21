// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import november from "../../../../../fixtures/watch/snapshot-1106.json?raw";
import { readFixture } from "../../../../../scripts/watch-generated.mjs";
import { RouteView } from "../../app/routes.js";
import { watchStore } from "../../store/watch.js";
import { watchFixtureText } from "../../test-utils/watch-fixtures.test-helper.js";
import { wordsText } from "./pane/Words.js";

const recorded = watchFixtureText("snapshot-59d6895.json", readFixture);
const parse = (text: string) => ViewSnapshotSchema.parse(JSON.parse(text));

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

async function route(body: ViewSnapshot | undefined) {
  watchStore.setState({ snapshot: body ? { cursor: body.cursor, body } : null });
  await act(async () => root.render(<RouteView route={{ kind: "security" }} />));
}

it("draws the Security page from the pane once a list was read, and none of the reading", async () => {
  const body = parse(recorded);
  if (!body.security?.read) throw new Error("The recorded snapshot read no security list");
  await route(body);
  expect(container.querySelector(".security-pane h1")?.textContent).toBe("Security");
  expect(container.querySelector(".security-headline")?.textContent).toBe(
    `${wordsText(body.security.page.totals)}${wordsText(body.security.page.headline)}`,
  );
  expect(container.querySelector(".place-reading, .place-tile, .place-item")).toBeNull();
});

it("says Security not read from the pane before any list was read, and the title alone with no snapshot", async () => {
  const body = parse(november);
  if (!body.security || body.security.read)
    throw new Error("The 1106 snapshot read a security list");
  await route(body);
  expect(container.querySelector(".security-pane h1")?.textContent).toBe("Security");
  expect(container.querySelector(".security-headline")?.textContent).toBe("Security not read.");
  expect(container.querySelector(".security-banner span")?.textContent).toBe(
    wordsText(body.security.page.banner),
  );
  expect(container.querySelector(".place-reading, .security-figure, [data-fresh-item]")).toBeNull();
  await route(undefined);
  expect(container.querySelector("h1")?.textContent).toBe("Security");
  expect(
    container.querySelector(".place-reading, .security-headline, .security-figure"),
  ).toBeNull();
});
