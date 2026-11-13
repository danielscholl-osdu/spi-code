// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

/** The strip's fields in PS-18 order. */
export const STRIP_FIELDS = ["environment", "template", "forks", "nextSync", "freshness"] as const;
export type StripField = (typeof STRIP_FIELDS)[number];

export const ROW_HEIGHT = 44;
export const SECOND_ROW_HEIGHT = 31;
/** Empty first row the fields always leave for dragging the window. */
export const DRAG_AREA = 48;
/** Extra free width a resize or a new sweep needs before the row unfolds or unwraps. */
export const UNFOLD_SLACK = 24;
/** The Windows caption buttons drawn over the right end of the first row. */
export const CAPTION_BUTTONS = 140;

/** Measured widths of each form a field can take; a field the snapshot does not carry is absent. */
export type FieldWidths = {
  /** The field with its label in full ("Environment") and shortened ("Env"). */
  environment?: { full: number; short: number };
  template?: number;
  forks?: number;
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
   * The widths the two rows have for the fields: the first row less its padding, the window
   * controls, the panel toggles and, on Windows, the caption buttons; the second row less its
   * padding.
   */
  width: { first: number; second: number };
  /** The gap between neighbouring fields. */
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
 * Levels, each keeping every step before it: 0 nothing folded, 1 the first sweep's freshness takes
 * its short form (already short in the narrow layout), 2 next sync and freshness wrap, 3 the
 * Environment label shortens to "Env", 4 forks wraps too, 5 templates, 6 environment.
 */
export type FoldLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type FoldPlan = {
  level: FoldLevel;
  environment: "full" | "short";
  freshness: "full" | "short";
  /** The first row's fields in reading order; the second row continues it. */
  first: StripField[];
  second: StripField[];
  /** The first row's width left empty, at least the drag area when the plan fits. */
  free: number;
  height: number;
  /** False when even the last step leaves either row short. */
  fits: boolean;
};

const LEVELS: readonly FoldLevel[] = [0, 1, 2, 3, 4, 5, 6];
const WRAP_FROM: Readonly<Record<FoldLevel, number>> = { 0: 5, 1: 5, 2: 3, 3: 3, 4: 2, 5: 1, 6: 0 };

function rows(fields: FieldWidths, level: FoldLevel) {
  const present = STRIP_FIELDS.filter((name) => fields[name] !== undefined);
  const wrapped = new Set<StripField>(STRIP_FIELDS.slice(WRAP_FROM[level]));
  return {
    first: present.filter((name) => !wrapped.has(name)),
    second: present.filter((name) => wrapped.has(name)),
  };
}

function fieldWidth(
  fields: FieldWidths,
  name: StripField,
  level: FoldLevel,
  narrow: boolean,
): number {
  switch (name) {
    case "environment":
      return (level >= 3 ? fields.environment?.short : fields.environment?.full) ?? 0;
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
  names: readonly StripField[],
  level: FoldLevel,
  gap: number,
  narrow: boolean,
): number {
  if (names.length === 0) return 0;
  const sum = names.reduce((total, name) => total + fieldWidth(fields, name, level, narrow), 0);
  return sum + gap * (names.length - 1);
}

/**
 * The top row's next plan (PS-18): the fewest fold steps that leave the drag area free on the first
 * row. A content change never unfolds the previous plan; a resize or a new sweep unfolds or unwraps
 * only to a step that fits with UNFOLD_SLACK to spare. The second row never wraps again.
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
    runWidth(fields, rows(fields, level).first, level, gap, narrow);
  const fitsFirst = (level: FoldLevel, slack: number) =>
    width.first - firstNeeds(level) >= DRAG_AREA + slack;
  const lowest = (slack: number) => LEVELS.find((level) => fitsFirst(level, slack)) ?? 6;
  const level = hold(lowest, previous?.level, change);
  const { first, second } = rows(fields, level);
  return {
    level,
    environment: level >= 3 ? "short" : "full",
    freshness: (level >= 1 || narrow) && typeof fields.freshness === "object" ? "short" : "full",
    first,
    second,
    free: width.first - firstNeeds(level),
    height: second.length > 0 ? ROW_HEIGHT + SECOND_ROW_HEIGHT : ROW_HEIGHT,
    fits: fitsFirst(level, 0) && width.second >= runWidth(fields, second, level, gap, narrow),
  };
}

function hold(
  lowest: (slack: number) => FoldLevel,
  held: FoldLevel | undefined,
  change: FoldChange,
): FoldLevel {
  const needed = lowest(0);
  if (held === undefined || needed >= held) return needed;
  if (change === "content") return held;
  const roomy = lowest(UNFOLD_SLACK);
  return roomy < held ? roomy : held;
}
