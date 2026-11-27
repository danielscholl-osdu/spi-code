// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { allGuides, findGuide, SPI_GUIDE } from "../threads/context/knowledge.js";
import { buildGatedTool, checkStubTier, type GatedTool, type TierCheck } from "./registry.js";

/** A guide by id. It reads no sweep, so it answers before the first one is saved. */
export function spiGuideTool(check: TierCheck = checkStubTier): GatedTool {
  return buildGatedTool(
    { name: SPI_GUIDE, tier: "Read", milestone: "M3" },
    z.strictObject({ id: z.string().min(1) }),
    check,
    ({ id }) => {
      const guide = findGuide(id);
      return JSON.stringify(
        guide
          ? {
              guide: guide.id,
              title: guide.title,
              checked: guide.checked,
              steps: guide.steps,
            }
          : {
              found: false,
              reason: `No guide ${id}.`,
              guides: allGuides().map(({ id: known, when }) => ({ id: known, when })),
            },
      );
    },
    "One program guide by id: the steps for a kind of work that recurs, with what they were checked against. It is standing knowledge, not a read of the sweep.",
  );
}
