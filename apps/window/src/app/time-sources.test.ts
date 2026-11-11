// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { expect, it } from "vitest";

const source = resolve("apps/window/src");
const formatting =
  /toLocale(Time|Date)String|Intl\.DateTimeFormat|\btimeZone\b|\bUTC\b|toUTCString|getUTC\w+|toISOString/;
// time.tsx is the one formatter; the strip hands its derived next-sync instant to it as ISO.
const allowed = new Set(["time.tsx", "store/strip.ts:toISOString"]);

it("formats visible times only through time.tsx", () => {
  const files = readdirSync(source, { recursive: true, encoding: "utf8" })
    .map((file) => file.split(sep).join("/"))
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$|test-helper\.ts$/.test(file));
  expect(files).toContain("time.tsx");
  const found = files.flatMap((file) => {
    if (allowed.has(file)) return [];
    return readFileSync(join(source, file), "utf8")
      .split("\n")
      .flatMap((line, index) => {
        const match = formatting.exec(line);
        return match && !allowed.has(`${file}:${match[0]}`)
          ? [`${file}:${index + 1}: ${line.trim()}`]
          : [];
      });
  });
  expect(found).toEqual([]);
});
