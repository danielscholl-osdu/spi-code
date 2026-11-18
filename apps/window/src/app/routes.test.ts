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
  ["#engineering-system", { kind: "engineering-system" }, "Template"],
  ["#security", { kind: "security" }, "Security"],
  ["#service/legal", { kind: "service", id: "legal" }, "legal"],
  ["#service/crs-catalog", { kind: "service", id: "crs-catalog" }, "crs-catalog"],
  ["#service/legal/overview", { kind: "service", id: "legal", tab: "overview" }, "legal"],
  [
    "#service/search/overview/can%3Areleases%3Ahttps%3A%2F%2Fgithub.com%2Fo%2Fr%2Fpull%2F29",
    {
      kind: "service",
      id: "search",
      tab: "overview",
      row: "can:releases:https://github.com/o/r/pull/29",
    },
    "search",
  ],
  ["#environment", { kind: "environment" }, "Environment"],
  ["#releases", { kind: "releases" }, "Releases"],
  ["#release/2026-10", { kind: "release", month: "2026-10" }, "Release 2026-10"],
  ["#evidence", { kind: "evidence" }, "Evidence"],
  [
    "#evidence?from=service%2Flegal&sel=item%7Egate2%3Astorage",
    {
      kind: "evidence",
      from: { kind: "service", id: "legal" },
      selection: { kind: "item", id: "gate2:storage" },
    },
    "Evidence",
  ],
  [
    "#evidence?from=today&sel=line%7Ewaiting%3Aupgrade%3Aos-core-common",
    {
      kind: "evidence",
      from: { kind: "today" },
      selection: { kind: "line", id: "waiting:upgrade:os-core-common" },
    },
    "Evidence",
  ],
  [
    "#evidence?from=environment&sel=item%7Egate2%3Astorage&open=cell%7Estorage%3Async&sheet=line%7Esync",
    {
      kind: "evidence",
      from: { kind: "environment" },
      selection: { kind: "item", id: "gate2:storage" },
      open: { kind: "cell", id: "storage:sync" },
      sheet: { column: "sync" },
    },
    "Evidence",
  ],
  [
    "#evidence?from=environment&open=cell%7Estorage%3Async&about=item%7Egate2%3Astorage&sheet=line%7Esync",
    {
      kind: "evidence",
      from: { kind: "environment" },
      open: { kind: "cell", id: "storage:sync" },
      about: { kind: "item", id: "gate2:storage" },
      sheet: { column: "sync" },
    },
    "Evidence",
  ],
  [
    "#evidence?from=today&open=line%7Ewaiting%3Aradar%3Apartition&sheet=line",
    {
      kind: "evidence",
      from: { kind: "today" },
      open: { kind: "line", id: "waiting:radar:partition" },
      sheet: {},
    },
    "Evidence",
  ],
])("parses %s and writes it back", (hash, route, label) => {
  expect(parseRoute(hash)).toEqual(route);
  expect(parseRoute(hash.slice(1))).toEqual(route);
  expect(routeHash(route)).toBe(hash);
  expect(routeLabel(route)).toBe(label);
});

it("reads an Evidence hash that names no page or selection as the whole sweep", () => {
  expect(parseRoute("#evidence?from=evidence&sel=cell~legal")).toEqual({ kind: "evidence" });
  expect(parseRoute("#evidence?from=nowhere")).toEqual({ kind: "evidence" });
  expect(parseRoute("#evidence?sheet=pins&open=~x")).toEqual({ kind: "evidence" });
  expect(parseRoute("#evidence?sheet=line~lane")).toEqual({ kind: "evidence" });
  expect(parseRoute("#evidence?about=item~gate2:storage")).toEqual({ kind: "evidence" });
  expect(parseRoute("#evidence?open=line~w&about=item~gate2:storage")).toEqual({
    kind: "evidence",
    open: { kind: "line", id: "w" },
  });
  expect(parseRoute("#evidence?open=cell~storage:sync&about=cell~x")).toEqual({
    kind: "evidence",
    open: { kind: "cell", id: "storage:sync" },
  });
  expect(parseRoute("#evidence/extra")).toBeUndefined();
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

it.each(["flow", "repositories", "horizon"])("retires the %s lens hash", (lens) => {
  expect(Object.keys(DEFAULT_REGISTRY.views)).not.toContain("lens");
  expect(parseRoute(`#lens/${lens}`)).toBeUndefined();
  expect(resolveRoute(`#lens/${lens}`, DEFAULT_REGISTRY)).toEqual({ kind: "today" });
});

it.each([
  "",
  "#",
  "#inbox",
  "#flow",
  "#service",
  "#service/",
  "#service/Legal",
  "#service/a/B",
  "#service/a//row",
  "#service/a/overview/",
  "#service/a/overview/row/extra",
  "#service/%E0%A4%A",
  "#release/2026-13",
  "#release/2026-1",
  "#release/latest",
  "#lens/today",
  "#lens",
  "#setup",
  "#setup/extra",
  "#today/extra",
  "#line",
  "#constructor",
])("names no route for %j", (hash) => {
  expect(parseRoute(hash)).toBeUndefined();
});
