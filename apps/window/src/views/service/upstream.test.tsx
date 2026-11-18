// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import recorded from "../../../../../fixtures/watch/snapshot-1106.json?raw";
import { Upstream } from "./upstream.js";

let unmount = async () => {};
afterEach(() => unmount());

it.each([true, false])("an empty open list is empty only when read (read: %s)", async (read) => {
  const snapshot = ViewSnapshotSchema.parse(JSON.parse(recorded));
  const service = snapshot.services?.find((entry) => entry.service === "storage");
  const home = service?.home;
  if (!service?.upstreamSecurity || !home) throw new Error("storage lists missing");
  service.upstreamSecurity.upstream.open = {
    read,
    at: "2026-11-05T14:00:00.000Z",
    list: { total: 0, shown: [], drafts: 0, idle: 0 },
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(<Upstream id="storage" home={home} snapshot={snapshot} row={undefined} />),
  );
  unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  const section = container.querySelector("[data-section=open-upstream]");
  expect(section?.querySelector(".service-section-count")?.textContent).toBe(
    read ? "0" : undefined,
  );
  expect(section?.querySelector(".service-list-empty") !== null).toBe(read);
  expect(section?.querySelector("[data-unread]") !== null).toBe(!read);
});
