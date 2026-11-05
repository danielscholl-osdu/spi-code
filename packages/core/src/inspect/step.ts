// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { CoreContext } from "../context.js";
import type { Model } from "../model/index.js";
import type { TemplateStep } from "../model/template.js";
import type { CanvasTone } from "../tone.js";
import { clip, plural, short, stamp } from "../util.js";

export const STEP_PREFIX = "step:";
const CHANGE_PREFIX = /^(\w+)(\([^)]*\))?!?:\s*/;
const ROUTINE = Object.freeze([/^(build|chore)\(deps/, /^Bump /, /^chore(\([^)]*\))?: release /]);

function notable(step: TemplateStep): string | undefined {
  const pick = step.changes.find((c) => !ROUTINE.some((r) => r.test(c.title))) ?? step.changes[0];
  return pick
    ? clip(pick.title.replace(CHANGE_PREFIX, "").replace(/\s*\(#\d+\)$/, ""), 48)
    : undefined;
}

export function spreadText(step: TemplateStep, total: number): string {
  const parts = [`${step.adopted.length} of ${total}`];
  const behind = total - step.adopted.length - step.unmeasured.length;
  if (behind > 0 && step.noPr.length === behind) parts.push("no PR carries it yet");
  else {
    if (step.waiting.length) parts.push(`${step.waiting.length} waiting`);
    if (step.failing.length) parts.push(`${step.failing.length} failing`);
    if (step.noPr.length) parts.push(`${step.noPr.length} without a PR`);
  }
  if (step.unmeasured.length) parts.push(`${step.unmeasured.length} unread`);
  return parts.join(" · ");
}

function stepText(step: TemplateStep): string {
  if (step.changes.length === 0) return "the oldest fork position";
  const reach =
    step.consequences.length > 0
      ? step.consequences.join(", ")
      : step.unread === step.changes.length
        ? "reach unread"
        : "template only";
  return [plural(step.changes.length, "change"), reach, notable(step)].filter(Boolean).join(" · ");
}

export interface LadderSection {
  title: string;
  items: {
    chip: { label: string; tone: CanvasTone };
    text: string;
    trailing: string;
    inspect: string;
  }[];
}

export function ladderSection(model: Model, bySha = false): LadderSection | undefined {
  const t = model.template;
  if (t.steps.length === 0) return undefined;
  return {
    title: "Release ladder · newest first",
    items: t.steps.map((step) => ({
      chip: { label: bySha ? short(step.marker) : step.label, tone: step.head ? "info" : "neutral" },
      text: bySha ? `${step.label} · ${stepText(step)}` : stepText(step),
      trailing: spreadText(step, t.rows.length),
      inspect: `${STEP_PREFIX}${step.marker}`,
    })),
  };
}

export function stepTitle(model: Model, id: string): string | undefined {
  const step = model.template.steps.find((s) => `${STEP_PREFIX}${s.marker}` === id);
  return step ? `osdu-spi · ${step.label}` : undefined;
}

export interface StepInspection {
  status: { label: string; tone: CanvasTone };
  chip?: string;
  summary: string;
  changes: { text: string; trailing: string; href: string }[];
  forks: { glyph: CanvasTone; text: string; trailing: string }[];
  evidence: { text: string; href: string }[];
}

export function inspectStep(model: Model, id: string, context: CoreContext): StepInspection {
  const steps = model.template.steps;
  const at = steps.findIndex((s) => `${STEP_PREFIX}${s.marker}` === id);
  const step = steps[at];
  if (!step) {
    return {
      status: { label: "MOVED", tone: "neutral" },
      summary: "No fork sits at this position any more; the ladder redrew.",
      changes: [],
      forks: [],
      evidence: [],
    };
  }
  const older = steps[at + 1];
  const now = context.clock.now();
  return {
    status: { label: step.label, tone: step.head ? "info" : "neutral" },
    chip: spreadText(step, model.template.rows.length),
    summary: older
      ? `${plural(step.changes.length, "change")} from ${older.label} to ${step.label}${step.consequences.length ? `, reaching ${step.consequences.join(", ")}` : ""}.`
      : `${step.label} is the oldest position a fork holds.`,
    changes: step.changes.map((c) => ({
      text: c.title,
      trailing: [c.pr ? `#${c.pr}` : undefined, stamp(c.at, now)].filter(Boolean).join(" · "),
      href: c.url,
    })),
    forks: [
      ...step.adopted.map((f) => ({ glyph: "ok" as const, text: f, trailing: "on it" })),
      ...step.waiting.map((f) => ({ glyph: "info" as const, text: f, trailing: "PR waits" })),
      ...step.failing.map((f) => ({ glyph: "warn" as const, text: f, trailing: "PR fails" })),
      ...step.noPr.map((f) => ({ glyph: "neutral" as const, text: f, trailing: "no PR carries it" })),
      ...step.unmeasured.map((f) => ({ glyph: "neutral" as const, text: f, trailing: "unread" })),
    ],
    evidence: step.url ? [{ text: "Compare on GitHub", href: step.url }] : [],
  };
}
