// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readdirSync } from "node:fs";
import { sep } from "node:path";

/** Every file under root, as a "/"-separated path relative to root on every OS. */
export function sourceFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: "utf8" }).map((file) =>
    file.split(sep).join("/"),
  );
}
