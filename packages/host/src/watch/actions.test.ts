// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ActionItem } from "@spi-code/core";
import { describe, expect, it } from "vitest";
import { appActions } from "./actions.js";

process.env.TZ = "UTC";

describe("read-only app actions", () => {
  it("disables eligible and ineligible writes, preserves eligibility reasons and never confirms", () => {
    const items = [
      { type: "merge", label: "Merge", confirm: { irreversible: true, subject: "legal #1" } },
      { type: "rerun", label: "Re-run", disabled: true, reason: "Stack is held" },
    ];
    const before = structuredClone(items);
    expect(appActions(items)).toEqual([
      { id: "merge", label: "Merge", disabledReason: "writes arrive at M4" },
      {
        id: "rerun",
        label: "Re-run",
        disabledReason: "writes arrive at M4",
        eligibilityReason: "Stack is held",
      },
    ]);
    expect(items).toEqual(before);
  });

  it("retains the Re-run when deployable offer even while it cannot run", () => {
    const offer: ActionItem = {
      type: "rerun-when-deployable",
      label: "Re-run when deployable",
      disabled: true,
      reason: "SPI Code has no durable ops here",
      confirm: { subject: "legal #1", body: "Wait for a deployable stack" },
    };
    expect(appActions([offer])).toEqual([
      expect.objectContaining({
        label: "Re-run when deployable",
        disabledReason: "writes arrive at M4",
        eligibilityReason: "SPI Code has no durable ops here",
      }),
    ]);
  });

  it("reports an oversized pending label on its disabled action without losing other actions", () => {
    const items: ActionItem[] = [
      { type: "x", label: "X", pendingLabel: "a".repeat(41), reason: "Stack held" },
      { type: "y", label: "Y" },
    ];
    expect(appActions(items)).toEqual([
      {
        id: "x",
        label: "X",
        disabledReason: "writes arrive at M4",
        eligibilityReason: "Stack held; pendingLabel exceeds 40 characters",
      },
      { id: "y", label: "Y", disabledReason: "writes arrive at M4" },
    ]);
    expect(items[0]?.pendingLabel).toHaveLength(41);
    expect(appActions([{ type: "x", label: "X", pendingLabel: "a".repeat(40) }])).toHaveLength(1);
  });

  it("gives repeated act types unique IDs that are stable across projections", () => {
    const items: ActionItem[] = [
      { type: "act", label: "Merge" },
      { type: "act", label: "Re-run" },
      { type: "act-2", label: "Other action" },
      { type: "act", label: "Dispatch" },
    ];
    const actions = appActions(items);
    expect(actions.map(({ id }) => id)).toEqual(["act", "act-3", "act-2", "act-4"]);
    expect(appActions(structuredClone(items))).toEqual(actions);
  });

  it("requires a nonblank subject for irreversible actions before stripping confirmation", () => {
    for (const subject of [undefined, "", " "]) {
      expect(() =>
        appActions([
          {
            type: "x",
            label: "X",
            confirm: { irreversible: true, ...(subject === undefined ? {} : { subject }) },
          },
        ]),
      ).toThrow("subject");
    }
  });
});
