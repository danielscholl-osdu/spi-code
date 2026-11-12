// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ReleaseDocSchema, ReleasesPaneSchema } from "@spi-code/contracts";
import {
  type CoreContext,
  isMonth,
  monthFacts,
  parseNotes,
  type ReleaseReads,
  releaseDoc,
  releaseLine,
  releaseMonths,
} from "@spi-code/core";

export function readNotes(appData: string, month: string) {
  if (!isMonth(month)) throw new RangeError(`Invalid notes month: ${month}`);
  const path = join(appData, "notes", `${month}.json`);
  let raw: string | undefined;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  return parseNotes(path, raw);
}

export function projectReleases(
  reads: ReleaseReads,
  appData: string,
  now: Date,
  context: CoreContext,
  reading = false,
) {
  const documents = releaseMonths(reads, now).map((month) =>
    releaseDoc(monthFacts(reads, month, now, context), readNotes(appData, month), now),
  );
  return {
    documents: documents.map((doc) => ReleaseDocSchema.parse(doc)),
    pane: ReleasesPaneSchema.parse({ lines: documents.map(releaseLine), reading }),
  };
}
