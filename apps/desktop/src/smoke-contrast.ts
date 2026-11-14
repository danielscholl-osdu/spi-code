// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { AssertionError } from "node:assert";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  InspectResultSchema,
  PROTOCOL_VERSION,
  parseMessage,
  type SetupState,
  ViewSnapshotSchema,
} from "@spi-code/contracts";
import type { BrowserWindow, IpcMainEvent } from "electron";

/**
 * Text the rule does not measure, and why. Every exclusion is counted per view in
 * views/contrast.json. Anything else it cannot resolve is unmeasured, and unmeasured fails.
 */
export const EXCLUSIONS = {
  hidden:
    "not drawn: no box, visibility other than visible, opacity 0 on it or an ancestor, or a transparent colour",
  disabled: "a disabled control (:disabled or aria-disabled=true), which WCAG 1.4.3 exempts",
  clipped: "clipped to a box of 1 px or less, or by clip or clip-path: words for assistive tech",
  covered:
    "under another element at its centre, such as a dialog, sheet or backdrop: the view on top is measured instead",
  offscreen:
    "never inside the viewport, even with each scroll container stepped through its height",
  decoration:
    "no letter or digit, inside aria-hidden=true or in generated ::before or ::after content, such as an arrow",
} as const;

export type Exclusion = keyof typeof EXCLUSIONS;

export const PALETTES = ["warm", "neutral"] as const;
export const THEMES = ["light", "dark"] as const;
const SHADES = PALETTES.flatMap((palette) => THEMES.map((theme) => ({ palette, theme })));

/**
 * Pairs drawn on a temporary node that the packaged collector must not pass. Their results go
 * in views/contrast.json under controls and never count against the views.
 */
export const CONTROLS = {
  tint: {
    expect: "below AA",
    what: "--success-text on a 16% color-mix tint of --success, in Neutral light",
  },
  hidden: { expect: "below AA", what: "readable text inside aria-hidden=true, white on white" },
  generated: { expect: "unmeasured", what: "generated words inside aria-hidden=true" },
} as const;

/** One element from the root down to the text's own element, as computed. */
export interface Layer {
  background: string;
  image: string;
  opacity: number;
  filter: string;
  blend: string;
}

export interface Sample {
  selector: string;
  text: string;
  color: string;
  size: number;
  weight: number;
  layers: number[];
  inScope: boolean;
}

export interface Collected {
  layers: Layer[];
  samples: Sample[];
  excluded: Partial<Record<Exclusion, number>>;
  examples: Partial<Record<Exclusion, string[]>>;
  unmeasured: { selector: string; text: string; reason: string }[];
}

export type Rgba = readonly [number, number, number, number];

export interface Judged {
  selector: string;
  text: string;
  color: string;
  background: string;
  ratio: number;
  needs: number;
}

export interface ViewContext {
  view: string;
  palette: (typeof PALETTES)[number];
  theme: (typeof THEMES)[number];
  state: "rest" | "hover";
}

export type Finding = ViewContext & Judged;
export type Unmeasured = ViewContext & { selector: string; text: string; reason: string };

const clamp = (value: number) => Math.min(1, Math.max(0, value));

function channels(body: string, legacy = false): { values: string[]; alpha: string | undefined } {
  const [main = "", alpha] = body.includes("/") ? body.split("/") : [body];
  const values = main
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
  if (legacy && alpha === undefined && values.length === 4)
    return { values: values.slice(0, 3), alpha: values[3] };
  return { values, alpha: alpha?.trim() };
}

function number(value: string, percent = 1): number {
  if (value === "none") return 0;
  return value.endsWith("%")
    ? (Number.parseFloat(value) / 100) * percent
    : Number.parseFloat(value);
}

function linearToSrgb(value: number): number {
  return value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
}

function oklabToSrgb(l: number, a: number, b: number): [number, number, number] {
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    linearToSrgb(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    linearToSrgb(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    linearToSrgb(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
  ];
}

/** A computed CSS colour as sRGB channels and alpha in 0..1; undefined for any other form. */
export function parseColor(value: string): Rgba | undefined {
  const text = value.trim().toLowerCase();
  if (text === "transparent") return [0, 0, 0, 0];
  const match = /^([a-z-]+)\((.*)\)$/.exec(text);
  if (!match) return undefined;
  const [, fn = "", inner = ""] = match;
  let rgb: [number, number, number];
  let alphaText: string | undefined;
  if (fn === "rgb" || fn === "rgba") {
    const { values, alpha } = channels(inner, true);
    if (values.length !== 3) return undefined;
    rgb = values.map((v) => number(v, 255) / 255) as [number, number, number];
    alphaText = alpha;
  } else if (fn === "color") {
    const { values, alpha } = channels(inner);
    const [space, ...rest] = values;
    if (rest.length !== 3 || (space !== "srgb" && space !== "srgb-linear")) return undefined;
    const raw = rest.map((v) => number(v)) as [number, number, number];
    rgb = space === "srgb" ? raw : (raw.map(linearToSrgb) as [number, number, number]);
    alphaText = alpha;
  } else if (fn === "oklab" || fn === "oklch") {
    const { values, alpha } = channels(inner);
    if (values.length !== 3) return undefined;
    const [l = "0", second = "0", third = "0"] = values;
    const lightness = number(l);
    if (fn === "oklab") rgb = oklabToSrgb(lightness, number(second, 0.4), number(third, 0.4));
    else {
      const chroma = number(second, 0.4);
      const hue = (number(third) * Math.PI) / 180;
      rgb = oklabToSrgb(lightness, chroma * Math.cos(hue), chroma * Math.sin(hue));
    }
    alphaText = alpha;
  } else return undefined;
  if (rgb.some((channel) => !Number.isFinite(channel))) return undefined;
  const alpha = alphaText === undefined ? 1 : number(alphaText);
  if (!Number.isFinite(alpha)) return undefined;
  return [clamp(rgb[0]), clamp(rgb[1]), clamp(rgb[2]), clamp(alpha)];
}

type Premultiplied = [number, number, number, number];

const premultiply = ([r, g, b, a]: Rgba): Premultiplied => [r * a, g * a, b * a, a];
const over = (top: Premultiplied, bottom: Premultiplied): Premultiplied => [
  top[0] + bottom[0] * (1 - top[3]),
  top[1] + bottom[1] * (1 - top[3]),
  top[2] + bottom[2] * (1 - top[3]),
  top[3] + bottom[3] * (1 - top[3]),
];
const scale = (color: Premultiplied, by: number): Premultiplied => [
  color[0] * by,
  color[1] * by,
  color[2] * by,
  color[3] * by,
];

function paint(layers: readonly (Layer & { fill: Rgba })[], text: Rgba | undefined): Premultiplied {
  let result: Premultiplied = [0, 0, 0, 0];
  for (let index = layers.length - 1; index >= 0; index--) {
    const layer = layers[index];
    assert(layer);
    const inner: Premultiplied =
      index === layers.length - 1 ? (text ? premultiply(text) : [0, 0, 0, 0]) : result;
    result = scale(over(inner, premultiply(layer.fill)), layer.opacity);
  }
  return result;
}

const unpremultiply = ([r, g, b, a]: Premultiplied): [number, number, number] =>
  a <= 0 ? [0, 0, 0] : [r / a, g / a, b / a];
const byte = (channel: number) => Math.round(clamp(channel) * 255);

export function hex(rgb: readonly number[]): string {
  return `#${rgb
    .slice(0, 3)
    .map((channel) => byte(channel).toString(16).padStart(2, "0"))
    .join("")}`;
}

function luminance(rgb: readonly number[]): number {
  const [r = 0, g = 0, b = 0] = rgb.map((channel) => {
    const value = byte(channel) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: readonly number[], b: readonly number[]): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** WCAG large text: 24 px, or 18.66 px (14 pt) at weight 700 or more. */
export function requiredRatio(size: number, weight: number): number {
  return size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
}

/**
 * Draws the layers from the root down, each an opacity group over its parent, then the text
 * colour on top. The background is the same stack without the text.
 */
export function composite(
  layers: readonly Layer[],
  color: string,
): { text: [number, number, number]; background: [number, number, number] } | { reason: string } {
  const text = parseColor(color);
  if (!text) return { reason: `text colour ${color} is not a colour the rule reads` };
  const resolved: (Layer & { fill: Rgba })[] = [];
  for (const layer of layers) {
    if (layer.filter !== "none") return { reason: `filter ${layer.filter}` };
    if (layer.blend !== "normal") return { reason: `mix-blend-mode ${layer.blend}` };
    const fill = parseColor(layer.background);
    if (!fill) return { reason: `background ${layer.background} is not a colour the rule reads` };
    resolved.push({ ...layer, fill });
  }
  for (const [index, layer] of resolved.entries()) {
    if (layer.image === "none") continue;
    let covered = false;
    for (const above of resolved.slice(index + 1)) {
      if (above.opacity < 1) break;
      if (above.fill[3] >= 1) {
        covered = true;
        break;
      }
    }
    if (!covered) return { reason: `background image ${layer.image}` };
  }
  const background = paint(resolved, undefined);
  if (background[3] < 0.999) return { reason: "no opaque background up to the root" };
  return { text: unpremultiply(paint(resolved, text)), background: unpremultiply(background) };
}

export function judge(collected: Collected): {
  judged: Judged[];
  unmeasured: Collected["unmeasured"];
} {
  const judged: Judged[] = [];
  const unmeasured = [...collected.unmeasured];
  for (const sample of collected.samples) {
    const layers = sample.layers.map((index) => collected.layers[index]);
    if (layers.some((layer) => !layer)) {
      unmeasured.push({ selector: sample.selector, text: sample.text, reason: "missing layer" });
      continue;
    }
    const drawn = composite(layers as Layer[], sample.color);
    if ("reason" in drawn) {
      unmeasured.push({ selector: sample.selector, text: sample.text, reason: drawn.reason });
      continue;
    }
    judged.push({
      selector: sample.selector,
      text: sample.text,
      color: hex(drawn.text),
      background: hex(drawn.background),
      ratio: contrastRatio(drawn.text, drawn.background),
      needs: requiredRatio(sample.size, sample.weight),
    });
  }
  return { judged, unmeasured };
}

export function formatFinding(finding: Finding | Unmeasured): string {
  const where = `${finding.view} / ${finding.palette} / ${finding.theme}${finding.state === "hover" ? " / hovered" : ""}: ${finding.selector} "${finding.text}"`;
  return "reason" in finding
    ? `${where} unmeasured: ${finding.reason}`
    : `${where} ${finding.color} on ${finding.background} is ${finding.ratio.toFixed(2)}:1, needs ${finding.needs}:1`;
}

/** Runs in the renderer; returns every text element it can see, with its layers. */
function collect(scope: string): Collected {
  const styles = new Map<Element, CSSStyleDeclaration>();
  const style = (element: Element) => {
    let value = styles.get(element);
    if (!value) {
      value = getComputedStyle(element);
      styles.set(element, value);
    }
    return value;
  };
  const layers: Layer[] = [];
  const layerIndex = new Map<Element, number>();
  const layerOf = (element: Element) => {
    let index = layerIndex.get(element);
    if (index === undefined) {
      const s = style(element);
      index =
        layers.push({
          background: s.backgroundColor,
          image: s.backgroundImage,
          opacity: Number(s.opacity),
          filter: s.filter,
          blend: s.mixBlendMode,
        }) - 1;
      layerIndex.set(element, index);
    }
    return index;
  };
  const path = (element: Element) => {
    const out: number[] = [];
    for (let node: Element | null = element; node; node = node.parentElement)
      out.unshift(layerOf(node));
    return out;
  };
  const part = (element: Element) =>
    element.tagName.toLowerCase() +
    [...element.classList]
      .slice(0, 2)
      .map((name) => `.${name}`)
      .join("") +
    ["data-tone", "data-field", "data-state", "role"]
      .filter((name) => element.hasAttribute(name))
      .map((name) => `[${name}=${element.getAttribute(name)}]`)
      .join("");
  const describe = (element: Element) => {
    let owner = element.parentElement;
    while (owner && owner.classList.length === 0) owner = owner.parentElement;
    return owner && owner !== document.body ? `${part(owner)} ${part(element)}` : part(element);
  };
  const clean = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 48);
  const transparent = (color: string) =>
    color === "rgba(0, 0, 0, 0)" || color === "transparent" || /\/\s*0\s*\)$/.test(color);
  const opaque = (color: string) => !color.startsWith("rgba(") && !color.includes("/");
  const painted = (element: Element) => {
    for (let node: Element | null = element; node; node = node.parentElement)
      if (Number(style(node).opacity) === 0) return false;
    const s = style(element);
    return s.backgroundImage !== "none" || !transparent(s.backgroundColor);
  };

  type Candidate = {
    element: Element;
    rects: () => DOMRect[];
    text: string;
    color: () => string;
    size: number;
    weight: number;
  };
  const candidates: Candidate[] = [];
  const parents = new Map<Element, Text[]>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    const parent = text.parentElement;
    if (!parent || !text.data.trim()) continue;
    if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "OPTION"].includes(parent.tagName)) continue;
    const list = parents.get(parent) ?? [];
    list.push(text);
    parents.set(parent, list);
  }
  for (const [element, texts] of parents) {
    const s = style(element);
    const svg = element instanceof SVGElement;
    candidates.push({
      element,
      rects: () =>
        texts.flatMap((text) => {
          const range = document.createRange();
          range.selectNodeContents(text);
          return [...range.getClientRects()];
        }),
      text: clean(texts.map((text) => text.data).join(" ")),
      color: () =>
        svg
          ? s.fill
          : s.webkitTextFillColor && s.webkitTextFillColor !== s.color
            ? s.webkitTextFillColor
            : s.color,
      size: Number.parseFloat(s.fontSize),
      weight: Number(s.fontWeight),
    });
  }
  for (const field of document.querySelectorAll<
    HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  >("input, textarea, select")) {
    if (
      field instanceof HTMLInputElement &&
      !["", "text", "search", "email", "url", "tel", "password", "number"].includes(field.type)
    )
      continue;
    const s = style(field);
    const value =
      field instanceof HTMLSelectElement
        ? (field.selectedOptions[0]?.textContent ?? "")
        : field.value;
    const placeholder = !value && !(field instanceof HTMLSelectElement) ? field.placeholder : "";
    if (!clean(value) && !clean(placeholder)) continue;
    candidates.push({
      element: field,
      rects: () => [field.getBoundingClientRect()],
      text: clean(value || placeholder),
      color: () => (placeholder ? getComputedStyle(field, "::placeholder").color : s.color),
      size: Number.parseFloat(s.fontSize),
      weight: Number(s.fontWeight),
    });
  }

  const unmeasured: Collected["unmeasured"] = [];
  const reasons = new Map<Element, Exclusion | "measured" | "unmeasured">();
  const samples: Sample[] = [];
  const readable = (text: string) => /[\p{L}\p{N}]/u.test(text);
  const check = (candidate: Candidate): Exclusion | "measured" | "unmeasured" => {
    const { element } = candidate;
    if (!readable(candidate.text) && element.closest('[aria-hidden="true"]')) return "decoration";
    if (element.closest(':disabled, [aria-disabled="true"]')) return "disabled";
    const s = style(element);
    if (s.visibility !== "visible" || transparent(candidate.color())) return "hidden";
    let opacity = 1;
    for (let node: Element | null = element; node; node = node.parentElement) {
      const n = style(node);
      opacity *= Number(n.opacity);
      if ((n.clipPath && n.clipPath !== "none") || (n.clip && n.clip !== "auto")) return "clipped";
    }
    if (opacity === 0) return "hidden";
    const rects = candidate.rects().filter((rect) => rect.width > 0 && rect.height > 0);
    if (rects.length === 0) return "hidden";
    const box = element.getBoundingClientRect();
    if (box.width <= 1 || box.height <= 1) return "clipped";
    const point = rects
      .map((rect) => [rect.left + rect.width / 2, rect.top + rect.height / 2] as const)
      .find(([x, y]) => x >= 0 && y >= 0 && x < innerWidth && y < innerHeight);
    if (!point) return "offscreen";
    const stack = document.elementsFromPoint(point[0], point[1]);
    const own = stack.findIndex(
      (item) => item === element || element.contains(item) || item.contains(element),
    );
    if (own < 0) return "covered";
    if (stack.slice(0, own).some(painted)) return "covered";
    for (const beneath of stack.slice(own)) {
      if (beneath === element || element.contains(beneath)) continue;
      const b = style(beneath);
      if (beneath.contains(element)) {
        if (opaque(b.backgroundColor) && b.backgroundImage === "none") break;
        continue;
      }
      if (painted(beneath)) {
        unmeasured.push({
          selector: describe(element),
          text: candidate.text,
          reason: `drawn over ${describe(beneath)}, which is not an ancestor`,
        });
        return "unmeasured";
      }
    }
    samples.push({
      selector: describe(element),
      text: candidate.text,
      color: candidate.color(),
      size: candidate.size,
      weight: candidate.weight,
      layers: path(element),
      inScope: element.closest(scope) !== null,
    });
    return "measured";
  };
  const visit = () => {
    for (const candidate of candidates) {
      const seen = reasons.get(candidate.element);
      if (seen === "measured" || seen === "unmeasured") continue;
      reasons.set(candidate.element, check(candidate));
    }
  };
  visit();
  const scrollers = [...document.querySelectorAll("*")].filter((element) => {
    const overflow = style(element).overflowY;
    return (
      (overflow === "auto" || overflow === "scroll") &&
      element.scrollHeight > element.clientHeight + 1
    );
  });
  for (const scroller of scrollers) {
    const start = scroller.scrollTop;
    const step = Math.max(40, scroller.clientHeight * 0.8);
    for (let top = step; top < scroller.scrollHeight; top += step) {
      scroller.scrollTop = top;
      visit();
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1) break;
    }
    scroller.scrollTop = start;
  }
  for (const element of document.body.querySelectorAll("*")) {
    for (const pseudo of ["::before", "::after"]) {
      const content = getComputedStyle(element, pseudo).content;
      if (!/^["']/.test(content) || content.length <= 2) continue;
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (readable(content)) {
        unmeasured.push({
          selector: `${describe(element)}${pseudo}`,
          text: content.slice(1, -1),
          reason: "generated content with words",
        });
      } else reasons.set(element, reasons.get(element) ?? "decoration");
    }
  }
  const excluded: Partial<Record<Exclusion, number>> = {};
  const examples: Partial<Record<Exclusion, string[]>> = {};
  for (const [element, reason] of reasons)
    if (reason !== "measured" && reason !== "unmeasured") {
      excluded[reason] = (excluded[reason] ?? 0) + 1;
      const list = examples[reason] ?? [];
      if (list.length < 3) examples[reason] = [...list, describe(element)];
    }
  return { layers, samples, excluded, examples, unmeasured };
}

/** The element each `:hover` in the window's own style sheets applies to, as a selector. */
function hoverTargets(): string[] {
  const targets = new Set<string>();
  const split = (selector: string) => {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let index = 0; index < selector.length; index++) {
      const char = selector[index];
      if (char === "(" || char === "[") depth++;
      else if (char === ")" || char === "]") depth--;
      else if (char === "," && depth === 0) {
        parts.push(selector.slice(start, index));
        start = index + 1;
      }
    }
    parts.push(selector.slice(start));
    return parts.map((part) => part.trim());
  };
  const hovers = (selector: string) => {
    const found: number[] = [];
    let depth = 0;
    for (let index = 0; index < selector.length; index++) {
      const char = selector[index];
      if (char === "(" || char === "[") depth++;
      else if (char === ")" || char === "]") depth--;
      else if (depth === 0 && selector.startsWith(":hover", index)) found.push(index);
    }
    return found;
  };
  const walk = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule) {
        for (const selector of split(rule.selectorText))
          for (const index of hovers(selector)) {
            const target = selector.slice(0, index).replaceAll(":hover", "").trim();
            if (target && !/[>+~]$/.test(target)) targets.add(target);
          }
      }
      if ("cssRules" in rule) walk((rule as CSSGroupingRule).cssRules);
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      walk(sheet.cssRules);
    } catch {}
  }
  return [...targets];
}

function settle(): void {
  for (const animation of document.getAnimations()) {
    try {
      if (animation.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY) animation.finish();
    } catch {}
  }
}

interface ContrastView {
  view: string;
  palette: ViewContext["palette"];
  theme: ViewContext["theme"];
  state: ViewContext["state"];
  measured: number;
  inScope: number;
  excluded: Collected["excluded"];
  examples: Collected["examples"];
  failures: number;
  unmeasured: number;
}

export interface ContrastReport {
  exclusions: typeof EXCLUSIONS;
  controls: { control: string; expect: string; found: string }[];
  views: ContrastView[];
  failures: Finding[];
  unmeasured: Unmeasured[];
  durationMs: number;
}

/** Fails the views when one of them, at rest or hovered, measured nothing in its own scope. */
export function assertContrast(report: ContrastReport): void {
  const empty = report.views.filter(({ inScope }) => inScope === 0);
  const lines = [
    ...report.failures.map(formatFinding),
    ...report.unmeasured.map(formatFinding),
    ...empty.map(
      ({ view, palette, theme, state }) =>
        `${view} / ${palette} / ${theme}${state === "hover" ? " / hovered" : ""}: measured no text in the view`,
    ),
  ];
  if (lines.length > 0)
    throw new AssertionError({
      message: `Rendered contrast: ${report.failures.length} below AA, ${report.unmeasured.length} unmeasured\n${lines.join("\n")}`,
    });
}

/** Fails unless the collector failed every control as it must; returns what it found. */
export function checkControls(collected: Collected): ContrastReport["controls"] {
  const { judged, unmeasured } = judge(collected);
  const found: ContrastReport["controls"] = [];
  const wrong: string[] = [];
  for (const [id, { expect, what }] of Object.entries(CONTROLS)) {
    const owns = ({ selector }: { selector: string }) =>
      selector.includes(`.contrast-control-${id}`);
    const measured = judged.find(owns);
    const missing = unmeasured.find(owns);
    const result = measured
      ? `${measured.color} on ${measured.background} is ${measured.ratio.toFixed(2)}:1, needs ${measured.needs}:1`
      : missing
        ? `unmeasured: ${missing.reason}`
        : "not measured";
    const held =
      expect === "unmeasured" ? !measured && missing : measured && measured.ratio < measured.needs;
    if (held) found.push({ control: what, expect, found: result });
    else wrong.push(`${what}: expected ${expect}, found ${result}`);
  }
  if (wrong.length > 0)
    throw new AssertionError({
      message: `Rendered contrast controls did not fail as they must:\n${wrong.join("\n")}`,
    });
  return found;
}

/**
 * Runs in the renderer: draws the controls over the view with DOM and CSSOM calls, which the
 * window's style-src 'self' allows, and returns what removes them.
 */
function drawControls(): () => void {
  const span = (css: string, text = "", attributes: Record<string, string> = {}) => {
    const element = document.createElement("span");
    element.style.cssText = css;
    element.textContent = text;
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    return element;
  };
  const host = document.createElement("div");
  host.dataset.contrastControl = "";
  host.style.cssText =
    "position: fixed; left: 0; top: 0; z-index: 2147483647; display: flex; gap: 8px; padding: 8px; background: var(--surface); font: 400 12px/16px sans-serif";
  const white = span("background: rgb(255, 255, 255)");
  white.append(
    span("color: rgb(255, 255, 255)", "08:02", {
      class: "contrast-control-hidden",
      "aria-hidden": "true",
    }),
  );
  host.append(
    span(
      "background: color-mix(in srgb, var(--success) 16%, var(--surface)); color: var(--success-text)",
      "Verify",
      { class: "contrast-control-tint" },
    ),
    white,
    span("color: var(--text)", "", { class: "contrast-control-generated", "aria-hidden": "true" }),
  );
  const sheet = new CSSStyleSheet();
  sheet.replaceSync('.contrast-control-generated::before { content: "Sync"; }');
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  document.body.append(host);
  return () => {
    host.remove();
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((item) => item !== sheet);
  };
}

function fixture(
  window: BrowserWindow,
  type: string,
  payload: unknown,
  id = "smoke-contrast",
): void {
  const parsed = parseMessage({
    version: PROTOCOL_VERSION,
    id,
    kind: type === "inspect.result" ? "response" : "event",
    type,
    payload,
  });
  assert(parsed.ok, `Invalid contrast fixture: ${type}`);
  window.webContents.send("smoke:fixture", parsed.message);
}

/** Waits on DOM mutations rather than animation frames, which the hidden smoke window throttles on Windows. */
async function rendered(window: BrowserWindow, condition: string): Promise<void> {
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const done = () => {
      observer.disconnect();
      clearTimeout(timer);
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolve();
      channel.port2.postMessage(0);
    };
    const observer = new MutationObserver(() => {
      if (${condition}) done();
    });
    const timer = setTimeout(() => {
      observer.disconnect();
      if (${condition}) done();
      else reject(new Error("Contrast smoke DOM timeout: " + ${JSON.stringify(condition)}));
    }, 5000);
    if (${condition}) done();
    else observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  })`);
}

const STATES = ["rest", "hover"] as const;

const ROOT_STATE = `(() => {
  const root = document.documentElement;
  return JSON.stringify({
    attributes: [...root.attributes]
      .filter(({ name }) => name !== "style")
      .map(({ name, value }) => name + "=" + value)
      .sort(),
    colorScheme: root.style.colorScheme,
  });
})()`;

/**
 * Measures every visible text on Today, the sweep popover, Upstream, the Line sheet, Detail and three
 * Settings sections, in both palettes and both themes, at rest and with every :hover target forced.
 * Each view is mounted once and shaded in place by writing the root attributes Settings > Appearance
 * writes; Settings is shaded through its own controls, and those attributes must match.
 */
export async function assertRenderedContrast(
  window: BrowserWindow,
  reportPath: string,
  fixturePath: string,
  morningPaths: Readonly<Record<string, string>>,
): Promise<ContrastReport> {
  const started = Date.now();
  const { ipcMain } = await import("electron");
  const js = <T>(source: string): Promise<T> => window.webContents.executeJavaScript(source);
  const read = (path: string) => ViewSnapshotSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  const checkedAt = "2026-11-06T15:04:00.000Z";
  const nov6 = read(fixturePath);
  nov6.briefing.nextSyncAt = new Date(Date.parse(checkedAt) + 100 * 60_000).toISOString();
  const mornings = Object.entries(morningPaths).map(
    ([morning, path]) => [morning, read(path)] as const,
  );
  let cursor = Math.max(nov6.cursor, ...mornings.map(([, snapshot]) => snapshot.cursor)) + 1;
  const push = async (snapshot: typeof nov6) => {
    const before = await js<string>('document.querySelector(".today")?.innerText ?? ""');
    fixture(window, "view.snapshot", { ...snapshot, cursor: cursor++ });
    await rendered(
      window,
      `document.querySelector(".today .place-reading") && document.querySelector(".today").innerText !== ${JSON.stringify(before)}`,
    );
  };
  const inspections = new Map(
    (JSON.parse(readFileSync(join(dirname(fixturePath), "inspect-1106.json"), "utf8")) as unknown[])
      .map((value) => InspectResultSchema.parse(value))
      .map((result) => [result.id, result]),
  );
  const ready: SetupState = {
    checkedAt,
    watchReady: true,
    disabledReason: null,
    tools: [
      { tool: "copilot", state: "ready", action: null, reason: "octocat · Business seat" },
      { tool: "git", state: "ready", action: null, version: "2.56.0" },
      { tool: "gh", state: "ready", action: null, version: "2.83.0" },
      { tool: "glab", state: "ready", action: null, version: "1.128.0" },
    ],
  };
  const notReady: SetupState = {
    ...ready,
    watchReady: false,
    disabledReason: "Watch needs gh.",
    tools: ready.tools.map((tool) =>
      tool.tool === "gh"
        ? { tool: "gh", state: "signed-out", action: "signin" }
        : tool.tool === "glab"
          ? {
              tool: "glab",
              state: "signed-out",
              action: "signin",
              reason: "glab is not signed in to community.opengroup.org.",
            }
          : tool,
    ),
  };
  const sweepStatus = {
    remaining: 4865,
    floor: 100,
    resetAt: "2026-11-06T15:36:00.000Z",
    deferredAreas: [],
    nextSweepAt: null,
    schedule: {
      sweepMs: 300_000,
      gitlabMs: 1_800_000,
      securityMs: 1_800_000,
      releasesMs: 3_600_000,
    },
    lastSweep: null,
  };
  const request = (event: IpcMainEvent, input: unknown) => {
    if (event.sender !== window.webContents) return;
    const parsed = parseMessage(input);
    if (!parsed.ok || parsed.message.type !== "inspect.request") return;
    const result = inspections.get(parsed.message.payload.id);
    if (result) fixture(window, "inspect.result", result, parsed.message.id);
    else console.error(`Packaged contrast: no recorded Detail for ${parsed.message.payload.id}`);
  };
  const debug = window.webContents.debugger;
  const attached = debug.isAttached();
  if (!attached) debug.attach("1.3");
  const [width, height] = window.getContentSize();
  const saved = await js<Record<string, string | null>>(
    `Object.fromEntries(["spi-code.appearance", "spi-code.palette"].map(key => [key, localStorage.getItem(key)]))`,
  );
  const report: ContrastReport = {
    exclusions: EXCLUSIONS,
    controls: [],
    views: [],
    failures: [],
    unmeasured: [],
    durationMs: 0,
  };
  let clockScript: string | undefined;
  ipcMain.on("smoke:request", request);
  try {
    await debug.sendCommand("Page.enable");
    await debug.sendCommand("DOM.enable");
    await debug.sendCommand("CSS.enable");
    await debug.sendCommand("Emulation.setTimezoneOverride", { timezoneId: "America/Chicago" });
    const clock: { identifier: string } = await debug.sendCommand(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: `Date.now = () => ${Date.parse(checkedAt)};` },
    );
    clockScript = clock.identifier;
    window.setContentSize(1440, 800);
    const written = new Map<string, string>();
    const shade = async ({ palette, theme }: (typeof SHADES)[number]) => {
      const state = await js<string>(`(() => {
        const root = document.documentElement;
        root.dataset.palette = ${JSON.stringify(palette)};
        root.dataset.theme = ${JSON.stringify(theme)};
        root.style.colorScheme = ${JSON.stringify(theme)};
        return ${ROOT_STATE};
      })()`);
      written.set(`${palette}/${theme}`, state);
    };
    const force = async (): Promise<number[]> => {
      const selectors = await js<string[]>(`(${hoverTargets.toString()})()`);
      const { root }: { root: { nodeId: number } } = await debug.sendCommand("DOM.getDocument", {
        depth: 0,
      });
      const found: { nodeIds: number[] }[] = await Promise.all(
        selectors.map((selector) =>
          debug.sendCommand("DOM.querySelectorAll", { nodeId: root.nodeId, selector }),
        ),
      );
      const ids = [...new Set(found.flatMap(({ nodeIds }) => nodeIds))];
      await Promise.all(
        ids.map((nodeId) =>
          debug.sendCommand("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover"] }),
        ),
      );
      return ids;
    };
    const hovered = async (state: ViewContext["state"], run: () => Promise<void>) => {
      const forced = state === "hover" ? await force() : [];
      try {
        await run();
      } finally {
        await Promise.all(
          forced.map((nodeId) =>
            debug.sendCommand("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] }),
          ),
        );
      }
    };
    const sample = async (ctx: ViewContext, scope: string) => {
      const collected = await js<Collected>(
        `(${settle.toString()})(), (${collect.toString()})(${JSON.stringify(scope)})`,
      );
      const { judged, unmeasured } = judge(collected);
      const failures = new Map<string, Finding>();
      for (const item of judged)
        if (item.ratio < item.needs)
          failures.set(`${item.selector}|${item.color}|${item.background}`, { ...ctx, ...item });
      const missing = new Map<string, Unmeasured>();
      for (const item of unmeasured)
        missing.set(`${item.selector}|${item.reason}`, { ...ctx, ...item });
      report.failures.push(...failures.values());
      report.unmeasured.push(...missing.values());
      report.views.push({
        ...ctx,
        measured: judged.length,
        inScope: collected.samples.filter(({ inScope }) => inScope).length,
        excluded: collected.excluded,
        examples: collected.examples,
        failures: failures.size,
        unmeasured: missing.size,
      });
      console.log(
        `Packaged contrast ${ctx.view}/${ctx.palette}/${ctx.theme}/${ctx.state}: ${judged.length} measured, ${failures.size} below AA, ${missing.size} unmeasured, excluded ${JSON.stringify(collected.excluded)}`,
      );
    };
    const everyShade = async (view: string, scope: string) => {
      for (const state of STATES)
        await hovered(state, async () => {
          for (const shading of SHADES) {
            await shade(shading);
            await sample({ view, ...shading, state }, scope);
          }
        });
      await shade({ palette: "warm", theme: "light" });
    };
    await js(`{
      localStorage.removeItem("spi-code.panes");
      localStorage.removeItem("spi-code.line-sheet.pinned");
      localStorage.setItem("spi-code.appearance", "light");
      localStorage.setItem("spi-code.palette", "warm");
      location.hash = "#today";
    }`);
    const loaded = once(window.webContents, "did-finish-load");
    window.webContents.reload();
    await loaded;
    await rendered(window, 'document.querySelector(".shell [data-sidebar-row=settings]")');
    fixture(window, "sweep.status", sweepStatus);
    fixture(window, "setup.state", ready);
    await push(nov6);
    await rendered(
      window,
      'document.documentElement.dataset.theme === "light" && document.documentElement.dataset.palette === "warm"',
    );
    await shade({ palette: "neutral", theme: "light" });
    report.controls = checkControls(
      await js<Collected>(`(() => {
        const remove = (${drawControls.toString()})();
        try {
          return (${collect.toString()})("[data-contrast-control]");
        } finally {
          remove();
        }
      })()`),
    );
    console.log(
      `Packaged contrast controls: ${report.controls.map(({ control, found }) => `${control}: ${found}`).join("; ")}`,
    );
    await shade({ palette: "warm", theme: "light" });
    await everyShade("today", ".today");
    await js('document.querySelector("[data-strip] [data-sweep-line]").click()');
    await rendered(window, 'document.querySelector("[data-sweep-popover] .capsule-evidence")');
    await everyShade("sweep-popover", "[data-sweep-popover]");
    await js('document.querySelector("[data-strip] [data-sweep-line]").click()');
    await rendered(window, '!document.querySelector("[data-sweep-popover]")');
    for (const [morning, snapshot] of mornings) {
      await push(snapshot);
      await everyShade(`today-${morning}`, ".today");
    }
    await push(nov6);
    await js('document.querySelector("[data-strip] [data-field=forks]").click()');
    await rendered(window, 'document.querySelector(".line-sheet .line-grid")');
    await everyShade("line", ".line-sheet");
    await js("document.querySelector(\"[aria-label='Close Line']\").click()");
    await js('location.hash = "#upstream"');
    await rendered(window, 'document.querySelector(".upstream .place-reading")');
    await everyShade("upstream", ".upstream");
    await js(
      "document.querySelector(\".place-item-content[data-selection-id='campaign:toolchain:os-core-common%208.5.0']\").click()",
    );
    await rendered(window, 'document.querySelector("aside[aria-label=Detail] .detail-row-fields")');
    await everyShade("detail", "aside[aria-label=Detail]");
    await js('document.querySelector(".upstream-theme-head").click()');
    await rendered(
      window,
      'document.querySelector("aside[aria-label=Detail]:not([aria-busy=true]) article.inspector")',
    );
    await everyShade("detail-reading", "aside[aria-label=Detail]");
    await js("document.querySelector(\"[aria-label='Close detail']\").click()");
    fixture(window, "setup.state", notReady);
    await js(`{
      const mac = /Mac|iPhone|iPad/.test(navigator.userAgent);
      window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", metaKey: mac, ctrlKey: !mac, bubbles: true }));
    }`);
    await rendered(window, 'document.querySelector("[role=dialog].settings")');
    const section = async (name: string, label: string) => {
      await js(
        `[...document.querySelectorAll(".settings-nav button")].find(item => item.textContent === ${JSON.stringify(label)}).click()`,
      );
      await rendered(window, `document.querySelector("[data-settings-section=${name}]")`);
    };
    for (const { palette, theme } of SHADES) {
      await section("appearance", "Appearance");
      const inputs = [
        `input[name="settings-theme"][value="${theme}"]`,
        `input[name="settings-palette"][value="${palette}"]`,
      ];
      await js(`for (const selector of ${JSON.stringify(inputs)}) {
        const input = document.querySelector(selector);
        if (!input.checked) input.click();
      }`);
      await rendered(
        window,
        `document.documentElement.dataset.theme === ${JSON.stringify(theme)} && document.documentElement.dataset.palette === ${JSON.stringify(palette)}`,
      );
      assert.equal(
        await js<string>(ROOT_STATE),
        written.get(`${palette}/${theme}`),
        `Shading ${palette}/${theme} in place must write what Settings > Appearance writes`,
      );
      for (const [name, label] of [
        ["appearance", "Appearance"],
        ["readiness", "Readiness"],
        ["sweep", "Sweep"],
      ] as const) {
        if (name !== "appearance") await section(name, label);
        for (const state of STATES)
          await hovered(state, () =>
            sample({ view: `settings-${name}`, palette, theme, state }, "[role=dialog].settings"),
          );
      }
    }
    await js("document.querySelector(\"[aria-label='Close settings']\").click()");
    await rendered(window, '!document.querySelector("[role=dialog]")');
  } finally {
    ipcMain.removeListener("smoke:request", request);
    if (clockScript)
      await debug.sendCommand("Page.removeScriptToEvaluateOnNewDocument", {
        identifier: clockScript,
      });
    await debug.sendCommand("Emulation.setTimezoneOverride", { timezoneId: "" });
    await js(`{
      const saved = ${JSON.stringify(saved)};
      for (const [key, value] of Object.entries(saved))
        value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value);
      localStorage.removeItem("spi-code.panes");
      localStorage.removeItem("spi-code.line-sheet.pinned");
      location.hash = "#today";
    }`);
    window.setContentSize(width ?? 1440, height ?? 800);
    if (!attached) debug.detach();
    const loaded = once(window.webContents, "did-finish-load");
    window.webContents.reload();
    await loaded;
  }
  report.durationMs = Date.now() - started;
  mkdirSync(join(dirname(reportPath), "views"), { recursive: true });
  writeFileSync(
    join(dirname(reportPath), "views", "contrast.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    `Packaged contrast: ${report.views.length} measurements in ${(report.durationMs / 1000).toFixed(1)} s, ${report.failures.length} below AA, ${report.unmeasured.length} unmeasured`,
  );
  assertContrast(report);
  return report;
}
