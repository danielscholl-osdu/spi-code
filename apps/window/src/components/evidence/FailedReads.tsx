// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ReadRecord, SweepReasonCode } from "@spi-code/contracts";
import { sourceName } from "./words.js";

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

const RECORDED_SOURCES = {
  auth: "auth",
  gh: "auth",
  glab: "auth",
  fleet: "fleet",
  file: "fleet",
  github: "github",
  runs: "runs",
  approvals: "approvals",
  lifecycle: "lifecycle",
  details: "details",
  upstream: "upstream",
  gitlab: "upstream",
  radar: "radar",
  template: "template",
  security: "security",
  releases: "releases",
  "github-releases": "releases",
  "github-created": "releases",
  "github-pins": "releases",
  persist: "local-state",
  "ledger-state": "local-state",
  "release-state": "local-state",
} as const;

type WindowSource =
  | (typeof RECORDED_SOURCES)[keyof typeof RECORDED_SOURCES]
  | "local-cache"
  | "other";

const LOCAL_NAMES = {
  "local-state": "Local state",
  "local-cache": "Saved reads",
  other: "Other reads",
};

function windowName(source: WindowSource): string {
  return source === "local-state" || source === "local-cache" || source === "other"
    ? LOCAL_NAMES[source]
    : sourceName(source);
}

function forgeName(source: WindowSource): string {
  if (source === "local-state" || source === "local-cache" || source === "other") return "";
  return source === "upstream" || source === "radar" ? "GitLab" : "GitHub";
}

function windowSource({ source, object }: ReadRecord): WindowSource {
  if (source === "persist" && object !== "save" && object !== "load") return "local-cache";
  if (Object.hasOwn(RECORDED_SOURCES, source))
    return RECORDED_SOURCES[source as keyof typeof RECORDED_SOURCES];
  // Flat SPI repo records lack their collecting area; unrelated paths are not forge sources.
  if (/^osdu\/platform(?:\/[\w.-]+)*$/.test(source)) return "upstream";
  if (/^[\w.-]+\/osdu-spi(?:-[\w.-]+)?$/.test(source)) return "github";
  return "other";
}

function serviceName(record: ReadRecord, source: WindowSource): string | undefined {
  if (
    source === "local-state" ||
    source === "local-cache" ||
    source === "other" ||
    source === "auth" ||
    record.source === "file"
  )
    return undefined;
  const key = (record.source.includes("/") ? record.source : record.object).split("@")[0] ?? "";
  const parts = key.startsWith("repos/") ? key.split("/").slice(1, 3) : key.split("/");
  const name = parts.at(-1);
  if (
    parts.length < 2 ||
    !name ||
    parts.includes("lib") ||
    (parts.length === 2 && !name.startsWith("osdu-spi-")) ||
    name === "osdu-spi-stack" ||
    name === "osdu-spi-core-lib-azure"
  )
    return undefined;
  const service = name.replace(/^osdu-spi-/, "").replace(/-service$/, "");
  return service === "ingestion-workflow" ? "workflow" : service;
}

export function FailedReads({ reads }: { reads: readonly ReadRecord[] }) {
  const groups = new Map<
    string,
    { source: WindowSource; code: FailureCode; services: Set<string>; details: Set<string> }
  >();
  for (const record of reads) {
    if (record.failure === undefined) continue;
    const code = failureCode(record.failure);
    const source = windowSource(record);
    const key = JSON.stringify([source, code]);
    let group = groups.get(key);
    if (!group) {
      group = { source, code, services: new Set(), details: new Set() };
      groups.set(key, group);
    }
    const service = serviceName(record, source);
    if (service !== undefined) group.services.add(service);
    group.details.add(`${record.source} · ${record.object}: ${record.failure}`);
  }
  return (
    <div className="sweep-sources evidence-failures">
      <ul className="sweep-rows" aria-label="Failed reads">
        {[...groups].map(([key, { source, code, services, details }]) => {
          const subject =
            code === "budget" ||
            code === "throttled" ||
            source === "github" ||
            source === "releases" ||
            source === "upstream" ||
            source === "radar"
              ? forgeName(source)
              : "";
          const words = FAILURE_WORDS[code].replace("{forge} ", subject ? `${subject} ` : "");
          const outcome = services.size > 0 ? `${words} · ${[...services].join(", ")}` : words;
          return (
            <li
              key={key}
              className="evidence-failure"
              data-source={source}
              data-failure={code}
              data-tone="bad"
              aria-label={`${windowName(source)} · ${outcome}`}
            >
              <span className="sweep-mark" aria-hidden="true" title={[...details].join("\n")}>
                ✕
              </span>
              <span className="sweep-name">{windowName(source)}</span>
              <span className="sweep-outcome">{outcome}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
