// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Envelope } from "@spi-code/contracts";
import { type Evidence, envelopesForAll } from "../../store/evidence.js";
import { useNow } from "./useNow.js";
import {
  AREA_NAMES,
  bySource,
  byWorst,
  chipText,
  everyInferred,
  sourceName,
  stateWord,
  worstTone,
} from "./words.js";
import "./evidence.css";

const under = (path: string, prefix: string) =>
  path === prefix || path.startsWith(`${prefix}/`) || prefix.startsWith(`${path}/`);

/** Every source feeding a value under the prefixes: its areas, then collectors outside them. */
export function sectionSources(
  evidence: Evidence,
  prefixes: readonly string[],
): { name: string; envelope: Envelope }[] {
  const extra = bySource(
    evidence.provenance.filter(({ path }) => prefixes.some((prefix) => under(path, prefix))),
  );
  return [
    ...envelopesForAll(evidence, prefixes).map(({ area, envelope }) => ({
      name: AREA_NAMES[area],
      envelope,
    })),
    ...[...extra].map(([source, envelope]) => ({ name: sourceName(source), envelope })),
  ];
}

/**
 * A section header's one line (EV-03): the worst source in words and a count of the rest, only
 * when a feeding source is not fresh; `inferred` when every one is inferred. Hover lists them all.
 */
export function SectionEvidence({
  evidence,
  prefixes,
  now,
}: {
  evidence: Evidence;
  prefixes: readonly string[];
  now?: number | undefined;
}) {
  const clock = useNow();
  const at = now ?? clock;
  const sources = sectionSources(evidence, prefixes);
  const notFresh = sources
    .filter(({ envelope }) => envelope.state !== "fresh")
    .sort((a, b) => byWorst(a.envelope, b.envelope));
  const inferred = everyInferred(sources.map(({ envelope }) => envelope));
  if (notFresh.length === 0 && !inferred) return null;
  const [worst, ...rest] = notFresh;
  const tone = worstTone(sources.map(({ envelope }) => envelope));
  const parts = worst ? [`${worst.name} ${stateWord(worst.envelope)}`] : [];
  if (rest.length > 0) parts.push(`${rest.length} more`);
  if (inferred) parts.push("inferred");
  return (
    <p
      className="section-evidence"
      data-section-evidence={prefixes.join(" ")}
      data-tone={tone}
      {...(inferred ? { "data-inferred": "" } : {})}
      title={sources.map(({ name, envelope }) => `${name} · ${chipText(envelope, at)}`).join("\n")}
    >
      <span className="evidence-dot" data-tone={tone} aria-hidden /> {parts.join(" · ")}
    </p>
  );
}
