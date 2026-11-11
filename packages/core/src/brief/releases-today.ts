// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { TEMPLATE_REPO } from "../config.js";
import type { CoreContext } from "../context.js";
import type { Facts } from "../facts.js";
import { compareVersions } from "../model/releases.js";
import { releaseQueue } from "../readings/releases.js";

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
  const version = pr && /\brelease\s+(?:\S+\s+)?v?(\d+(?:\.\d+){1,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\s*$/i.exec(pr.title)?.[1];
  return pr && version
    ? { proposed: version, pr: { number: pr.number, url: pr.url } }
    : {};
}

export type PlatformSource = "ledger" | "github";

/** The stack and template released versions, and whether each came from this month's ledger or the GitHub release tag. */
export function platformReleased(
  documents: ReleasesTodayInput["documents"],
  facts: Pick<Facts, "github">,
  context: CoreContext,
): {
  stack?: { version: string; source: PlatformSource };
  template?: { version: string; source: PlatformSource };
} {
  const current = [...documents].sort((a, b) => b.month.localeCompare(a.month))[0];
  const repos = facts.github.data?.repos;
  const pick = (id: string, repo: string) => {
    const row = current?.rows.find((r) => r.id === id && r.state === "released");
    if (row) {
      const version = row.to ?? row.version;
      return version ? { version, source: "ledger" as const } : undefined;
    }
    const tag = repos?.[repo]?.release?.tag;
    return tag ? { version: tag, source: "github" as const } : undefined;
  };
  const stack = pick("spi-stack", context.stackRepo);
  const template = pick("spi-template", TEMPLATE_REPO);
  return { ...(stack ? { stack } : {}), ...(template ? { template } : {}) };
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
  const sourced = platformReleased(documents, facts, context);
  const stack = sourced.stack?.version;
  const templateReleased = sourced.template?.version;
  const queue = releaseQueue(facts, context);
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
  const envelope = provenance.find(({ path }) => path === "/releases/lines")?.envelope;
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
