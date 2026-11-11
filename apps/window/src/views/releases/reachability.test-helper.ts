// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { PrRef, ViewSnapshot } from "@spi-code/contracts";
import type { Home, Reach } from "../../app/reachability.test-helper.js";
import { sectionSources } from "../../components/evidence/SectionEvidence.js";
import { FORMING_RELEASES_ANCHOR, SHARED_COMPONENTS_ANCHOR } from "./anchors.js";

export function releaseSectionCases(snapshot: ViewSnapshot, home: Home): Reach[] {
  const cases: Reach[] = [];
  const add = (pointer: string, value: unknown, selector: string, attribute?: string) =>
    cases.push({
      pointer,
      value: String(value),
      home,
      selector,
      ...(attribute ? { attribute } : {}),
    });
  const prCases = (pointer: string, pr: PrRef, row: string) => {
    add(`${pointer}/number`, `#${pr.number}`, `${row} .kit-pr`);
    if (pr.url) add(`${pointer}/url`, pr.url, `${row} .release-pr`, "data-pr-url");
    if (pr.inspect) add(`${pointer}/inspect`, pr.inspect, `${row} .release-pr`, "data-pr-inspect");
  };
  const { forming, today } = snapshot.releases;
  if (forming) {
    const section = `#${FORMING_RELEASES_ANCHOR}`;
    const unread = sectionSources(snapshot, ["/releases/forming"]).some(({ envelope }) =>
      ["unread", "failed"].includes(envelope.state),
    );
    add("/releases/forming/state", forming.state, section, "data-state");
    if (!unread || forming.state === "not-read")
      add("/releases/forming/text", forming.text, `${section} .release-forming-text`);
    forming.prs.forEach((release, index) => {
      const pointer = `/releases/forming/prs/${index}`;
      const row = `[data-pointer="${pointer}"]`;
      add(`${pointer}/kind`, release.kind, row, "data-kind");
      add(`${pointer}/state`, release.state, row, "data-state");
      if (release.kind === "service")
        add(`${pointer}/service`, release.service, `${row} .kit-chip--service`);
      prCases(`${pointer}/pr`, release.pr, row);
      if (!unread && release.state === "read")
        release.entries.forEach((entry, at) => {
          const entryPointer = `${pointer}/entries/${at}`;
          const entryRow = `[data-pointer="${entryPointer}"]`;
          add(`${entryPointer}/kind`, entry.kind, `${entryRow} .kit-chip`);
          add(`${entryPointer}/title`, entry.title, `${entryRow} .forming-entry-title`);
        });
    });
  }
  if (today) {
    const section = `#${SHARED_COMPONENTS_ANCHOR}`;
    const { platform } = today;
    if (platform.stack)
      add("/releases/today/platform/stack", platform.stack, `${section} .release-stack`);
    if (platform.template) {
      const pointer = "/releases/today/platform/template";
      add(
        `${pointer}/released`,
        platform.template.released,
        `${section} .release-template-released`,
      );
      if (platform.template.proposed)
        add(
          `${pointer}/proposed`,
          platform.template.proposed,
          `${section} .release-template-proposed`,
        );
      if (platform.template.pr)
        prCases(`${pointer}/pr`, platform.template.pr, `${section} .release-template`);
    }
    today.versions.forEach((version, index) => {
      const pointer = `/releases/today/versions/${index}`;
      const row = `${section} [data-pointer="${pointer}"]`;
      add(`${pointer}/service`, version.service, `${row} .kit-chip--service`);
      if (version.coreLibAzure)
        add(`${pointer}/coreLibAzure`, version.coreLibAzure, `${row} .release-library-version`);
    });
  }
  return cases;
}
