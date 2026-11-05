// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Envelope } from "@spi-code/contracts";
import type { CSSProperties } from "react";

export type EnvelopeTone = "fresh" | "stale" | "bad" | "muted";

const tones: Record<Envelope["state"], EnvelopeTone> = {
  fresh: "fresh",
  stale: "stale",
  incomplete: "stale",
  failed: "bad",
  unread: "muted",
};

const colours: Record<EnvelopeTone, string> = {
  fresh: "var(--success-text)",
  stale: "var(--warning-text)",
  bad: "var(--error-text)",
  muted: "var(--text-muted)",
};

export const chipStyle: CSSProperties = {
  display: "inline-block",
  fontSize: "10.5px",
  fontWeight: 600,
  borderRadius: 4,
  padding: "0 6px",
  border: "1px solid var(--border)",
  background: "var(--chrome)",
};

export function InferredMarker() {
  return (
    <span
      data-inferred=""
      style={{
        ...chipStyle,
        color: "var(--text-muted)",
        borderStyle: "dashed",
        marginInlineStart: 6,
      }}
    >
      inferred
    </span>
  );
}

function age(observedAt: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(observedAt)) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}

export function envelopeText(envelope: Envelope, now?: number): string {
  const { state, source } = envelope;
  if (state === "unread") return `unread · ${source}`;
  if (state === "failed") return `read failed · ${source}`;
  if (state === "incomplete") {
    const { completeness } = envelope;
    return completeness.kind === "cut"
      ? `incomplete · ${completeness.read} of ${completeness.total}`
      : "incomplete";
  }
  return now !== undefined && envelope.observedAt !== undefined
    ? `${state} · ${age(envelope.observedAt, now)}`
    : state;
}

export function EnvelopeBadge({ envelope, now }: { envelope: Envelope; now?: number | undefined }) {
  const tone = tones[envelope.state];
  return (
    <span data-envelope={envelope.state} style={{ whiteSpace: "nowrap" }}>
      <span data-tone={tone} style={{ ...chipStyle, color: colours[tone] }}>
        {envelopeText(envelope, now)}
      </span>
      {envelope.inferred === true && <InferredMarker />}
    </span>
  );
}
