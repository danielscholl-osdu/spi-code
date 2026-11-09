// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ReadRecord, SweepReasonCode } from "@spi-code/contracts";
import { AREA_NAMES, sourceName } from "./words.js";

type FailureCode = SweepReasonCode | "not-found" | "denied";

const FAILURE_WORDS: Readonly<Record<FailureCode, string>> = {
  signin: "signed out",
  budget: "waits for {forge} budget",
  throttled: "{forge} asked to slow down",
  cadence: "not due this sweep",
  limit: "read limit reached",
  unavailable: "{forge} unavailable",
  timeout: "{forge} timed out",
  save: "could not save the sweep",
  other: "read failed",
  "not-found": "not found",
  denied: "access denied",
};

function isFailureCode(code: string): code is FailureCode {
  return Object.hasOwn(FAILURE_WORDS, code);
}

// Read records carry text, not the structured codes on sweep progress. Recognize older HTTP
// failures here too; in particular a gateway's 504 means a timeout, not an unreadable HTML reply.
function failureCode(failure: string): FailureCode {
  const code = failure.toLowerCase().replaceAll("_", "-");
  if (isFailureCode(code)) return code;
  const status = /\bhttp[\s_:-]*(\d{3})\b/i.exec(failure)?.[1];
  if (status === "408" || status === "504" || /\b(timed? out|timeout)\b/i.test(failure))
    return "timeout";
  if (status === "401" || /\b(signed out|not signed in|unauthenticated)\b/i.test(failure))
    return "signin";
  if (status === "429" || (status === "403" && /secondary rate limit/i.test(failure)))
    return "throttled";
  if (status === "403" || /\b(forbidden|access denied)\b/i.test(failure)) return "denied";
  if (status === "404" || /\bnot[ _-]found\b/i.test(failure)) return "not-found";
  if (status?.startsWith("5")) return "unavailable";
  return "other";
}

function forgeName(source: string): string {
  if (["gitlab", "upstream", "radar"].includes(source) || source.split("/").length > 2)
    return "GitLab";
  if (source === "github" || source.includes("/")) return "GitHub";
  return sourceName(source);
}

function windowSource(source: string): string {
  if (Object.hasOwn(AREA_NAMES, source) || source === "releases") return source;
  // Repo-backed records do not carry an area; use their forge's window source.
  return forgeName(source) === "GitLab" ? "upstream" : "github";
}

function serviceName(record: ReadRecord): string {
  const name = record.source.includes("/") ? record.source : record.object;
  const service = (
    name
      .split("/")
      .at(-1)
      ?.replace(/^osdu-spi-/, "") ?? name
  ).replace(/-service$/, "");
  return service === "ingestion-workflow" ? "workflow" : service;
}

export function FailedReads({ reads }: { reads: readonly ReadRecord[] }) {
  const groups = new Map<
    string,
    { source: string; code: FailureCode; services: Set<string>; details: Set<string> }
  >();
  for (const record of reads) {
    if (record.failure === undefined) continue;
    const code = failureCode(record.failure);
    const source = windowSource(record.source);
    const key = JSON.stringify([source, code]);
    let group = groups.get(key);
    if (!group) {
      group = { source, code, services: new Set(), details: new Set() };
      groups.set(key, group);
    }
    group.services.add(serviceName(record));
    group.details.add(`${record.source} · ${record.object}: ${record.failure}`);
  }
  return (
    <div className="sweep-sources evidence-failures">
      <ul className="sweep-rows" aria-label="Failed reads">
        {[...groups].map(([key, { source, code, services, details }]) => {
          const forge = source === "upstream" || source === "radar" ? "GitLab" : "GitHub";
          const subject = code === "budget" || code === "throttled" ? forge : forgeName(source);
          const outcome = `${FAILURE_WORDS[code].replace("{forge}", subject)} · ${[...services].join(", ")}`;
          return (
            <li
              key={key}
              className="evidence-failure"
              data-source={source}
              data-failure={code}
              data-tone="bad"
              aria-label={`${sourceName(source)} · ${outcome}`}
            >
              <span className="sweep-mark" aria-hidden="true" title={[...details].join("\n")}>
                ✕
              </span>
              <span className="sweep-name">{sourceName(source)}</span>
              <span className="sweep-outcome">{outcome}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
