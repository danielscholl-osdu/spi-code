// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { ReleaseVersionSchema } from "./panes.js";

describe("Today release version contract", () => {
  it("distinguishes released, unread and never-cut rows by state", () => {
    for (const [state, fields] of [
      ["released", { released: "1.4.1" }],
      ["unread", {}],
      ["none", {}],
    ] as const) {
      const row = { service: "storage", state, ...fields, text: "core words" };
      expect(ReleaseVersionSchema.parse(row)).toEqual(row);
    }
  });

  it("rejects version claims on unread and never-cut rows", () => {
    for (const state of ["unread", "none"]) {
      for (const fields of [
        { released: "?" },
        { released: "1.4.1" },
        { proposed: "1.5.0" },
        { pr: { number: 75 } },
      ]) {
        expect(
          ReleaseVersionSchema.safeParse({
            service: "storage",
            state,
            ...fields,
            text: "core words",
          }).success,
        ).toBe(false);
      }
    }
  });
});
