// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useEffect, useRef, useState } from "react";

export type LandsInChoice = "asking" | "fork-main" | "fork-integration" | "upstream";

export const LANDS_IN_LABELS: Readonly<Record<LandsInChoice, string>> = {
  asking: "Asking · changes nothing",
  "fork-main": "Fork · main",
  "fork-integration": "Fork · fork_integration",
  upstream: "Upstream",
};

export interface LandsInChipProps {
  value: LandsInChoice;
  scope: "service" | "template" | "environment" | "program";
  onChange(choice: LandsInChoice): void;
  disabled?: boolean;
  notice?: string;
}

export function landsInChoices(scope: LandsInChipProps["scope"]): readonly LandsInChoice[] {
  if (scope === "service") return ["asking", "fork-main", "fork-integration", "upstream"];
  if (scope === "template" || scope === "environment") return ["asking", "fork-main"];
  return ["asking"];
}

export function LandsInChip({ value, scope, onChange, disabled, notice }: LandsInChipProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const choices = landsInChoices(scope);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div ref={root} className="thread-lands-in">
      <button
        type="button"
        className="thread-chip"
        aria-label={`Lands in: ${LANDS_IN_LABELS[value]}`}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((next) => !next)}
      >
        {LANDS_IN_LABELS[value]} ▾
      </button>
      {notice && (
        <p className="thread-notice" role="status">
          {notice}
        </p>
      )}
      {open && (
        <ul className="thread-menu" aria-label="Lands in">
          {choices.map((choice) => (
            <li key={choice}>
              <button
                type="button"
                aria-pressed={choice === value}
                onClick={() => {
                  onChange(choice);
                  setOpen(false);
                }}
              >
                {LANDS_IN_LABELS[choice]}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
