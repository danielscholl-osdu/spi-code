// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SweepProgress, ViewSnapshot } from "@spi-code/contracts";
import { AREA_NAMES } from "../../components/evidence/words.js";
import { readinessCanFix } from "../../components/sweep/words.js";
import { Time } from "../../time.js";

/** Areas whose read failed or was cut this sweep, in the snapshot's area order. */
export function caveatAreas(snapshot: Pick<ViewSnapshot, "areas">) {
  return snapshot.areas.filter(
    ({ envelope }) => envelope.state === "failed" || envelope.state === "incomplete",
  );
}

/** The full-width note under the headline when a read failed or was cut; nothing otherwise. */
export function CaveatBand({
  snapshot,
  completed,
  onOpenEvidence,
  onOpenSettings,
}: {
  snapshot: Pick<ViewSnapshot, "areas" | "sweptAt">;
  completed: SweepProgress | null;
  onOpenEvidence: () => void;
  onOpenSettings: () => void;
}) {
  const affected = caveatAreas(snapshot);
  if (affected.length === 0) return null;
  const fixable = affected.some(({ area }) => {
    const source = completed?.sources.find((entry) => entry.source === area);
    return readinessCanFix(source && "code" in source ? source.code : undefined);
  });
  return (
    <div className="today-caveat" role="note">
      <ul>
        {affected.map(({ area, envelope }) => (
          <li key={area} data-area={area}>
            {AREA_NAMES[area]}{" "}
            {envelope.state === "failed" ? "read failed" : "was read only in part"} at{" "}
            <Time at={snapshot.sweptAt} hint={false} />; items from it may be missing.
          </li>
        ))}
      </ul>
      <span className="today-caveat-actions">
        <button type="button" onClick={onOpenEvidence}>
          Evidence ›
        </button>
        {fixable && (
          <button type="button" onClick={onOpenSettings}>
            Open Settings ›
          </button>
        )}
      </span>
    </div>
  );
}
