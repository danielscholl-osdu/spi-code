// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ReadRecord, ReadRecordSchema, WebUrlSchema } from "@spi-code/contracts";
import type { ReadRecord as CoreReadRecord } from "@spi-code/core";

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
