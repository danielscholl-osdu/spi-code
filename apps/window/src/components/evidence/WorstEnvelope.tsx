// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Envelope } from "@spi-code/contracts";
import { EnvelopeBadge } from "./EnvelopeBadge.js";

// Worst first (EV-01 states): a failed read breaks the value outright, unread leaves nothing to
// draw, incomplete draws part of it, stale draws all of it late, fresh is sound.
const severity: Record<Envelope["state"], number> = {
  fresh: 0,
  stale: 1,
  incomplete: 2,
  unread: 3,
  failed: 4,
};

const UNREAD: Envelope = { source: "none", state: "unread" };

// On equal state an inferred envelope wins, so the title bar says "inferred" (EV-03) whenever
// any area at the worst state rests on inferred sources.
export function worstEnvelope(envelopes: readonly Envelope[]): Envelope {
  let worst: Envelope | undefined;
  for (const envelope of envelopes) {
    if (!worst) worst = envelope;
    else {
      const delta = severity[envelope.state] - severity[worst.state];
      if (delta > 0 || (delta === 0 && envelope.inferred === true && worst.inferred !== true))
        worst = envelope;
    }
  }
  return worst ?? UNREAD;
}

export function WorstEnvelope({
  envelopes,
  now,
}: {
  envelopes: readonly Envelope[];
  now?: number | undefined;
}) {
  return <EnvelopeBadge envelope={worstEnvelope(envelopes)} now={now} />;
}
