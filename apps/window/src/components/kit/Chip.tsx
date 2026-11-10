// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import "./kit.css";

export type ChipTone = "neutral" | "plain" | "bad" | "warn" | "ok" | "accent";

/** Marks only changes not yet in a fork. */
export const INBOUND_GLYPH = "⇣";

export interface ChipProps {
  label: string;
  /** The complete sentence supplied by core, shared by hover and accessible name. */
  text: string;
  tone?: ChipTone;
}

export function Chip({ label, text, tone = "neutral" }: ChipProps) {
  return (
    <span className={`kit-chip kit-chip--${tone}`} role="img" aria-label={text} title={text}>
      {label}
    </span>
  );
}

export interface AgeChipProps {
  /** The age as core words it ("14 h"). */
  age: string;
  text: string;
}

export function AgeChip({ age, text }: AgeChipProps) {
  return (
    <span className="kit-chip kit-chip--age" role="img" aria-label={text} title={text}>
      {age}
    </span>
  );
}

export interface PrBadgeProps {
  number: number;
  text: string;
  onOpen?: () => void;
}

export function PrBadge({ number, text, onOpen }: PrBadgeProps) {
  const label = `#${number}`;
  return onOpen ? (
    <button type="button" className="kit-pr" aria-label={text} title={text} onClick={onOpen}>
      {label}
    </button>
  ) : (
    <span className="kit-pr" role="img" aria-label={text} title={text}>
      {label}
    </span>
  );
}

export interface ServiceChipProps {
  service: string;
  text: string;
  onOpen: () => void;
  pr?: PrBadgeProps;
}

export function ServiceChip({ service, text, onOpen, pr }: ServiceChipProps) {
  const chip = (
    <button
      type="button"
      className="kit-chip kit-chip--service"
      aria-label={text}
      title={text}
      onClick={onOpen}
    >
      {service}
    </button>
  );
  if (!pr) return chip;
  return (
    <span className="kit-service">
      {chip}
      <PrBadge {...pr} />
    </span>
  );
}

export interface UpstreamChipProps {
  /** Words after the glyph ("6 on the horizon"); the glyph stands alone without them. */
  label?: string;
  text: string;
  onOpen?: () => void;
}

export function UpstreamChip({ label, text, onOpen }: UpstreamChipProps) {
  const content = (
    <>
      <span className="kit-inbound" aria-hidden="true">
        {INBOUND_GLYPH}
      </span>
      {label}
    </>
  );
  return onOpen ? (
    <button
      type="button"
      className="kit-chip kit-chip--upstream"
      aria-label={text}
      title={text}
      onClick={onOpen}
    >
      {content}
    </button>
  ) : (
    <span className="kit-chip kit-chip--upstream" role="img" aria-label={text} title={text}>
      {content}
    </span>
  );
}
