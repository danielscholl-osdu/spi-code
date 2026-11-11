// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { sep } from "node:path";
import { expect, it } from "vitest";

const src = "apps/window/src";
function leaks(file: string, source: string): boolean {
  if (file === "theme/tokens.css") return false;
  if (file === "views/today/Horizon.tsx" || file === "components/kit/Chip.tsx") return false;
  if (/\.tsx?$/.test(file)) {
    if (file === "views/today/Places.tsx") source = source.replace('.replace(/^⇣\\s*/, "")', "");
    return /⇣|INBOUND_GLYPH|var\(--upstream|tint\s*=\s*["']upstream["']|tone\s*:\s*["']upstream["']|kit-(?:segmented|segment)--upstream/.test(
      source,
    );
  }
  const rules = source.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g);
  for (const [, selector = "", body = ""] of rules) {
    if (!/var\(--upstream/.test(body)) continue;
    if (file === "views/today/horizon.css" && /^\s*\.(today-horizon|horizon-)/.test(selector))
      continue;
    if (
      file === "components/kit/kit.css" &&
      /^\s*\.kit-(chip--upstream|slot--upstream|segmented--upstream|segment--upstream)\b/.test(
        selector,
      )
    )
      continue;
    return true;
  }
  return false;
}
it("reserves upstream tokens and ⇣ for the horizon, upstream chips and upstream-origin waiting slots (O5-1)", () => {
  const files = readdirSync(src, { recursive: true, encoding: "utf8" })
    .map((file) => file.split(sep).join("/"))
    .filter((file) => /\.(tsx?|css)$/.test(file) && !file.includes(".test"));
  expect(files.filter((file) => leaks(file, readFileSync(`${src}/${file}`, "utf8")))).toEqual([]);
  expect(leaks("views/security/security.css", ".security { color: var(--upstream); }")).toBe(true);
  expect(leaks("views/security/index.tsx", "<span>⇣ upstream-owned</span>")).toBe(true);
  expect(leaks("views/line/index.tsx", "<span>{INBOUND_GLYPH}</span>")).toBe(true);
  expect(leaks("views/today/Places.tsx", "<span>⇣ upstream-owned</span>")).toBe(true);
  const kit = readFileSync(`${src}/components/kit/Slot.tsx`, "utf8");
  expect(kit).toContain('state === "waiting" && origin === "upstream"');
});

it.each([
  '<SegmentedBar tint="upstream" />',
  '<StackedBar segments={[{ tone: "upstream" }]} />',
  '<div className="kit-segmented--upstream" />',
  '<div className="kit-segment--upstream" />',
])("rejects upstream kit use outside its allowed places: %s", (source) => {
  expect(leaks("views/security/index.tsx", source)).toBe(true);
});

it("limits conveyor compaction to 740 and reveals the stages from the expanded state", () => {
  const css = readFileSync(`${src}/views/today/horizon.css`, "utf8");
  expect(css).toMatch(/@media\s*\(max-width:\s*740px\)/);
  expect(css).toMatch(
    /\.horizon-conveyor\[data-expanded="false"\] \.horizon-stages\s*\{\s*display:\s*none/,
  );
  expect(css).toMatch(/\.horizon-conveyor\[data-expanded="true"\] \.horizon-stages/);
});
