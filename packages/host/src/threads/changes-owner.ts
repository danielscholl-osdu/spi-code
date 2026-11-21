// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { KNOWN_SERVICES, parseFilter, type ServicePathRule, servicePathRule } from "@spi-code/core";
import type { ThreadChanges } from "./changes.js";

const FILTER_PATH = ".github/upstream-filter.yml";
const FILTER_LIMIT = 128 * 1024;

async function filterText(worktree: string): Promise<string | undefined> {
  try {
    const handle = await open(
      join(worktree, FILTER_PATH),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > FILTER_LIMIT) return undefined;
      return await handle.readFile({ encoding: "utf8" });
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

export async function pathRuleForWorktree(
  scope: string,
  worktree: string,
): Promise<ServicePathRule | undefined> {
  const service = KNOWN_SERVICES.find((entry) => entry.id === scope);
  if (!service) return undefined;
  const text = await filterText(worktree);
  return text === undefined ? undefined : servicePathRule(service, parseFilter(text));
}

export function withPathOwners(
  changes: ThreadChanges,
  rule: ServicePathRule | undefined,
): ThreadChanges {
  if (changes.state !== "read" || !rule) return changes;
  return {
    ...changes,
    files: changes.files.map((file) => {
      const owner = rule(file.path);
      return owner ? { ...file, owner } : file;
    }),
  };
}
