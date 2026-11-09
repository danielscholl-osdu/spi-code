// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, it } from "vitest";
import { parseDestination } from "./destination.js";

it("accepts only the closed set of window destinations", () => {
  expect(parseDestination({ to: "evidence" })).toEqual({ to: "evidence" });
  expect(parseDestination({ to: "today", item: "halt:partition" })).toEqual({
    to: "today",
    item: "halt:partition",
  });
  for (const input of [
    { to: "settings" },
    { to: "evidence", item: "x" },
    { to: "constructor" },
    { to: ["evidence"] },
    ["evidence"],
    "evidence",
    null,
    undefined,
    { to: "today" },
    { to: "today", item: "halt:partition", extra: true },
    ...[
      "",
      "/tmp/file",
      "../file",
      "C:\\file",
      "C:/file",
      "private/file",
      "file:private",
      "data:payload",
      "javascript:alert(1)",
      "vbscript:msgbox",
      "a".repeat(257),
      "a".repeat(1024 * 1024),
      "__proto__",
      "constructor",
      "prototype",
      "a:../../etc/passwd",
      "a:repo/../file",
      "a:repo/..",
      "a:..",
      "%2e%2e",
      "a:%2E%2E/x",
      "a:x/%2e%2e",
      "a:..%2fetc",
      "a:x%2F..",
      "a:x..%2Fetc",
      "a:x/..suffix",
      "a:x../suffix",
      " javascript:",
      "halt:partition ",
      "\thalt:partition",
      "halt:partition\u00a0",
      "a:\u0000",
      "a:\n",
      "a:\u007f",
      "a:\u0085",
      "a:\u2028",
      "a:\u2029",
      "https://example.com",
      " ",
      3,
      null,
    ].map((item) => ({ to: "today", item })),
  ])
    expect(parseDestination(input)).toBeUndefined();
  for (const item of [
    "access:owner/repository#12",
    "security:code:unsafe workflow",
    "a".repeat(256),
    "branch:v1..2",
    "campaign:toolchain:os-core-common%2010.0.0",
  ])
    expect(parseDestination({ to: "today", item })).toEqual({ to: "today", item });
});
