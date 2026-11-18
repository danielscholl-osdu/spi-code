// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, it } from "vitest";
import { assertSidebarHover, type SidebarMark, type SidebarRow } from "./smoke-sidebar.js";

const mark = (kind: string, text: string, x = 190): SidebarMark => ({
  kind,
  text,
  box: { x, y: 120, width: 40, height: 17 },
});
const same = (row: string, group: SidebarRow["group"], marks: SidebarMark[]): SidebarRow => ({
  row,
  group,
  rest: marks,
  hover: marks,
});
const rows: SidebarRow[] = [
  same("line", "fixed", [mark("sidebar-mark", "1", 170), mark("sidebar-mark", "13")]),
  same("service/entitlements", "pinned", [mark("sidebar-mark", "2")]),
  same("releases", "pinned", []),
];
const hovered = (row: string, hover: SidebarMark[]) =>
  rows.map((item) => (item.row === row ? { ...item, hover } : item));

it("accepts rows whose marks and words keep their box when hovered", () => {
  expect(() => assertSidebarHover(rows)).not.toThrow();
});

it("rejects the old hover hide, a mark that moves, and a mark drawn only on hover", () => {
  expect(() => assertSidebarHover(hovered("service/entitlements", []))).toThrow(
    'Sidebar hover: service/entitlements hides sidebar-mark "2"',
  );
  expect(() =>
    assertSidebarHover(
      hovered("line", [mark("sidebar-mark", "1", 170), mark("sidebar-mark", "13", 166)]),
    ),
  ).toThrow('line moves sidebar-mark "13" from 190,120 40x17 to 166,120 40x17');
  expect(() => assertSidebarHover(hovered("releases", [mark("sidebar-mark", "check")]))).toThrow(
    'releases draws sidebar-mark "check" only on hover',
  );
});

it("needs fixed rows and Pinned rows with and without a mark to prove anything", () => {
  expect(() => assertSidebarHover(rows.filter(({ group }) => group === "pinned"))).toThrow(
    "needs fixed and Pinned rows",
  );
  expect(() =>
    assertSidebarHover(rows.filter(({ row }) => row !== "service/entitlements")),
  ).toThrow("needs a Pinned row that draws a mark or word");
  expect(() => assertSidebarHover(rows.filter(({ row }) => row !== "releases"))).toThrow(
    "needs a Pinned row that draws none",
  );
});
