// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { PrRef, ViewSnapshot } from "@spi-code/contracts";
import type { Exemption, Home, Opens, Reach } from "../../app/reachability.test-helper.js";
import { sectionSources } from "../../components/evidence/SectionEvidence.js";
import { FORMING_RELEASES_ANCHOR, SHARED_COMPONENTS_ANCHOR } from "../releases/anchors.js";

const BLOCK = ".today-releases";
const KINDS = ["breaking", "new", "improved", "fixed", "security", "other"] as const;
const at = (pointer: string) => `${BLOCK} [data-pointer="${pointer}"]`;

/** True when a source feeding the forming releases was not read, so the change lines say so. */
export function formingNotRead(snapshot: ViewSnapshot): boolean {
  return (
    snapshot.releases.forming?.state === "not-read" ||
    sectionSources(snapshot, ["/releases/forming"]).some(({ envelope }) =>
      ["unread", "failed"].includes(envelope.state),
    )
  );
}

/** Leaves Today's Releases block owns: the versions, the platform line, the change lines. */
export const TODAY_RELEASES =
  /^\/releases\/(today\/(versions\/\d+\/(state|released|proposed|text|pr\/.+)|platform\/(text|coreLibAzure\/.+)|readyLine|unread\/.+)|forming\/(kinds|notable)\/.+)$/;

/** What the block leaves undrawn on a morning: a kind with no entries, or changes not read. */
export const RELEASES_QUIET: Readonly<Record<string, Exemption>> = {
  "zero-kind": {
    patterns: KINDS.map((kind) => `/releases/forming/kinds/${kind}`),
    reason: "A kind with no entries draws no segment and no 0 (today-design 'Calm first')",
    when: (value) => value === 0,
  },
  "forming-not-read": {
    patterns: [
      ...KINDS.map((kind) => `/releases/forming/kinds/${kind}`),
      ...["title", "kind", "text", "pr/number", "pr/url", "pr/inspect", "services/#"].map(
        (leaf) => `/releases/forming/notable/#/${leaf}`,
      ),
    ],
    reason: "Change lines read 'not read this sweep' when a forming source was not read, never 0",
    when: (_value, { snapshot }) => formingNotRead(snapshot as ViewSnapshot),
  },
};

export function todayReleasesCases(snapshot: ViewSnapshot, home: Home): Reach[] {
  const cases: Reach[] = [];
  const add = (pointer: string, value: unknown, selector: string, extra: Partial<Reach> = {}) =>
    cases.push({ pointer, value: String(value), home, selector, ...extra });
  const prCases = (pointer: string, pr: PrRef, selector: string, opens: Opens) => {
    add(`${pointer}/number`, pr.number, selector, { attribute: "data-pr-number", opens });
    if (pr.url) add(`${pointer}/url`, pr.url, selector, { attribute: "data-pr-url" });
    if (pr.inspect)
      add(`${pointer}/inspect`, pr.inspect, selector, { attribute: "data-pr-inspect" });
  };
  const { today, forming } = snapshot.releases;
  if (today) {
    today.versions.forEach((version, index) => {
      const pointer = `/releases/today/versions/${index}`;
      const row = at(pointer);
      add(`${pointer}/service`, version.service, `${row} .today-release-service`);
      add(`${pointer}/state`, version.state, row, { attribute: "data-state" });
      if (version.state !== "released") {
        add(`${pointer}/text`, version.text, `${row} .today-release-none`);
        return;
      }
      add(`${pointer}/text`, version.text, `${row} .today-release-pair`, {
        attribute: "aria-label",
      });
      add(`${pointer}/released`, version.released, `${row} .today-release-released`, {
        opens: {
          click: `${row} .today-release-released`,
          detail: `release:${version.service}`,
        },
      });
      if (version.pr && version.proposed) {
        const arrow = `${row} .today-release-arrow`;
        const opens = {
          click: arrow,
          detail: version.pr.inspect ?? `release-pr:${version.service}`,
        };
        add(`${pointer}/proposed`, version.proposed, `${arrow} .today-release-proposed`, {
          opens,
        });
        prCases(`${pointer}/pr`, version.pr, arrow, opens);
      }
    });
    const platform = `${BLOCK} .today-release-platform`;
    const shared = {
      click: `${platform} .today-release-open`,
      place: { kind: "releases", section: SHARED_COMPONENTS_ANCHOR },
    } as const;
    add("/releases/today/platform/text", today.platform.text, `${platform} .today-release-open`, {
      attribute: "title",
      opens: shared,
    });
    today.platform.coreLibAzure.forEach(({ version, count }, index) => {
      const segment = `${platform} .kit-segment:nth-child(${index + 1})`;
      add(`/releases/today/platform/coreLibAzure/${index}/version`, version, segment, {
        attribute: "title",
        contains: true,
      });
      add(`/releases/today/platform/coreLibAzure/${index}/count`, count, segment, {
        attribute: "data-count",
      });
    });
    if (today.readyLine)
      add("/releases/today/readyLine", today.readyLine, `${BLOCK} .today-releases-ready`);
    const held = `${BLOCK} .today-releases-held`;
    for (const [index, area] of (today.unread?.areas ?? []).entries())
      add(`/releases/today/unread/areas/${index}`, area, held, {
        attribute: "data-areas",
        contains: true,
      });
    if (today.unread?.lastGood)
      add("/releases/today/unread/lastGood", today.unread.lastGood, `${held} time`, {
        attribute: "dateTime",
      });
  }
  if (forming) {
    const changes = `${BLOCK} .today-release-changes`;
    const opens = {
      click: `${changes} .today-release-open`,
      place: { kind: "releases", section: FORMING_RELEASES_ANCHOR },
    } as const;
    add("/releases/forming/state", forming.state, changes, { attribute: "data-state", opens });
    if (formingNotRead(snapshot) || !forming.kinds) return cases;
    const { kinds } = forming;
    for (const kind of KINDS)
      if (kinds[kind] > 0)
        add(
          `/releases/forming/kinds/${kind}`,
          kinds[kind],
          `${changes} .kit-legend li[data-segment="${kind}"] b`,
        );
    forming.notable.forEach((notable, index) => {
      const pointer = `/releases/forming/notable/${index}`;
      const row = at(pointer);
      const detail = {
        click: `${row} button`,
        detail: notable.pr.inspect ?? `release-notable:${index}`,
      };
      add(`${pointer}/text`, notable.text, `${row} button`, { opens: detail });
      add(`${pointer}/title`, notable.title, `${row} button`, { contains: true });
      add(`${pointer}/kind`, notable.kind, row, { attribute: "data-kind" });
      for (const [at, service] of notable.services.entries())
        add(`${pointer}/services/${at}`, service, row, {
          attribute: "data-services",
          contains: true,
        });
      prCases(`${pointer}/pr`, notable.pr, row, detail);
    });
  }
  return cases;
}
