// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect } from "vitest";
import type { Evidence } from "../../store/evidence.js";
import { sectionSources } from "./SectionEvidence.js";

/**
 * Coarse EV-03 over a rendered view: each section in `sections` shows its one line iff a feeding
 * source is not fresh or every one is inferred, no other section line is drawn, and no value
 * carries a mark or an envelope badge of its own.
 */
export function expectEvidenceMarks(
  root: Element,
  evidence: Evidence,
  { sections }: { sections: string[][] },
) {
  let shown = 0;
  for (const section of sections) {
    const sources = sectionSources(evidence, section);
    expect(sources.length, section.join(" ")).toBeGreaterThan(0);
    const expected =
      sources.some(({ envelope }) => envelope.state !== "fresh") ||
      sources.every(({ envelope }) => envelope.inferred === true);
    const line = root.querySelectorAll(`[data-section-evidence="${section.join(" ")}"]`);
    expect(line.length, section.join(" ")).toBe(expected ? 1 : 0);
    if (expected) shown++;
  }
  expect(root.querySelectorAll("[data-section-evidence]").length).toBe(shown);
  expect(
    [...root.querySelectorAll("[data-inferred]")].filter(
      (mark) => !mark.closest("[data-section-evidence]"),
    ),
  ).toEqual([]);
  expect(root.querySelectorAll("[data-envelope]").length, "per-value envelope badges").toBe(0);
}

/** The plain fixture: no area fed a value, so no section line, mark or badge is drawn. */
export function expectNoEvidenceMarks(root: Element) {
  expect(root.querySelectorAll("[data-section-evidence]").length).toBe(0);
  expect(root.querySelectorAll("[data-inferred]").length).toBe(0);
  expect(root.querySelectorAll("[data-envelope]").length, "per-value envelope badges").toBe(0);
}
