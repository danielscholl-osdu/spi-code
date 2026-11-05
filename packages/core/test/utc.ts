// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { afterAll } from "vitest";

const previous = process.env.TZ;
process.env.TZ = "Etc/UTC";

afterAll(() => {
  if (previous === undefined) delete process.env.TZ;
  else process.env.TZ = previous;
});
