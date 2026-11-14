// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, it } from "vitest";
import {
  assertContrast,
  type Collected,
  type ContrastReport,
  composite,
  EXCLUSIONS,
  judge,
  type Layer,
  parseColor,
} from "./smoke-contrast.js";

const layer = (background: string, extra: Partial<Layer> = {}): Layer => ({
  background,
  image: "none",
  opacity: 1,
  filter: "none",
  blend: "normal",
  ...extra,
});

const sample = (layers: Layer[], color: string, size = 12, weight = 400): Collected => ({
  layers,
  samples: [
    {
      selector: "span.kit-chip",
      text: "Verify",
      color,
      size,
      weight,
      layers: layers.map((_, index) => index),
      inScope: true,
    },
  ],
  excluded: {},
  examples: {},
  unmeasured: [],
});

it.each([
  ["rgb(21, 124, 59)", [21 / 255, 124 / 255, 59 / 255, 1]],
  ["rgba(0, 0, 0, 0.05)", [0, 0, 0, 0.05]],
  ["rgb(255 255 255 / 50%)", [1, 1, 1, 0.5]],
  ["color(srgb 0.5 0.25 1)", [0.5, 0.25, 1, 1]],
  ["color(srgb 0.5 0.25 1 / 0.6)", [0.5, 0.25, 1, 0.6]],
  ["oklab(1 0 0)", [1, 1, 1, 1]],
  ["oklch(0 0 0 / 0.2)", [0, 0, 0, 0.2]],
])("reads the computed colour %s", (value, expected) => {
  const parsed = parseColor(value);
  expect(parsed).toHaveLength(4);
  parsed?.forEach((channel, index) => {
    expect(channel).toBeCloseTo(expected[index] ?? Number.NaN, 4);
  });
});

it.each(["color(display-p3 1 0 0)", "lab(50 20 20)", "currentcolor", "url(#paint)", "none"])(
  "reads %s as no colour rather than guessing",
  (value) => {
    expect(parseColor(value)).toBeUndefined();
  },
);

it("fails --success-text on a 16% color-mix tint of --success, and passes it on --success-surface", () => {
  const tint = judge(
    sample(
      [layer("rgb(255, 255, 255)"), layer("color(srgb 0.85318 0.920314 0.878275)")],
      "rgb(21, 124, 59)",
    ),
  ).judged[0];
  expect(tint?.background).toBe("#daebe0");
  expect(tint?.ratio).toBeLessThan(4.5);
  expect(tint?.needs).toBe(4.5);
  const surface = judge(
    sample([layer("rgb(255, 255, 255)"), layer("rgb(227, 245, 232)")], "rgb(21, 124, 59)"),
  ).judged[0];
  expect(surface?.ratio).toBeGreaterThanOrEqual(4.5);
});

it("composites translucent backgrounds and opacity groups up the ancestors", () => {
  const stacked = composite(
    [layer("rgb(255, 255, 255)"), layer("rgba(0, 0, 0, 0.5)"), layer("rgba(0, 0, 0, 0)")],
    "rgb(255, 255, 255)",
  );
  expect(stacked).toEqual({ text: [1, 1, 1], background: [0.5, 0.5, 0.5] });
  const faded = composite(
    [layer("rgb(255, 255, 255)"), layer("rgba(0, 0, 0, 0)", { opacity: 0.6 })],
    "rgb(0, 0, 0)",
  );
  expect(faded).toEqual({ text: [0.4, 0.4, 0.4], background: [1, 1, 1] });
  const group = composite(
    [
      layer("rgb(0, 0, 0)"),
      layer("rgb(255, 255, 255)", { opacity: 0.5 }),
      layer("rgba(0, 0, 0, 0)"),
    ],
    "rgb(0, 0, 0)",
  );
  expect(group).toEqual({ text: [0, 0, 0], background: [0.5, 0.5, 0.5] });
});

it("holds large text to 3:1 and other text to 4.5:1", () => {
  const grey = [layer("rgb(255, 255, 255)")];
  const ratio = (size: number, weight: number) =>
    judge(sample(grey, "rgb(136, 136, 136)", size, weight)).judged[0]?.needs;
  expect(ratio(24, 400)).toBe(3);
  expect(ratio(18.66, 700)).toBe(3);
  expect(ratio(18.66, 600)).toBe(4.5);
  expect(ratio(23.9, 400)).toBe(4.5);
});

it.each([
  [
    "a gradient under the text",
    [layer("rgb(255, 255, 255)", { image: "linear-gradient(red, blue)" })],
    /background image/,
  ],
  [
    "a filter",
    [layer("rgb(255, 255, 255)"), layer("rgba(0, 0, 0, 0)", { filter: "blur(2px)" })],
    /filter/,
  ],
  ["a blend mode", [layer("rgb(255, 255, 255)", { blend: "multiply" })], /mix-blend-mode/],
  ["no opaque background", [layer("rgba(255, 255, 255, 0.9)")], /no opaque background/],
  ["a colour the rule cannot read", [layer("color(display-p3 1 1 1)")], /not a colour/],
])("reports text over %s as unmeasured, never passed", (_, layers, reason) => {
  const { judged, unmeasured } = judge(sample(layers, "rgb(0, 0, 0)"));
  expect(judged).toEqual([]);
  expect(unmeasured).toEqual([expect.objectContaining({ reason: expect.stringMatching(reason) })]);
});

it("measures text over a gradient that an opaque descendant covers", () => {
  const drawn = composite(
    [layer("rgb(0, 0, 0)", { image: "linear-gradient(red, blue)" }), layer("rgb(255, 255, 255)")],
    "rgb(0, 0, 0)",
  );
  expect(drawn).toEqual({ text: [0, 0, 0], background: [1, 1, 1] });
});

const report = (overrides: Partial<ContrastReport>): ContrastReport => ({
  exclusions: EXCLUSIONS,
  views: [
    {
      view: "today",
      palette: "neutral",
      theme: "dark",
      state: "hover",
      measured: 10,
      inScope: 4,
      excluded: {},
      examples: {},
      failures: 0,
      unmeasured: 0,
    },
  ],
  failures: [],
  unmeasured: [],
  durationMs: 1,
  ...overrides,
});

it("names each failure with its view, palette, theme, state, selector, colours and ratio", () => {
  expect(() => assertContrast(report({}))).not.toThrow();
  expect(() =>
    assertContrast(
      report({
        failures: [
          {
            view: "today",
            palette: "neutral",
            theme: "dark",
            state: "hover",
            selector: "button.capsule-seg span.capsule-sync",
            text: "Sync 1h 40m",
            color: "#c463aa",
            background: "#232328",
            ratio: 4.2512,
            needs: 4.5,
          },
        ],
      }),
    ),
  ).toThrow(
    'today / neutral / dark / hovered: button.capsule-seg span.capsule-sync "Sync 1h 40m" #c463aa on #232328 is 4.25:1, needs 4.5:1',
  );
});

it("fails on unmeasured text and on a view that measured nothing of its own", () => {
  expect(() =>
    assertContrast(
      report({
        unmeasured: [
          {
            view: "detail",
            palette: "warm",
            theme: "light",
            state: "rest",
            selector: "span.evidence-dot",
            text: "run",
            reason: "background image linear-gradient(red, blue)",
          },
        ],
      }),
    ),
  ).toThrow('detail / warm / light: span.evidence-dot "run" unmeasured: background image');
  const views = report({}).views.map((view) => ({ ...view, inScope: 0 }));
  expect(() => assertContrast(report({ views }))).toThrow(
    "today / neutral / dark / hovered: measured no text in the view",
  );
});
