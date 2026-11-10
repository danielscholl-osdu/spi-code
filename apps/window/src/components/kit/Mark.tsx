// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import "./kit.css";

export type MarkTier = "interrupt" | "surface" | "ambient" | "background";

const MARKS = {
  interrupt: { glyph: "✕", name: "Interrupt" },
  surface: { glyph: "!", name: "Surface" },
  ambient: { glyph: "◐", name: "Ambient" },
  background: { glyph: "○", name: "Background" },
} as const;

export function Mark({ tier }: { tier: MarkTier }) {
  const { glyph, name } = MARKS[tier];
  return (
    <span className={`kit-mark kit-mark--${tier}`} role="img" aria-label={name} title={name}>
      <span aria-hidden="true">{glyph}</span>
    </span>
  );
}
