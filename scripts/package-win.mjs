// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packageDesktop } from "./package.mjs";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await packageDesktop("win32");
}
