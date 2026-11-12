// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

it("leaves out of the review id exactly the files scripts/watch-snapshot.ts writes", () => {
  const excluded = /generated=\(\n([^)]*)\)/
    .exec(read("./review-patch-id"))?.[1]
    ?.trim()
    .split(/\s+/);
  const written = read("../packages/host/src/watch/snapshot-fixture.ts").match(
    /fixtures\/watch\/[\w.-]+\.json/g,
  );

  expect(written?.length).toBeGreaterThan(0);
  expect(excluded).toEqual([...new Set(written)].sort());
});
