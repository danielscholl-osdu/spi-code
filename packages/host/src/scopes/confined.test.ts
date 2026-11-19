// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { sep } from "node:path";
import { expect, it } from "vitest";
import { installRoot } from "./confined.js";

const native = (path: string) => path.split("/").join(sep);

it("grants Git's install prefix read-only, never a directory holding the home or app data", () => {
  const guarded = ["/Users/op", "/Users/op/Library/Application Support/SPI Code"].map(native);
  expect(
    [
      "/opt/homebrew/Cellar/git/2.56.0_2/bin/git",
      "/usr/local/Cellar/git/2.56.0/bin/git",
      "/usr/bin/git",
      "/Library/Developer/CommandLineTools/usr/bin/git",
      "/bin/git",
      "/git",
      "/Users/op/bin/git",
      "/Users/op/git",
      "/Users/op/Cellar/git/2.56.0/bin/git",
      "/Users/git",
    ].map((binary) => installRoot(native(binary), guarded)),
  ).toEqual(
    [
      "/opt/homebrew",
      "/usr/local",
      "/usr",
      "/Library/Developer/CommandLineTools/usr",
      "/bin",
      "/git",
      "/Users/op/bin",
      "/Users/op/git",
      "/Users/op/Cellar/git/2.56.0/bin",
      "/Users/git",
    ].map(native),
  );
});
