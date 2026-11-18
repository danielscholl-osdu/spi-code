// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { directoryPaths } from "../../test-utils/directory-paths.test.js";

const src = "apps/window/src";
function leaks(file: string, source: string): boolean {
  if (file === "theme/tokens.css") return false;
  if (file === "components/kit/Chip.tsx") return false;
  if (/\.tsx?$/.test(file)) {
    // An MR is GitLab upstream work (X5), so only the MR pill takes the upstream tone.
    if (file === "components/kit/LinkPill.tsx")
      source = source.replace(/^\s*mr:\s*\{[^}]*tone:\s*"upstream"\s*\},?$/m, "");
    return /⇣|INBOUND_GLYPH|var\(--upstream|tint\s*=\s*["']upstream["']|tone\s*:\s*["']upstream["']|kit-(?:segmented|segment)--upstream/.test(
      source,
    );
  }
  const rules = source.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g);
  for (const [, selector = "", body = ""] of rules) {
    if (!/var\(--upstream/.test(body)) continue;
    if (
      file === "components/sidebar/sidebar.css" &&
      /^\s*\.sidebar-mark\[data-mark="clock"\]\s*$/.test(selector)
    )
      continue;
    if (
      file === "components/kit/kit.css" &&
      /^\s*\.kit-(chip--upstream|slot--upstream|segmented--upstream|segment--upstream|link--upstream)\b/.test(
        selector,
      )
    )
      continue;
    return true;
  }
  return false;
}
it("reserves upstream tokens and ⇣ for upstream chips, upstream-origin waiting slots and next sync (O5-1)", () => {
  const files = directoryPaths(src).filter(
    (file) => /\.(tsx?|css)$/.test(file) && !file.includes(".test"),
  );
  expect(files.filter((file) => leaks(file, readFileSync(`${src}/${file}`, "utf8")))).toEqual([]);
  expect(leaks("views/security/security.css", ".security { color: var(--upstream); }")).toBe(true);
  expect(leaks("views/security/index.tsx", "<span>⇣ upstream-owned</span>")).toBe(true);
  expect(leaks("views/today/Forks.tsx", "<span>{INBOUND_GLYPH}</span>")).toBe(true);
  expect(leaks("views/today/Table.tsx", "<span>⇣ upstream-owned</span>")).toBe(true);
  expect(
    leaks("components/kit/LinkPill.tsx", '  pr: { icon: "pullRequest", tone: "upstream" },'),
  ).toBe(true);
  for (const selector of [
    ".sidebar-sweep",
    ".sidebar-sweep:hover",
    ".capsule-sweep-text",
    ".capsule-popup",
  ])
    expect(
      leaks(
        "components/capsule/capsule.css",
        `${selector} { background: var(--upstream-surface); }`,
      ),
      selector,
    ).toBe(true);
  for (const selector of [
    ".sidebar-mark",
    '.sidebar-mark[data-mark="count"]',
    '.sidebar-mark[data-mark="clock"]:hover',
    '.sidebar-mark[data-mark="clock"], .sidebar-word',
    ".sidebar-status-dot",
    ".sidebar-toggle-dot",
    ".sidebar-word",
  ])
    expect(
      leaks("components/sidebar/sidebar.css", `${selector} { color: var(--upstream-text); }`),
      selector,
    ).toBe(true);
  expect(
    leaks(
      "components/sidebar/sidebar.css",
      '.sidebar-mark[data-mark="clock"] { color: var(--upstream-text); }',
    ),
  ).toBe(false);
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
