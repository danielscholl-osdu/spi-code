// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, it } from "vitest";
import {
  DEFAULT_REGISTRY,
  parseRoute,
  type Route,
  resolveRoute,
  routeHash,
  routeLabel,
} from "./routes.js";

it.each<[string, Route, string]>([
  ["#today", { kind: "today" }, "Today"],
  ["#upstream", { kind: "upstream" }, "Upstream"],
  ["#engineering-system", { kind: "engineering-system" }, "Engineering system"],
  ["#security", { kind: "security" }, "Security"],
  ["#service/legal", { kind: "service", id: "legal" }, "legal"],
  ["#service/crs-catalog", { kind: "service", id: "crs-catalog" }, "crs-catalog"],
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

it("still reads the old #template hash as the engineering system", () => {
  expect(parseRoute("#template")).toEqual({ kind: "engineering-system" });
  expect(parseRoute("#template/extra")).toBeUndefined();
});

it("retires Inbox and falls back to Today for a fresh launch or an old saved Inbox", () => {
  expect(Object.keys(DEFAULT_REGISTRY.views)).not.toContain("inbox");
  expect(DEFAULT_REGISTRY.fallback).toEqual({ kind: "today" });
  for (const hash of ["", "#inbox", "#unknown"]) {
    expect(resolveRoute(hash, DEFAULT_REGISTRY)).toEqual({ kind: "today" });
  }
});

it.each([
  "",
  "#",
  "#inbox",
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
  "#today/extra",
  "#line",
  "#constructor",
])("names no route for %j", (hash) => {
  expect(parseRoute(hash)).toBeUndefined();
});
