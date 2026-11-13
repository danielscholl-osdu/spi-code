// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ViewSnapshot, WatchItem } from "@spi-code/contracts";
import { Chip } from "../../components/kit/Chip.js";
import { plainTitle } from "../../text.js";
import { Time, TimedText, timedText } from "../../time.js";
import { type OpenHold, openHold } from "../environment/hold.js";
import { interruptsOf } from "./selectors.js";

export type LineStopped = { hold: OpenHold; item: WatchItem };

/** The open hold and the Interrupt it names, or nothing when the hold names no Interrupt. */
export function lineStop(snapshot: Pick<ViewSnapshot, "briefing">): LineStopped | undefined {
  const hold = openHold(snapshot);
  const inspect = hold?.inspect;
  if (!hold || !inspect) return undefined;
  const item = interruptsOf(snapshot.briefing).find(
    ({ id, ids }) => id === inspect || ids.includes(inspect),
  );
  return item ? { hold, item } : undefined;
}

function Fact({ term, text }: { term: string; text: string }) {
  const shown = plainTitle(text);
  if (!shown) return null;
  return (
    <div>
      <dt>{term}</dt>
      <dd>
        <TimedText text={shown} hint={false} />
      </dd>
    </div>
  );
}

/** A stop of the shared environment that needs you: how long, since when, why, what next, the verb. */
export function LineStop({
  snapshot,
  stop: { hold, item },
  selected,
  onSelect,
  onOpenPlace,
}: {
  snapshot: Pick<ViewSnapshot, "briefing" | "readings">;
  stop: LineStopped;
  selected: boolean;
  onSelect: (id: string) => void;
  onOpenPlace: () => void;
}) {
  const fact = snapshot.briefing.facts.find(({ label }) => label === "Environment");
  const headline = snapshot.readings.find(({ anchor }) => anchor.kind === "environment")?.content
    ?.headline;
  const facts = [plainTitle(item.cause), plainTitle(item.next)].some(Boolean) || item.blocks;
  return (
    <div
      className="today-stop"
      data-group="line-stop"
      data-item-id={item.id}
      data-tone={fact?.tone === "warn" ? "warn" : "bad"}
      aria-current={selected || undefined}
    >
      <div className="today-stop-label">
        Stops the line <small>· the shared CI/CD stack every prove borrows</small>
      </div>
      <div className="today-stop-head">
        <button type="button" className="today-stop-title" onClick={onOpenPlace}>
          <TimedText text={headline ?? plainTitle(item.title)} hint={false} />
        </button>
        <div className="today-stop-length">
          {hold.label && <strong>{hold.label}</strong>} since <Time at={hold.start} hint={false} />
        </div>
      </div>
      {facts && (
        <dl className="today-stop-facts">
          <Fact term="Why" text={item.cause} />
          <Fact term="Next" text={item.next} />
          {item.blocks && (
            <div>
              <dt>Holds up</dt>
              <dd className="today-stop-blocks">
                <Chip
                  label={item.blocks.text}
                  text={timedText(plainTitle(item.effect), { hint: false })}
                  tone="warn"
                />
              </dd>
            </div>
          )}
        </dl>
      )}
      <div className="today-stop-foot">
        <button type="button" className="today-verb" onClick={() => onSelect(item.id)}>
          {item.verb} ›
        </button>
      </div>
    </div>
  );
}
