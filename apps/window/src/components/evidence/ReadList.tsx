// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ReadRecord } from "@spi-code/contracts";
import { InferredMarker } from "./EnvelopeBadge.js";

export function ReadList({ records }: { records: readonly ReadRecord[] }) {
  return (
    <ul aria-label="Reads" style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {records.map((record) => (
        <li key={`${record.source}/${record.object}`} data-read={record.object}>
          <strong>{record.source}</strong> {record.object} ·{" "}
          <time dateTime={record.observedAt}>observed {record.observedAt}</time>
          {record.retainedFrom !== undefined && (
            <>
              {" "}
              · <time dateTime={record.retainedFrom}>retained from {record.retainedFrom}</time>
            </>
          )}
          {record.completeness.kind === "cut" && (
            <>
              {" "}
              · cut {record.completeness.read} of {record.completeness.total} (
              {record.completeness.reason})
            </>
          )}
          {record.failure !== undefined && (
            <span style={{ color: "var(--error-text)" }}> · failed: {record.failure}</span>
          )}
          {record.inferred === true && <InferredMarker />}
        </li>
      ))}
    </ul>
  );
}
