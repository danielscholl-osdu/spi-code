// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

/** The strip's fields after the pips, in PS-18 order. */
export const STRIP_FIELDS = [
  "stopped",
  "environment",
  "template",
  "due",
  "nextSync",
  "freshness",
] as const;
export type StripField = (typeof STRIP_FIELDS)[number];

export const ROW_HEIGHT = 44;
export const SECOND_ROW_HEIGHT = 31;
/** Empty first row the fields always leave for dragging the window. */
export const DRAG_AREA = 48;
/** Extra free width a resize or a new sweep needs before the row unfolds or unwraps. */
export const UNFOLD_SLACK = 24;
/** The Windows caption buttons drawn over the right end of the first row. */
export const CAPTION_BUTTONS = 140;

const PIP = { full: { mark: 9, gap: 3 }, small: { mark: 6, gap: 2 } } as const;

/** The width of a run of pips at either size. */
export function pipsWidth(count: number, size: keyof typeof PIP): number {
  if (count <= 0) return 0;
  const { mark, gap } = PIP[size];
  return count * mark + (count - 1) * gap;
}

/** Measured widths of each form a field can take; a field the snapshot does not carry is absent. */
export type FieldWidths = {
  pips?: { full: number; small: number };
  stopped?: { names: number; count: number };
  environment?: { full: number; version: number };
  template?: number;
  due?: { full: number; count: number };
  nextSync?: number;
  /** The live field's width, or both forms while the first sweep runs ("sweeping · 9 of 12", "9 of 12"). */
  freshness?: number | { full: number; short: number };
};

/**
 * Why the row is being planned again. `content` is any re-measure of the same sweep, which folds or
 * wraps at once but never unfolds; `resize` and `sweep` may also unfold, given the slack.
 */
export type FoldChange = "content" | "resize" | "sweep";

export type FoldInput = {
  fields: FieldWidths;
  /**
   * The widths the two rows have for the pips and fields: the first row less its padding, the
   * window controls, the panel toggles and, on Windows, the caption buttons; the second row less
   * its padding.
   */
  width: { first: number; second: number };
  /** The gap between neighbouring pips and fields. */
  gap: number;
  /**
   * The window is in its narrow layout, too narrow for the sidebar beside the middle column, where
   * the first sweep's freshness takes its short form whatever room the row has.
   */
  narrow?: boolean;
  change: FoldChange;
  previous?: FoldPlan | undefined;
};

/**
 * Levels, each keeping every step before it: 0 nothing folded, 1 stopped names fold to a count and the
 * first sweep's freshness to its short form (already short in the narrow layout), 2 the pips shrink, 3 due, next sync and freshness wrap, 4 template wraps too, 5 environment, 6 stopped.
 */
export type FoldLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6;
/** How far the second row shortens its fields: 1 environment to its version, 2 due to its count too. */
export type FoldShorten = 0 | 1 | 2;

export type FoldPlan = {
  level: FoldLevel;
  shorten: FoldShorten;
  pips: "full" | "small";
  stopped: "names" | "count";
  environment: "full" | "version";
  due: "full" | "count";
  freshness: "full" | "short";
  /** The first row's pips and fields in reading order; the second row continues it. */
  first: ("pips" | StripField)[];
  second: StripField[];
  /** The first row's width left empty, at least the drag area when the plan fits. */
  free: number;
  height: number;
  /** False when even the last step leaves either row short. */
  fits: boolean;
};

const LEVELS: readonly FoldLevel[] = [0, 1, 2, 3, 4, 5, 6];
const SHORTENS: readonly FoldShorten[] = [0, 1, 2];
const WRAP_FROM: Readonly<Record<FoldLevel, number>> = { 0: 6, 1: 6, 2: 6, 3: 3, 4: 2, 5: 1, 6: 0 };

function present(fields: FieldWidths): StripField[] {
  return STRIP_FIELDS.filter((name) => fields[name] !== undefined);
}

function rows(fields: FieldWidths, level: FoldLevel) {
  const wrapped = new Set<StripField>(STRIP_FIELDS.slice(WRAP_FROM[level]));
  const all = present(fields);
  return {
    first: [
      ...(fields.pips ? (["pips"] as const) : []),
      ...all.filter((name) => !wrapped.has(name)),
    ],
    second: all.filter((name) => wrapped.has(name)),
  };
}

function fieldWidth(
  fields: FieldWidths,
  name: "pips" | StripField,
  level: FoldLevel,
  shorten: FoldShorten,
  narrow: boolean,
): number {
  switch (name) {
    case "pips":
      return (level >= 2 ? fields.pips?.small : fields.pips?.full) ?? 0;
    case "stopped":
      return (level >= 1 ? fields.stopped?.count : fields.stopped?.names) ?? 0;
    case "environment":
      return (shorten >= 1 ? fields.environment?.version : fields.environment?.full) ?? 0;
    case "due":
      return (shorten >= 2 ? fields.due?.count : fields.due?.full) ?? 0;
    case "freshness": {
      const freshness = fields.freshness;
      if (typeof freshness !== "object") return freshness ?? 0;
      return level >= 1 || narrow ? freshness.short : freshness.full;
    }
    default:
      return fields[name] ?? 0;
  }
}

function runWidth(
  fields: FieldWidths,
  names: readonly ("pips" | StripField)[],
  level: FoldLevel,
  shorten: FoldShorten,
  gap: number,
  narrow: boolean,
): number {
  if (names.length === 0) return 0;
  const sum = names.reduce(
    (total, name) => total + fieldWidth(fields, name, level, shorten, narrow),
    0,
  );
  return sum + gap * (names.length - 1);
}

/**
 * The top row's next plan (PS-18): the fewest fold steps that leave the drag area free on the first
 * row and fit the second. A content change never unfolds the previous plan; a resize or a new sweep
 * unfolds or unwraps only to a step that fits with UNFOLD_SLACK to spare.
 */
export function planFold({
  fields,
  width,
  gap,
  narrow = false,
  change,
  previous,
}: FoldInput): FoldPlan {
  const firstNeeds = (level: FoldLevel) =>
    runWidth(fields, rows(fields, level).first, level, 0, gap, narrow);
  const fitsFirst = (level: FoldLevel, slack: number) =>
    width.first - firstNeeds(level) >= DRAG_AREA + slack;
  const lowestLevel = (slack: number) => LEVELS.find((level) => fitsFirst(level, slack)) ?? 6;
  const level = hold(lowestLevel, previous?.level, change);

  const { first, second } = rows(fields, level);
  const fitsSecond = (shorten: FoldShorten, slack: number) =>
    width.second - runWidth(fields, second, level, shorten, gap, narrow) >= slack;
  const lowestShorten = (slack: number) =>
    SHORTENS.find((shorten) => fitsSecond(shorten, slack)) ?? 2;
  const shorten = second.length === 0 ? 0 : hold(lowestShorten, previous?.shorten, change);

  return {
    level,
    shorten,
    pips: level >= 2 ? "small" : "full",
    stopped: level >= 1 ? "count" : "names",
    environment: shorten >= 1 && second.includes("environment") ? "version" : "full",
    due: shorten >= 2 && second.includes("due") ? "count" : "full",
    freshness: (level >= 1 || narrow) && typeof fields.freshness === "object" ? "short" : "full",
    first,
    second,
    free: width.first - firstNeeds(level),
    height: second.length > 0 ? ROW_HEIGHT + SECOND_ROW_HEIGHT : ROW_HEIGHT,
    fits: fitsFirst(level, 0) && fitsSecond(shorten, 0),
  };
}

function hold<Step extends number>(
  lowest: (slack: number) => Step,
  held: Step | undefined,
  change: FoldChange,
): Step {
  const needed = lowest(0);
  if (held === undefined || needed >= held) return needed;
  if (change === "content") return held;
  const roomy = lowest(UNFOLD_SLACK);
  return roomy < held ? roomy : held;
}
