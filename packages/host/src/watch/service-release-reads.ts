// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ReadRecord } from "@spi-code/core";
import type { WatchInput } from "./project.js";

export function serviceReleaseReadTimes(repo: string, input: WatchInput) {
  const observed = (reads: readonly ReadRecord[], source: string) => {
    const record = reads.find((read) => read.source === source && read.object === repo);
    return record?.retainedFrom ?? (record?.failure === undefined ? record?.observedAt : undefined);
  };
  const github = observed(input.reads.github ?? [], "github");
  const history = observed(input.releaseRecords, "github-releases");
  return {
    ...(github === undefined ? {} : { github }),
    ...(history === undefined ? {} : { history }),
  };
}
