// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ReadRecord } from "@spi-code/contracts";
import type { ReactNode } from "react";
import { InferredMarker } from "./EnvelopeBadge.js";

export function Derived({ record, children }: { record?: ReadRecord; children: ReactNode }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: 0 }}>
      {children}
      {record?.inferred === true && <InferredMarker />}
    </span>
  );
}
