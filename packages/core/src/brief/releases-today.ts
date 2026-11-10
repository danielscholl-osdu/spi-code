// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { TEMPLATE_REPO } from "../config.js";
import type { CoreContext } from "../context.js";
import type { Facts } from "../facts.js";
import { compareVersions } from "../model/releases.js";
import { releaseQueue } from "../readings/releases.js";
import { releaseTag } from "../util.js";

interface Pr {
  number: number;
  title: string;
  url: string;
}

interface ReleasedRow {
  id: string;
  state: string;
  version: string;
  to?: string | undefined;
  lib?: string | null | undefined;
}

interface ReleaseVersion {
  service: string;
  released: string;
  proposed?: string;
  pr?: { number: number; url: string };
  coreLibAzure?: string;
  text: string;
}

export interface ReleasesTodayInput {
  services: readonly {
    service: string;
    releases: readonly (ReleasedRow & { month: string; releasePr?: Pr | undefined })[];
  }[];
  documents: readonly { month: string; rows: readonly ReleasedRow[] }[];
  facts: Pick<Facts, "github" | "details">;
  provenance: readonly {
    path: string;
    envelope?: { state: string; observedAt?: string | undefined } | undefined;
  }[];
  context: CoreContext;
}

function proposed(pr: Pr | undefined) {
  const version = pr && releaseTag(pr.title, "");
  return pr && version
    ? { proposed: version, pr: { number: pr.number, url: pr.url } }
    : {};
}

/** Today's version pairs share the release reading's PR inventory and waiting words. */
export function releasesToday(input: ReleasesTodayInput) {
  const { services, documents, facts, provenance, context } = input;
  const versions: ReleaseVersion[] = services.flatMap(({ service, releases }) => {
    const row = [...releases].sort((a, b) => b.month.localeCompare(a.month))[0];
    if (!row) return [];
    const released = row.to ?? row.version;
    const next = proposed(row.releasePr);
    return [
      {
        service,
        released,
        ...next,
        ...(row.lib ? { coreLibAzure: row.lib } : {}),
        text: `released ${released}${next.proposed ? `, proposed ${next.proposed}` : ""}`,
      },
    ];
  });
  const current = [...documents].sort((a, b) => b.month.localeCompare(a.month))[0];
  const stackRow = current?.rows.find((row) => row.id === "spi-stack" && row.state === "released");
  const templateRow = current?.rows.find((row) => row.id === "spi-template" && row.state === "released");
  const queue = releaseQueue(facts, context);
  const repos = facts.github.data?.repos;
  const stack = (stackRow && (stackRow.to ?? stackRow.version)) ?? repos?.[context.stackRepo]?.release?.tag;
  const templateReleased = (templateRow && (templateRow.to ?? templateRow.version)) ?? repos?.[TEMPLATE_REPO]?.release?.tag;
  const template = templateReleased
    ? {
        released: templateReleased,
        ...proposed(queue.all.find(({ repo }) => repo === TEMPLATE_REPO)?.pr),
      }
    : undefined;
  const spread = new Map<string, number>();
  for (const row of versions) {
    if (row.coreLibAzure) spread.set(row.coreLibAzure, (spread.get(row.coreLibAzure) ?? 0) + 1);
  }
  const coreLibAzure = [...spread]
    .map(([version, count]) => ({ version, count }))
    .sort((a, b) => compareVersions(b.version, a.version));
  const newest = coreLibAzure[0];
  const oldest = coreLibAzure.at(-1);
  const library =
    newest && oldest
      ? `core-lib-azure ${oldest.version === newest.version ? newest.version : `${oldest.version} to ${newest.version}`} (${newest.version} on ${newest.count} of ${services.length})`
      : undefined;
  const envelope = provenance.find(({ path }) => path === "/releases")?.envelope;
  const lastGood = envelope && envelope.state !== "unread" ? envelope.observedAt : undefined;
  const unread =
    envelope && envelope.state !== "fresh"
      ? { areas: ["releases"], ...(lastGood ? { lastGood } : {}) }
    : undefined;
  return {
    versions,
    platform: {
      ...(stack ? { stack } : {}),
      ...(template ? { template } : {}),
      coreLibAzure,
      text: [
        stack ? `stack ${stack}` : undefined,
        template ? `template ${template.released}${template.proposed ? ` → ${template.proposed}` : ""}` : undefined,
        library,
      ]
        .filter(Boolean)
        .join(" · "),
    },
    readyLine: queue.readyLine,
    ...(unread ? { unread } : {}),
  };
}
