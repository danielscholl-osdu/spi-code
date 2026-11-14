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

function tokens(mode: Appearance, palette: "warm" | "neutral" = "warm"): Record<string, string> {
  const selector =
    palette === "warm"
      ? `:root[data-theme="${mode}"]`
      : `:root[data-palette="neutral"][data-theme="${mode}"]`;
  const block = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, selectors]) =>
    selectors?.split(",").some((item) => item.trim() === selector),
  )?.[2];
  if (!block) throw new Error(`missing ${palette} ${mode} tokens`);
  return Object.fromEntries(
    [...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, role, value]) => [role, value]),
  );
}

function value(theme: Record<string, string>, role: string): string {
  const color = theme[role];
  if (!color) throw new Error(`missing token ${role}`);
  return color;
}

function textFailures(theme: Record<string, string>): string[] {
  const textRoles = [
    "text",
    "text-strong",
    "text-muted",
    "placeholder",
    "work",
    ...Object.keys(theme).filter((role) => role.endsWith("-text")),
  ];
  return textRoles.flatMap((role) => {
    const tint = `${role.replace(/-text$/, "")}-surface`;
    const backgrounds = tint in theme ? [...surfaces, tint] : surfaces;
    return backgrounds.flatMap((surface) => {
      const ratio = wcagContrast(value(theme, role), value(theme, surface));
      return ratio >= 4.5 ? [] : [`${role} on ${surface}: ${ratio.toFixed(2)}`];
    });
  });
}

describe.each(["warm", "neutral"] as const)("%s", (palette) => {
  describe.each(["light", "dark"] as const)("%s", (mode) => {
    const theme = tokens(mode, palette);

    it("meets AA for every text role on shared surfaces and its own tint", () => {
      expect(textFailures(theme)).toEqual([]);
      for (const role of ["accent", "error", "warning", "upstream"]) {
        expect(
          wcagContrast(value(theme, "on-fill"), value(theme, `${role}-text`)),
        ).toBeGreaterThanOrEqual(4.5);
      }
    });

    it("meets non-text contrast for fills and icons on their own tints", () => {
      for (const textRole of Object.keys(theme).filter((role) => role.endsWith("-text"))) {
        const role = textRole.replace(/-text$/, "");
        const surface = `${role}-surface`;
        if (!(surface in theme)) continue;
        expect(
          wcagContrast(value(theme, role), value(theme, surface)),
          `${role} on ${surface}`,
        ).toBeGreaterThanOrEqual(3);
      }
    });

    it("distinguishes upstream from every other palette role under CVD", () => {
      for (const [role, color] of Object.entries(theme)) {
        if (role.startsWith("upstream")) continue;
        for (const [hex] of color.matchAll(/#[0-9a-f]{6}/g)) {
          for (const variant of ["upstream", "upstream-text"]) {
            expect(
              minimumCvdDistance(value(theme, variant), hex),
              `${variant} versus ${role}`,
            ).toBeGreaterThanOrEqual(12);
          }
        }
      }
      expect(minimumCvdDistance(value(theme, "upstream"), value(theme, "upstream"))).toBe(0);
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
      expect(
        textFailures({ ...theme, placeholder: value(theme, "placeholder-fill") }),
      ).toHaveLength(4);
    });
  });
});

describe.each(["light", "dark"] as const)("Shore design %s", (mode) => {
  const theme = tokens(mode);

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

  it("draws the mockups' work tone from the Warm tokens", () => {
    const rule = design.match(
      new RegExp(
        `^\\.app${mode === "dark" ? "\\.dark" : ""}\\{--a-work:(#[0-9a-f]{6});--a-work-bg:(#[0-9a-f]{6})\\}$`,
        "m",
      ),
    );
    expect(rule?.slice(1)).toEqual([value(theme, "work"), value(theme, "work-surface")]);
  });
});

const NEUTRAL_TABLE = "<h3>Neutral, the default";
const SWATCHES = '<div class="swatches">';
const kebab = (name: string) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
const codes = (html: string) =>
  [...html.matchAll(/<code>([^<]+)<\/code>/g)].map(([, code]) => code);
const hexes = (html: string) => [...html.matchAll(/#[0-9a-f]{6}/g)].map(([color]) => color);

function between(from: string, start: string, end: string): string {
  const at = design.indexOf(from);
  if (at < 0) throw new Error(`missing design section ${from}`);
  const open = design.indexOf(start, at);
  return design.slice(open, design.indexOf(end, open));
}

describe.each(["light", "dark"] as const)("Neutral design %s", (mode) => {
  const theme = tokens(mode, "neutral");
  const index = mode === "light" ? 0 : 1;

  it("matches the visual design role table, its tints and its listed text values", () => {
    const rows = [...between(NEUTRAL_TABLE, "<tbody>", SWATCHES).matchAll(/<tr>[\s\S]*?<\/tr>/g)];
    expect(rows.length).toBeGreaterThan(10);
    for (const [row] of rows) {
      const [roleCell = "", , light = "", dark = "", tint = ""] = [
        ...row.matchAll(/<td>([\s\S]*?)<\/td>/g),
      ].map(([, cell]) => cell ?? "");
      const roles = codes(roleCell).map((role) => kebab(role ?? ""));
      const colors = hexes(index === 0 ? light : dark);
      roles.forEach((role, i) => {
        expect(value(theme, role), role).toBe(colors[i]);
      });
      const [role] = roles;
      if (roles.length !== 1 || !role) continue;
      if (`${role}-text` in theme || colors[1])
        expect(value(theme, `${role}-text`), `${role}-text`).toBe(colors[1] ?? colors[0]);
      const tints = hexes(tint);
      if (tints.length > 0)
        expect(value(theme, `${role}-surface`), `${role}-surface`).toBe(tints[index]);
    }
  });
});

describe.each([
  ["warm", "<h2>Shore in semantic roles"],
  ["neutral", NEUTRAL_TABLE],
] as const)("%s shell states on the design", (palette, heading) => {
  it.each(["light", "dark"] as const)("match tokens.css in %s", (mode) => {
    const theme = tokens(mode, palette);
    const index = mode === "light" ? 0 : 1;
    const prose = between(heading, SWATCHES, "</section>");
    const shell = prose.slice(prose.indexOf("<p>"), prose.indexOf("</p>"));
    const pairs = [
      ...shell.matchAll(
        /<code>([a-z][\w-]*)<\/code>(?:[^<]|<(?!code>))*?<code>(#[0-9a-f]{6})<\/code>[^<]*?<code>(#[0-9a-f]{6})<\/code>/g,
      ),
    ];
    expect(pairs.map(([, role]) => role)).toEqual(
      expect.arrayContaining(["capsule", "hover", "kbd", "active"]),
    );
    for (const [, role = "", light, dark] of pairs)
      expect(value(theme, role), role).toBe(index === 0 ? light : dark);
    const ringed = shell.slice(shell.indexOf("ringed in"));
    const ring = codes(ringed.slice(0, ringed.indexOf(".")))[index] ?? "";
    expect(value(theme, "active-shadow")).toContain(
      ring.startsWith("#") ? ring : value(theme, ring),
    );
  });
});

describe.each(["light", "dark"] as const)("Neutral %s", (mode) => {
  const theme = tokens(mode, "neutral");

  it("defines every Warm token without inheriting palette colours", () => {
    expect(Object.keys(theme).sort()).toEqual(Object.keys(tokens(mode)).sort());
  });
});

describe.each(["warm", "neutral"] as const)("%s shell tokens", (palette) => {
  it.each(["light", "dark"] as const)("supplies the shell roles in %s", (mode) => {
    const theme = tokens(mode, palette);
    for (const role of [
      "work",
      "work-surface",
      "capsule",
      "hover",
      "kbd",
      "active",
      "active-shadow",
      "success-surface",
    ]) {
      expect(value(theme, role).match(/#[0-9a-f]{6}/)).not.toBeNull();
    }
    for (const surface of [
      "capsule",
      "hover",
      "kbd",
      "active",
      "success-surface",
      "work-surface",
    ]) {
      for (const role of ["text", "text-strong"]) {
        expect(
          wcagContrast(value(theme, role), value(theme, surface)),
          `${role} on ${surface}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
