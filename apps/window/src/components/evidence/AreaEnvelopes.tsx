// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type Evidence, envelopesForAll, isInferred } from "../../store/evidence.js";
import { EnvelopeBadge, InferredMarker } from "./EnvelopeBadge.js";

/** The envelope of every area feeding a section's values (EV-03); nothing when none fed it. */
export function AreaEnvelopes({
  evidence,
  prefixes,
}: {
  evidence: Evidence;
  prefixes: readonly string[];
}) {
  const envelopes = envelopesForAll(evidence, prefixes);
  if (envelopes.length === 0) return null;
  return (
    <span
      data-envelopes={prefixes.join(" ")}
      style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "4px 0", fontSize: "10.5px" }}
    >
      {envelopes.map(({ area, envelope }) => (
        <span key={area} data-area={area} style={{ color: "var(--text-muted)" }}>
          {area} <EnvelopeBadge envelope={envelope} />
        </span>
      ))}
    </span>
  );
}

/** The inferred marker for the value at the pointer, when only inferred areas fed it. */
export function InferredMark({ evidence, pointer }: { evidence: Evidence; pointer: string }) {
  return isInferred(evidence, pointer) ? <InferredMarker /> : null;
}
