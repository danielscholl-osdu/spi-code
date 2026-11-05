// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { AREAS as CONTRACT_AREAS } from "@spi-code/contracts";
import { describe, expect, it } from "vitest";
import { AREAS } from "../src/facts.js";

describe("area names", () => {
  it("match between core and the window contract, in order", () => {
    expect([...CONTRACT_AREAS]).toEqual([...AREAS]);
  });
});
