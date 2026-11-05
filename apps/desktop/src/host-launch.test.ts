// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, it } from "vitest";
import { hostLaunch } from "./host-launch.js";

it("does not let inherited stub flags alter a packaged normal launch", () => {
  const env = { SPI_CODE_STUB_MODEL: "1", spi_code_stub_model: "1", PATH: "/bin" };
  expect(hostLaunch(true, false, false, env)).toEqual({ args: [], env: { PATH: "/bin" } });
  expect(env.SPI_CODE_STUB_MODEL).toBe("1");
});

it.each([true, false])("passes explicit stub mode for smoke (packaged=%s)", (packaged) => {
  expect(hostLaunch(packaged, true, false, {})).toEqual({ args: ["--stub-model"], env: {} });
});

it("allows the development stub but never substitutes it for a live proof", () => {
  expect(hostLaunch(false, false, false, { SPI_CODE_STUB_MODEL: "1" }).args).toEqual([
    "--stub-model",
  ]);
  expect(hostLaunch(false, false, true, { SPI_CODE_STUB_MODEL: "1" }).args).toEqual([]);
});
