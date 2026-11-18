// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ServiceAlertRow, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import recorded from "../../../../../fixtures/watch/snapshot-1106.json?raw";
import { Security } from "./security.js";

const url = "https://github.com/Azure/osdu-spi-storage/security/code-scanning";
const row = (id: string, numbers: number[]): ServiceAlertRow => ({
  id,
  source: "code",
  group: "spi",
  severity: "high",
  title: `Rule ${id}`,
  alerts: numbers.map((number, index) => ({
    number,
    severity: index === 0 ? "high" : "medium",
    url: `${url}/${number}`,
  })),
});

let unmount = async () => {};
afterEach(() => unmount());

it("opens a grouped count pill into exactly its group's alert pills and closes it again", async () => {
  const snapshot = ViewSnapshotSchema.parse(JSON.parse(recorded));
  const service = snapshot.services?.find((entry) => entry.service === "storage");
  const home = service?.home;
  if (!service?.upstreamSecurity || !home) throw new Error("storage lists missing");
  service.upstreamSecurity.security = {
    count: 5,
    dependabot: { read: true },
    code: { read: true },
    rows: [row("spi:a", [3, 2]), row("spi:b", [9, 8, 7])],
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(<Security id="storage" home={home} snapshot={snapshot} row={undefined} />),
  );
  unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  const pills = () =>
    [...container.querySelectorAll(".service-alert-open .kit-link")].map(
      (pill) => pill.textContent,
    );
  const toggle = (id: string) =>
    container.querySelector<HTMLButtonElement>(`[data-alert-row="spi:${id}"] .service-alert-count`);

  expect(pills()).toEqual([]);
  await act(async () => toggle("b")?.click());
  expect(toggle("b")?.getAttribute("aria-expanded")).toBe("true");
  expect(pills()).toEqual(["CodeQL #9 · High↗", "CodeQL #8 · Medium↗", "CodeQL #7 · Medium↗"]);
  await act(async () => toggle("b")?.click());
  expect(pills()).toEqual([]);
  expect(toggle("b")?.getAttribute("aria-expanded")).toBe("false");
});
