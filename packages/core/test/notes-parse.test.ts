// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { parseNotes } from "../src/notes.js";

describe("release notes text", () => {
  const path = "/notes/2026-10.json";

  it("distinguishes missing text from a valid notes document", () => {
    expect(parseNotes(path, undefined)).toEqual({ state: "missing", path });
    expect(parseNotes(path, '{"headline":"kept"}')).toEqual({
      state: "ok",
      path,
      notes: {
        status: "draft",
        headline: "kept",
        keyChanges: [],
        actions: [],
        highlights: [],
        knownIssues: [],
      },
    });
  });

  it("a file that does not parse says where", () => {
    const read = parseNotes(path, JSON.stringify({ status: "shipped" }));
    expect(read.state).toBe("invalid");
    expect(read.state === "invalid" ? read.error : "").toMatch(/^status:/);
    expect(parseNotes("/notes/2026-09.json", "{").state).toBe("invalid");
  });

  it("reads YAML notes with the same defaults as JSON", () => {
    const notes = {
      status: "approved",
      headline: "Four forks",
      actions: [{ level: "required", title: "Upgrade", owner: "SPI" }],
    };
    expect(
      parseNotes(
        path,
        "status: approved\nheadline: Four forks\nactions:\n  - level: required\n    title: Upgrade\n    owner: SPI\n",
      ),
    ).toEqual(parseNotes(path, JSON.stringify(notes)));
  });

  it("reports malformed YAML with the path and a syntax error", () => {
    expect(parseNotes(path, "headline: [unterminated")).toEqual({
      state: "invalid",
      path,
      error: expect.stringMatching(/^not YAML: .+/s),
    });
  });

  it("reports the first nested schema issue", () => {
    expect(parseNotes(path, '{"actions":[{"level":"urgent","title":"Upgrade"}]}')).toEqual({
      state: "invalid",
      path,
      error: expect.stringMatching(/^actions\.0\.level:/),
    });
  });

  it("rejects empty text, non-object documents and unknown fields", () => {
    for (const raw of ["", "null", "[]", "headline: Valid\nextra: true"]) {
      expect(parseNotes(path, raw)).toEqual({
        state: "invalid",
        path,
        error: expect.stringMatching(/^file:/),
      });
    }
  });
});
