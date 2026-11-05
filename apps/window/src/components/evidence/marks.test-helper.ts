// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect } from "vitest";
import { type Evidence, envelopesForAll, isInferred } from "../../store/evidence.js";

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);
const valueMarks = (root: Element) =>
  [...root.querySelectorAll("[data-inferred]")].filter((mark) => !mark.closest("[data-envelopes]"));

/**
 * EV-03 over a rendered view: every provenance value under `prefixes` (less `skip`, the ones the
 * view does not draw) carries exactly one inferred marker iff only inferred areas fed it, no
 * other value is marked, and each section in `sections` badges exactly the areas feeding it.
 */
export function expectEvidenceMarks(
  root: Element,
  evidence: Evidence,
  { prefixes, sections, skip = [] }: { prefixes: string[]; sections: string[][]; skip?: string[] },
) {
  const paths = evidence.provenance
    .map(({ path }) => path)
    .filter((path) => prefixes.some((prefix) => under(path, prefix)) && !skip.includes(path));
  expect(paths.length).toBeGreaterThan(0);
  for (const path of paths) {
    const drawn = [...root.querySelectorAll(`[data-pointer="${path}"]`)];
    expect(drawn.length, path).toBeGreaterThan(0);
    for (const element of drawn) {
      const own = valueMarks(element).filter((mark) => mark.closest("[data-pointer]") === element);
      expect(own.length, path).toBe(isInferred(evidence, path) ? 1 : 0);
    }
  }
  for (const mark of valueMarks(root)) {
    const pointer = mark.closest("[data-pointer]")?.getAttribute("data-pointer") ?? "";
    expect(isInferred(evidence, pointer), pointer).toBe(true);
  }
  for (const section of sections) {
    const badge = root.querySelector(`[data-envelopes="${section.join(" ")}"]`);
    const expected = envelopesForAll(evidence, section);
    expect(expected.length, section.join(" ")).toBeGreaterThan(0);
    expect(
      [...(badge?.querySelectorAll("[data-area]") ?? [])].map((area) => [
        area.getAttribute("data-area"),
        area.querySelector("[data-inferred]") !== null,
      ]),
      section.join(" "),
    ).toEqual(expected.map(({ area, envelope }) => [area, envelope.inferred === true]));
  }
  expect(root.querySelectorAll("[data-envelopes]").length).toBe(sections.length);
}

/** The plain fixture: no area fed a value, so nothing is badged or marked. */
export function expectNoEvidenceMarks(root: Element) {
  expect(root.querySelectorAll("[data-envelopes]").length).toBe(0);
  expect(root.querySelectorAll("[data-inferred]").length).toBe(0);
}
