// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ReadRecord, ReadRecordSchema, WebUrlSchema } from "@spi-code/contracts";
import { type ReadRecord as CoreReadRecord, stamp } from "@spi-code/core";

export function readRecord(record: CoreReadRecord): ReadRecord {
  const { failure, retainedFrom, inferred, ...rest } = record;
  return ReadRecordSchema.parse({
    ...rest,
    ...(failure === undefined ? {} : { failure }),
    ...(retainedFrom === undefined ? {} : { retainedFrom }),
    ...(inferred === undefined ? {} : { inferred }),
  });
}

export function webUrl(url: string | undefined): { url: string } | Record<string, never> {
  return url !== undefined && WebUrlSchema.safeParse(url).success ? { url } : {};
}

/** The host's own result text names a time as an instant, whatever style core's boards use. */
export function instant(iso: string | undefined, now: Date): string | undefined {
  return stamp(iso, now, { timeStyle: "instant" });
}
