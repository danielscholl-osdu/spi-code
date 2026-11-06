// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useState } from "react";
import { useStore } from "zustand";
import { SectionEvidence } from "../../components/evidence/SectionEvidence.js";
import "../../components/stations/stations.css";
import { watchStore } from "../../store/watch.js";

export default function Horizon() {
  const snapshot = useStore(watchStore, (state) => state.snapshot);
  const [picked, setPicked] = useState<string>();
  if (!snapshot)
    return (
      <>
        <h1>Horizon</h1>
        <p>Waiting for a Watch snapshot</p>
      </>
    );
  const { themes, horizon } = snapshot.body.briefing;
  const selected = themes.some((theme) => theme.id === picked) ? picked : themes[0]?.id;
  const inspect = (id: string) => watchStore.getState().select(id);
  const evidence = snapshot.body;
  return (
    <div className="watch-horizon" data-view-pane="horizon">
      <SectionEvidence evidence={evidence} prefixes={["/briefing/horizon"]} />
      <h2 data-pointer="/briefing/horizon/headline">{horizon.headline}</h2>
      {themes.length > 0 && <SectionEvidence evidence={evidence} prefixes={["/briefing/themes"]} />}
      {themes.length > 0 && (
        <div className="watch-split">
          <div className="watch-themes">
            {themes.map((theme, index) => (
              <button
                key={theme.id}
                type="button"
                data-theme-sel={theme.id}
                data-pointer={`/briefing/themes/${index}`}
                aria-pressed={theme.id === selected}
                onClick={() => {
                  setPicked(theme.id);
                  inspect(theme.inspect ?? `theme:${theme.id}`);
                }}
              >
                <span>{theme.title}</span>{" "}
                <span data-tone={theme.tone}>{theme.kind.toUpperCase()}</span>
                <span className="theme-sub">{theme.sub}</span>
                <small>{theme.when}</small>
              </button>
            ))}
          </div>
          <div>
            {themes.map((theme, index) => (
              <section
                key={theme.id}
                data-theme-detail={theme.id}
                data-pointer={`/briefing/themes/${index}`}
                hidden={theme.id !== selected}
              >
                <p>
                  <span data-tone={theme.tone}>{theme.kind.toUpperCase()}</span> {theme.when}
                </p>
                <h3>{theme.title}</h3>
                {theme.certain.length + theme.possible.length > 0 && (
                  <>
                    <p>Exposure by fork</p>
                    <ul className="pairs">
                      {theme.certain.map((fork) => (
                        <li key={fork.fork}>
                          <span>{fork.fork}</span>
                          <span>{fork.state}</span>
                        </li>
                      ))}
                      {theme.possible.map((fork) => (
                        <li key={fork.fork} className="possible">
                          <span>{fork.fork}</span>
                          <span>
                            {fork.inspect ? (
                              <button
                                type="button"
                                data-inspect={fork.inspect}
                                onClick={() => fork.inspect && inspect(fork.inspect)}
                              >
                                possible · {fork.state}
                              </button>
                            ) : (
                              <>possible · {fork.state}</>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <dl>
                  {theme.exposed.length > 0 && (
                    <>
                      <dt>Exposed</dt>
                      <dd>{theme.exposed.join(", ")}</dd>
                    </>
                  )}
                  <dt>Next</dt>
                  <dd>{theme.next}</dd>
                </dl>
                {theme.inspect && (
                  <button
                    type="button"
                    data-inspect={theme.inspect}
                    onClick={() => theme.inspect && inspect(theme.inspect)}
                  >
                    Open in inspector
                  </button>
                )}
              </section>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
