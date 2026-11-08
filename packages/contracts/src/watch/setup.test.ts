// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, it } from "vitest";
import { blocksWatch, SetupToolSchema } from "./setup.js";

it.each(["git", "gh"] as const)(
  "%s blocks Watch except when ready or needing an update",
  (tool) => {
    for (const state of SetupToolSchema.shape.state.options) {
      expect(blocksWatch({ tool, state }), `${tool}: ${state}`).toBe(
        state !== "ready" && state !== "needs-update",
      );
    }
  },
);

it.each(["copilot", "glab"] as const)("%s never blocks Watch", (tool) => {
  for (const state of SetupToolSchema.shape.state.options) {
    expect(blocksWatch({ tool, state }), `${tool}: ${state}`).toBe(false);
  }
});
