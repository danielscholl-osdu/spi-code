// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, it } from "vitest";
import { parseRoute, type Route, routeHash, routeLabel } from "./routes.js";

it.each<[string, Route, string]>([
  ["#inbox", { kind: "inbox" }, "Inbox"],
  ["#service/legal", { kind: "service", id: "legal" }, "legal"],
  ["#service/crs-catalog", { kind: "service", id: "crs-catalog" }, "crs-catalog"],
  ["#template", { kind: "template" }, "Template"],
  ["#environment", { kind: "environment" }, "Environment"],
  ["#releases", { kind: "releases" }, "Releases"],
  ["#release/2026-10", { kind: "release", month: "2026-10" }, "Release 2026-10"],
  ["#lens/flow", { kind: "lens", lens: "flow" }, "Flow"],
  ["#lens/repositories", { kind: "lens", lens: "repositories" }, "Repositories"],
  ["#lens/horizon", { kind: "lens", lens: "horizon" }, "Horizon"],
  ["#setup", { kind: "setup" }, "Setup"],
])("parses %s and writes it back", (hash, route, label) => {
  expect(parseRoute(hash)).toEqual(route);
  expect(parseRoute(hash.slice(1))).toEqual(route);
  expect(routeHash(route)).toBe(hash);
  expect(routeLabel(route)).toBe(label);
});

it("decodes an encoded service id", () => {
  expect(parseRoute("#service/crs%2Dcatalog")).toEqual({ kind: "service", id: "crs-catalog" });
});

it.each([
  "",
  "#",
  "#today",
  "#flow",
  "#service",
  "#service/",
  "#service/Legal",
  "#service/a/b",
  "#service/%E0%A4%A",
  "#release/2026-13",
  "#release/2026-1",
  "#release/latest",
  "#lens/today",
  "#lens",
  "#setup/extra",
])("falls back to the Inbox for %j", (hash) => {
  expect(parseRoute(hash)).toEqual({ kind: "inbox" });
});
