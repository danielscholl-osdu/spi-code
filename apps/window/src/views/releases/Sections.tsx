// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { PrRef, ViewSnapshot } from "@spi-code/contracts";
import { useState } from "react";
import { navigate } from "../../app/navigation.js";
import { SectionEvidence, sectionSources } from "../../components/evidence/SectionEvidence.js";
import { stateWord } from "../../components/evidence/words.js";
import { Chip, PrBadge, ServiceChip } from "../../components/kit/Chip.js";
import { selectionStore } from "../../panels/selection.js";
import { FORMING_RELEASES_ANCHOR, SHARED_COMPONENTS_ANCHOR } from "./anchors.js";

function ReleasePr({ pr }: { pr: PrRef }) {
  const [error, setError] = useState(false);
  async function open() {
    setError(false);
    if (pr.inspect) {
      selectionStore.getState().select(pr.inspect, {
        id: pr.inspect,
        title: `PR #${pr.number}`,
        kind: "queue",
      });
    } else if (pr.url) {
      try {
        setError(!(await window.spi.openExternal(pr.url)));
      } catch {
        setError(true);
      }
    }
  }
  return (
    <span className="release-pr" data-pr-url={pr.url} data-pr-inspect={pr.inspect}>
      <PrBadge
        number={pr.number}
        text={`PR #${pr.number}`}
        {...(pr.inspect || pr.url ? { onOpen: () => void open() } : {})}
      />
      {error && <span role="alert">Could not open the link in your browser.</span>}
    </span>
  );
}

export function ReleaseSections({ snapshot }: { snapshot: ViewSnapshot }) {
  const { forming, today } = snapshot.releases;
  const sources = sectionSources(snapshot, ["/releases/forming"]);
  const unread = sources.some(({ envelope }) => ["unread", "failed"].includes(envelope.state));
  const caveats = sources.filter(({ envelope }) =>
    ["unread", "failed", "incomplete"].includes(envelope.state),
  );
  const caveat = caveats.map(({ name, envelope }) => `${name}: ${stateWord(envelope)}`).join("; ");
  return (
    <>
      {forming && (
        <section
          id={FORMING_RELEASES_ANCHOR}
          className="release-section"
          aria-label="Forming releases"
          data-state={forming.state}
        >
          <h2>
            Forming releases{" "}
            {caveats.length > 0 && (
              <button
                type="button"
                className="kit-chip kit-chip--plain release-held"
                title={caveat}
                aria-label={`${caveat}. Open Evidence.`}
                onClick={() => selectionStore.getState().openSweepEvidence()}
              >
                <span aria-hidden="true">⌀</span>
              </button>
            )}
          </h2>
          <SectionEvidence evidence={snapshot} prefixes={["/releases/forming"]} />
          <p className="release-forming-text">
            {unread && forming.state !== "not-read" ? "not read" : forming.text}
          </p>
          {forming.prs.map((release, index) => (
            <div
              className="forming-release"
              key={`${release.kind === "service" ? release.service : release.kind}-${release.pr.number}`}
              data-pointer={`/releases/forming/prs/${index}`}
              data-kind={release.kind}
              data-state={release.state}
            >
              <h3>
                {release.kind === "service" ? (
                  <ServiceChip
                    service={release.service}
                    text={release.service}
                    onOpen={() => navigate({ kind: "service", id: release.service })}
                  />
                ) : (
                  <Chip label="template" text="template" />
                )}
                <ReleasePr pr={release.pr} />
              </h3>
              {unread || release.state === "not-read" ? (
                <p className="release-unread">not read</p>
              ) : release.entries.length > 0 ? (
                <ul className="forming-entries">
                  {release.entries.map((entry, entryIndex) => (
                    <li
                      // biome-ignore lint/suspicious/noArrayIndexKey: changelog entries have no identity and can repeat
                      key={entryIndex}
                      data-pointer={`/releases/forming/prs/${index}/entries/${entryIndex}`}
                    >
                      <Chip label={entry.kind} text={entry.kind} tone="plain" />
                      <span className="forming-entry-title">{entry.title}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
        </section>
      )}
      {today && (
        <section
          id={SHARED_COMPONENTS_ANCHOR}
          className="release-section"
          aria-label="Shared components"
        >
          <h2>Shared components</h2>
          <SectionEvidence
            evidence={snapshot}
            prefixes={["/releases/today/platform", "/releases/today/versions"]}
          />
          <dl className="release-platform">
            {today.platform.stack && (
              <div>
                <dt>Stack</dt>
                <dd className="release-stack">{today.platform.stack}</dd>
              </div>
            )}
            {today.platform.template && (
              <div>
                <dt>Template</dt>
                <dd className="release-template">
                  <span className="release-template-released">
                    {today.platform.template.released}
                  </span>
                  {today.platform.template.proposed && (
                    <>
                      <span aria-hidden="true"> → </span>
                      <span className="release-template-proposed">
                        {today.platform.template.proposed}
                      </span>
                    </>
                  )}
                  {today.platform.template.pr && <ReleasePr pr={today.platform.template.pr} />}
                </dd>
              </div>
            )}
          </dl>
          <h3>core-lib-azure</h3>
          <ul className="release-library-versions">
            {today.versions.map((version, index) => (
              <li key={version.service} data-pointer={`/releases/today/versions/${index}`}>
                <ServiceChip
                  service={version.service}
                  text={version.service}
                  onOpen={() => navigate({ kind: "service", id: version.service })}
                />
                <span className="release-library-version">
                  {version.coreLibAzure ?? "not read"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
