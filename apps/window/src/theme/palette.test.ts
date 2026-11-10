// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT
/// <reference types="node" />

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type Appearance,
  minimumCvdDistance,
  validateCategoricalPalette,
  wcagContrast,
} from "./palette.js";

const css = readFileSync("apps/window/src/theme/tokens.css", "utf8");
const design = readFileSync("design/spi-code-visual-design.html", "utf8");
const surfaces = ["chrome", "sidebar", "surface", "surface-raised"];
const textRoles = [
  "text",
  "text-strong",
  "text-muted",
  "placeholder",
  "accent-text",
  "error-text",
  "warning-text",
  "success-text",
  "agent-text",
  "upstream-text",
];

function tokens(mode: Appearance): Record<string, string> {
  const block = css.match(new RegExp(`:root\\[data-theme="${mode}"\\] \\{([^}]+)\\}`))?.[1];
  if (!block) throw new Error(`missing ${mode} tokens`);
  return Object.fromEntries(
    [...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/g)].map(([, role, value]) => [role, value]),
  );
}

function value(theme: Record<string, string>, role: string): string {
  const color = theme[role];
  if (!color) throw new Error(`missing token ${role}`);
  return color;
}

function textFailures(theme: Record<string, string>): string[] {
  return textRoles.flatMap((role) =>
    surfaces.flatMap((surface) => {
      const ratio = wcagContrast(value(theme, role), value(theme, surface));
      return ratio >= 4.5 ? [] : [`${role} on ${surface}: ${ratio.toFixed(2)}`];
    }),
  );
}

describe.each(["light", "dark"] as const)("Shore %s", (mode) => {
  const theme = tokens(mode);

  it("meets AA for every text role on all four surfaces and badge pairs", () => {
    expect(textFailures(theme)).toEqual([]);
    for (const role of ["accent", "error", "warning", "upstream"]) {
      expect(
        wcagContrast(value(theme, "on-fill"), value(theme, `${role}-text`)),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        wcagContrast(value(theme, `${role}-text`), value(theme, `${role}-surface`)),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("distinguishes upstream from every other palette role under CVD", () => {
    for (const [role, color] of Object.entries(theme)) {
      if (role.startsWith("upstream")) continue;
      for (const variant of ["upstream", "upstream-text"]) {
        expect(
          minimumCvdDistance(value(theme, variant), color),
          `${variant} versus ${role}`,
        ).toBeGreaterThanOrEqual(12);
      }
    }
    expect(minimumCvdDistance(value(theme, "upstream"), value(theme, "upstream"))).toBe(0);
  });

  it("matches the visual design role table and Appendix B text variants", () => {
    const table = design.slice(
      design.indexOf("<h2>Shore in semantic roles"),
      design.indexOf('<div class="swatches">', design.indexOf("<h2>Shore in semantic roles")),
    );
    for (const row of table.matchAll(/<tr><td><code>(\w+)<\/code>[\s\S]*?<\/tr>/g)) {
      const role = row[1];
      if (!role || !row[0]) throw new Error("invalid design role row");
      const colors = [...row[0].matchAll(/#[0-9a-f]{6}/g)].map(([color]) => color);
      if (colors.length < 2) throw new Error(`missing design colors for ${role}`);
      const cssRole = role.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      const index = mode === "light" ? 0 : 1;
      const fillRole = role === "placeholder" ? "placeholder-fill" : cssRole;
      expect(value(theme, fillRole), fillRole).toBe(colors[index]);
      if (colors.length > 2) {
        const textRole = role === "placeholder" ? cssRole : `${cssRole}-text`;
        expect(value(theme, textRole), textRole).toBe(colors[2 + index] ?? colors[1]);
      }
    }
  });

  it("validates the six-color series and rejects indistinguishable marks", () => {
    const series = Array.from({ length: 6 }, (_, i) => value(theme, `chart-${i + 1}`));
    const report = validateCategoricalPalette(series, { mode, surface: value(theme, "surface") });
    expect(report.ok, JSON.stringify(report)).toBe(true);
    const first = value(theme, "chart-1");
    const bad = validateCategoricalPalette([first, first], { mode });
    expect(bad.ok).toBe(false);
    expect(bad.checks).toContainEqual(
      expect.objectContaining({ check: "cvd-separation", status: "fail" }),
    );
  });

  it("fails the same text gate for a planted below-AA variant", () => {
    expect(textFailures({ ...theme, placeholder: value(theme, "placeholder-fill") })).toHaveLength(
      4,
    );
  });
});
