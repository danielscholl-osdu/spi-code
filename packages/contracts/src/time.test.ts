// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, it } from "vitest";
import { when } from "./time.js";

// 2026-11-06 09:04 in Chicago, a Friday; Chicago left daylight time on Sunday 1 Nov.
const now = Date.parse("2026-11-06T15:04:00Z");
const chicago = { now, timeZone: "America/Chicago" };
const tokyo = { now, timeZone: "Asia/Tokyo" };

it.each([
  ["earlier today", "2026-11-06T06:10:00Z", chicago, "00:10"],
  ["later today", "2026-11-06T23:30:00Z", chicago, "17:30"],
  ["yesterday, by the calendar and not 24 hours", "2026-11-06T05:50:00Z", chicago, "Thu 23:50"],
  ["tomorrow", "2026-11-07T06:00:00Z", chicago, "Sat 00:00"],
  ["six days back, across the DST change", "2026-10-31T13:00:00Z", chicago, "Sat 08:00"],
  ["a week back", "2026-10-30T13:00:00Z", chicago, "30 Oct"],
  ["a week ahead", "2026-11-13T15:00:00Z", chicago, "13 Nov"],
  ["another year", "2025-12-24T18:00:00Z", chicago, "24 Dec 2025"],
  [
    "seven local dates back, under 168 hours",
    "2026-11-09T16:00:00Z",
    { now: Date.parse("2026-11-16T15:00:00Z"), timeZone: "America/Chicago" },
    "9 Nov",
  ],
  [
    "six local dates back across the DST change, 168 hours",
    "2026-10-26T05:01:00Z",
    { now: Date.parse("2026-11-02T05:01:00Z"), timeZone: "America/Chicago" },
    "Mon 00:01",
  ],
  [
    "400 days on, in another year",
    "2026-11-16T15:00:00Z",
    { now: Date.parse("2026-11-16T15:00:00Z") + 400 * 86_400_000, timeZone: "Pacific/Kiritimati" },
    "17 Nov 2026",
  ],
  ["in the operator's own zone, another day", "2026-11-06T14:30:00Z", tokyo, "Fri 23:30"],
  ["in the operator's own zone, the same day", "2026-11-06T15:30:00Z", tokyo, "00:30"],
])("reads a time %s on the operator's clock", (_, at, options, expected) => {
  expect(when(at, options)).toBe(expected);
});
