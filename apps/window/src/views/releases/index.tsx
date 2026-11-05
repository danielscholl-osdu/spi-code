// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { NotesState, ReleaseLine } from "@spi-code/contracts";
import { useState } from "react";
import { useStore } from "zustand";
import { AreaEnvelopes, InferredMark } from "../../components/evidence/AreaEnvelopes.js";
import { EnvelopeBadge } from "../../components/evidence/EnvelopeBadge.js";
import type { Evidence } from "../../store/evidence.js";
import { watchStore } from "../../store/watch.js";
import "../repositories/panes.css";

const notesLabels: Record<NotesState, string> = {
  approved: "APPROVED",
  draft: "DRAFT",
  none: "NO NOTES YET",
  invalid: "NOTES FILE INVALID",
};

function Notes({ line }: { line: ReleaseLine }) {
  const tone =
    line.notes === "approved"
      ? "ok"
      : line.notes === "invalid"
        ? "bad"
        : line.notes === "none" && !line.open
          ? "neutral"
          : "warn";
  return (
    <span className="notes-chip" data-notes={line.notes} data-tone={tone}>
      {notesLabels[line.notes]}
    </span>
  );
}

function ReleaseEvidence({ evidence, pointer }: { evidence: Evidence; pointer: string }) {
  const envelope = evidence.provenance.find(({ path }) => path === pointer)?.envelope;
  return (
    <>
      {envelope && envelope.state !== "fresh" && (
        <EnvelopeBadge envelope={{ ...envelope, inferred: false }} />
      )}
      <InferredMark evidence={evidence} pointer={pointer} />
    </>
  );
}

export default function Releases() {
  const evidence = useStore(watchStore, (state) => state.snapshot?.body);
  const releases = evidence?.releases;
  const [picked, pick] = useState<string | null>(null);
  const selected = releases?.lines.some((line) => line.id === picked)
    ? picked
    : releases?.lines[0]?.id;
  const envelope = evidence?.provenance.find(
    ({ path, envelope }) => envelope && (path === "/releases" || path.startsWith("/releases/")),
  )?.envelope;
  return (
    <>
      <h1>Releases</h1>
      <div className="watch-pane" data-view-pane="releases">
        {envelope && (
          <span data-release-envelopes="">
            releases <EnvelopeBadge envelope={envelope} />
          </span>
        )}
        {!releases?.lines.length || !evidence ? (
          <h2 role="status">{releases?.reading ? "Reading releases…" : "No releases read yet."}</h2>
        ) : (
          <>
            <h2>Monthly release notes for SPI consumers.</h2>
            <p>
              Each month is built from the GitHub releases of the template, the stack,
              core-lib-azure and every service fork, with reviewed notes laid over it.
            </p>
            <AreaEnvelopes evidence={evidence} prefixes={["/releases/lines"]} />
            <div className="pane-split">
              <div className="release-list">
                {releases.lines.map((line, index) => (
                  <button
                    type="button"
                    className="release-row"
                    key={line.id}
                    data-rel={line.id}
                    data-pointer={`/releases/lines/${index}`}
                    aria-pressed={line.id === selected}
                    onClick={() => pick(line.id)}
                  >
                    <span>
                      <strong>SPI {line.name}</strong> <Notes line={line} />
                      <ReleaseEvidence evidence={evidence} pointer={`/releases/lines/${index}`} />
                      <span className="release-summary">{line.headline}</span>
                    </span>
                    <span data-muted>{line.open ? "in progress" : "closed"}</span>
                  </button>
                ))}
              </div>
              <div>
                {releases.lines.map((line, index) => (
                  <section
                    key={line.id}
                    data-rel-detail={line.id}
                    data-pointer={`/releases/lines/${index}`}
                    hidden={line.id !== selected}
                  >
                    <p>
                      <Notes line={line} /> {line.stateText}
                    </p>
                    <h3>
                      SPI {line.name}
                      <ReleaseEvidence evidence={evidence} pointer={`/releases/lines/${index}`} />
                    </h3>
                    <p>{line.headline}</p>
                    <div className="pane-facts">
                      {line.stats.map((stat) => (
                        <div
                          className="pane-fact"
                          key={stat.anchor}
                          data-tone={stat.tone}
                          data-unread={stat.figure === "?"}
                        >
                          <strong>{stat.figure}</strong>
                          <div>{stat.label}</div>
                        </div>
                      ))}
                    </div>
                    {!!line.keyChanges.length && (
                      <>
                        <p>Key changes</p>
                        <ul>
                          {line.keyChanges.map((change, index) => (
                            // biome-ignore lint/suspicious/noArrayIndexKey: changes are plain strings that can repeat
                            <li key={index}>{change}</li>
                          ))}
                        </ul>
                      </>
                    )}
                    <button type="button" onClick={() => watchStore.getState().select(line.id)}>
                      Open in inspector · read or download PDF
                    </button>
                  </section>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
