// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { HorizonCardSchema } from "@spi-code/contracts";
import type { JsonValue, ToolOutputRedactor } from "@spi-code/threads";

export type SpiRedactor = Pick<ToolOutputRedactor, "value">;
type JsonObject = { readonly [key: string]: JsonValue };

function object(value: JsonValue | undefined): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function horizonCards(value: JsonValue) {
  const root = object(value);
  const briefing = object(root?.briefing);
  const horizon = object(briefing?.horizon);
  const cards = horizon?.cards;
  if (Array.isArray(cards))
    return { root, briefing, horizon, cards: cards as readonly JsonValue[] };
}

/** Only ViewSnapshot.briefing.horizon.cards[*].token is a theme name. Its text is still redacted. */
export function redactSpiValue(output: unknown, journal: SpiRedactor): JsonValue {
  const payload: JsonValue = JSON.parse(JSON.stringify(output));
  const redacted = journal.value(payload);
  const original = horizonCards(payload);
  if (!original) return redacted;
  const safe = horizonCards(redacted);
  if (!safe) return redacted;
  const cards = safe.cards.map((card, index) => {
    const field = object(card);
    const originalCard = HorizonCardSchema.safeParse(original.cards[index]);
    return field && originalCard.success && Object.hasOwn(field, "token")
      ? { ...field, token: journal.value(originalCard.data.token) }
      : card;
  });
  return {
    ...safe.root,
    briefing: { ...safe.briefing, horizon: { ...safe.horizon, cards } },
  };
}

export function redactSpiText(output: string, journal: SpiRedactor): string {
  let value: JsonValue = output;
  try {
    const parsed: JsonValue = JSON.parse(output);
    if (parsed !== null && typeof parsed === "object") value = parsed;
  } catch {
    // Tool errors and older attachments can be plain text.
  }
  const safe = journal.value(value);
  const text = typeof value === "string" ? safe : JSON.stringify(safe);
  if (typeof text === "string") return text;
  throw new Error("Invalid redacted text.");
}
