// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Theme } from "@spi-code/contracts";
import { Fragment } from "react";
import { useStore } from "zustand";
import { navigate } from "../../app/navigation.js";
import { SectionEvidence } from "../../components/evidence/SectionEvidence.js";
import { Place } from "../../components/place/Place.js";
import { type SelectionStore, selectionStore } from "../../panels/selection.js";
import { selectionRows } from "../../panels/selection-rows.js";
import { watchStore } from "../../store/watch.js";
import { treeServices } from "../inbox/queue.js";
import { themeRow, upstreamReading } from "./reading.js";
import "./upstream.css";

function ThemeSub({ theme }: { theme: Theme }) {
  const forks = new Set([
    ...theme.certain.map(({ fork }) => fork),
    ...theme.possible.map(({ fork }) => fork),
    ...theme.exposed,
  ]);
  return (
    <p className="upstream-theme-sub">
      {theme.sub.split(/([a-z0-9]+(?:-[a-z0-9]+)*)/g).map((part, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: tokens can repeat within a sentence
        <Fragment key={index}>
          {forks.has(part) ? (
            <button
              type="button"
              className="upstream-fork"
              title={`Open ${part}`}
              onClick={() => navigate({ kind: "service", id: part })}
            >
              {part}
            </button>
          ) : (
            part
          )}
        </Fragment>
      ))}
    </p>
  );
}

export default function Upstream({
  store = watchStore,
  inspector = selectionStore,
}: {
  store?: typeof watchStore;
  inspector?: SelectionStore;
}) {
  const snapshot = useStore(store, (state) => state.snapshot?.body);
  const selected = useStore(inspector, (state) => state.selected);
  if (!snapshot) return null;
  const reading = upstreamReading(snapshot);
  const { horizon, themes } = snapshot.briefing;
  const select = (id: string) => {
    const row = selectionRows(snapshot).find((candidate) => candidate.id === id);
    if (row) inspector.getState().select(id, row);
  };
  return (
    <div className="upstream">
      <Place
        name="Upstream"
        reading={reading}
        services={treeServices(snapshot.tree)}
        onNavigate={navigate}
        onSelect={select}
        {...(selected !== null ? { selectedId: selected } : {})}
        actions={
          <button
            type="button"
            title="Open the Line sheet filtered to the Upstream column"
            onClick={() => navigate({ kind: "line", column: "upstream" })}
          >
            Line view
          </button>
        }
      />
      {themes.length > 0 && (
        <section className="upstream-ahead" aria-label="Further ahead">
          <h2>Further ahead</h2>
          <SectionEvidence
            evidence={snapshot}
            prefixes={["/briefing/horizon", "/briefing/themes"]}
          />
          {horizon.headline && (
            <p className="upstream-ahead-headline" data-pointer="/briefing/horizon/headline">
              {horizon.headline}
            </p>
          )}
          <ul>
            {themes.map((theme, index) => {
              const row = themeRow(theme, index);
              return (
                <li
                  className="upstream-theme"
                  key={theme.id}
                  data-theme-id={theme.id}
                  data-pointer={`/briefing/themes/${index}`}
                  data-selected={selected === row.id || undefined}
                >
                  <button
                    type="button"
                    className="upstream-theme-head"
                    data-selection-id={row.id}
                    aria-pressed={selected === row.id}
                    onClick={() => inspector.getState().select(row.id, row)}
                  >
                    <span className="upstream-theme-kind" data-tone={theme.tone}>
                      {theme.kind}
                    </span>
                    <span className="upstream-theme-title">{theme.title}</span>
                    {theme.when && <span className="upstream-theme-when">{theme.when}</span>}
                  </button>
                  {theme.sub && <ThemeSub theme={theme} />}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
