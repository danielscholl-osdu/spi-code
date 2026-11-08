// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type RefObject, useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  type FieldWidths,
  type FoldChange,
  type FoldInput,
  type FoldPlan,
  pipsWidth,
  planFold,
} from "./fold-plan.js";

/**
 * What made the row re-measure. `content` is a field's width changing on its own (a clock tick, a
 * font load); `refresh` is a new snapshot of the same sweep; `resize` is the row's own width
 * changing; `sweep` is a snapshot with a new sweep time.
 */
export type StripTrigger = "content" | "refresh" | "resize" | "sweep";

/** Data refreshes never unfold the row, so the window does not flip between 44 and 75 px. */
export const FOLD_CHANGE: Readonly<Record<StripTrigger, FoldChange>> = {
  content: "content",
  refresh: "content",
  resize: "resize",
  sweep: "sweep",
};

/** The ruler's hidden forms, named `<field>.<form>`, and the live field measured in place. */
export const MEASURE = {
  stoppedNames: "stopped.names",
  stoppedCount: "stopped.count",
  environmentFull: "environment.full",
  environmentVersion: "environment.version",
  template: "template",
  dueFull: "due.full",
  dueCount: "due.count",
  nextSync: "next-sync",
} as const;

type Measured = Omit<FoldInput, "change" | "previous">;

const widthOf = (element: Element | null) => element?.getBoundingClientRect().width;

function innerWidth(element: HTMLElement): number {
  const style = getComputedStyle(element);
  const padding =
    (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
  return Math.max(0, element.getBoundingClientRect().width - padding);
}

const gapOf = (style: CSSStyleDeclaration) =>
  Number.parseFloat(style.columnGap) || Number.parseFloat(style.gap) || 0;

/** The row's field widths in every form and the room on both rows; nothing while it is not laid out. */
export function measureStrip(root: HTMLElement, pips: number): Measured | undefined {
  const first = widthOf(root) ?? 0;
  if (!(first > 0)) return undefined;
  const row = root.querySelector<HTMLElement>('[data-strip-row="second"]');
  const form = (name: string) => widthOf(root.querySelector(`[data-measure="${name}"]`));
  const pair = (a: string, b: string) => {
    const [x, y] = [form(a), form(b)];
    return x === undefined || y === undefined ? undefined : ([x, y] as const);
  };
  const fields: FieldWidths = {};
  if (pips > 0) fields.pips = { full: pipsWidth(pips, "full"), small: pipsWidth(pips, "small") };
  const stopped = pair(MEASURE.stoppedNames, MEASURE.stoppedCount);
  if (stopped) fields.stopped = { names: stopped[0], count: stopped[1] };
  const environment = pair(MEASURE.environmentFull, MEASURE.environmentVersion);
  if (environment) fields.environment = { full: environment[0], version: environment[1] };
  const template = form(MEASURE.template);
  if (template !== undefined) fields.template = template;
  const due = pair(MEASURE.dueFull, MEASURE.dueCount);
  if (due) fields.due = { full: due[0], count: due[1] };
  const nextSync = form(MEASURE.nextSync);
  if (nextSync !== undefined) fields.nextSync = nextSync;
  const freshness = widthOf(root.querySelector('[data-field="freshness"]'));
  if (freshness !== undefined) fields.freshness = freshness;
  return {
    fields,
    width: { first, second: row ? innerWidth(row) : 0 },
    gap: gapOf(getComputedStyle(root)),
  };
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The top row's fold plan (PS-18), re-planned when the snapshot changes and whenever the row or a
 * field resizes. `undefined` until the row has been measured.
 */
export function useFoldPlan(
  root: RefObject<HTMLElement | null>,
  snapshot: { sweptAt: string; stations: readonly unknown[] } | undefined,
): FoldPlan | undefined {
  const [plan, setPlan] = useState<FoldPlan>();
  const last = useRef<{ plan?: FoldPlan; measured?: Measured; sweep?: string; pips: number }>({
    pips: 0,
  });
  const replan = useCallback(
    (trigger?: StripTrigger) => {
      const element = root.current;
      if (!element) return;
      const measured = measureStrip(element, last.current.pips);
      if (!measured) return;
      const before = last.current.measured;
      const change =
        trigger ??
        (before && !sameJson(before.width, measured.width)
          ? "resize"
          : !sameJson(before, measured)
            ? "content"
            : undefined);
      if (!change) return;
      const next = planFold({
        ...measured,
        change: FOLD_CHANGE[change],
        previous: last.current.plan,
      });
      last.current.plan = next;
      last.current.measured = measured;
      setPlan((current) => (current && sameJson(current, next) ? current : next));
    },
    [root],
  );

  const observer = useRef<{ observer: ResizeObserver; targets: Set<Element> }>(undefined);
  useLayoutEffect(() => {
    const current = { observer: new ResizeObserver(() => replan()), targets: new Set<Element>() };
    observer.current = current;
    return () => {
      current.observer.disconnect();
      observer.current = undefined;
    };
  }, [replan]);
  useLayoutEffect(() => {
    const current = observer.current;
    const element = root.current;
    if (!current || !element) return;
    const targets = new Set<Element>([
      element,
      ...element.querySelectorAll(
        '[data-strip-row="second"], [data-measure], [data-field="freshness"]',
      ),
    ]);
    for (const target of current.targets) {
      if (!targets.has(target)) current.observer.unobserve(target);
    }
    for (const target of targets) {
      if (!current.targets.has(target)) current.observer.observe(target);
    }
    current.targets = targets;
  });

  useLayoutEffect(() => {
    if (!snapshot) return;
    last.current.pips = snapshot.stations.length;
    const trigger = last.current.sweep === snapshot.sweptAt ? "refresh" : "sweep";
    last.current.sweep = snapshot.sweptAt;
    replan(trigger);
  }, [snapshot, replan]);

  return snapshot ? plan : undefined;
}
