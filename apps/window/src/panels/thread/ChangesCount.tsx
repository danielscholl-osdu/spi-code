// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ThreadTabProps } from "./tab.js";
import { useChanges } from "./useChanges.js";

export function ChangesCount({ id }: ThreadTabProps) {
  const changes = useChanges(id);
  return <>Changes{changes?.state === "read" ? ` ${changes.files.length}` : ""}</>;
}
