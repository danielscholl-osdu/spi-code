// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Theme } from "@spi-code/contracts";
import { Fragment } from "react";
import { useStore } from "zustand";
import { navigate } from "../../app/routes.js";
import { SectionEvidence } from "../../components/evidence/SectionEvidence.js";
import { selectionStore } from "../../panels/selection.js";
import { watchStore } from "../../store/watch.js";
import { blankCell, type LensColumn, LensTable } from "../lenses/table.js";

const selection = (theme: Theme, index: number) => ({
  id: theme.inspect ?? `theme:${theme.id}`,
  title: theme.title,
  kind: "theme" as const,
  prefixes: [`/briefing/themes/${index}`],
});

export default function Horizon() {
  const evidence = useStore(watchStore, (state) => state.snapshot?.body);
  const themes = evidence?.briefing.themes ?? [];
  const columns: LensColumn<Theme>[] = [
    {
      label: "Theme",
      value: (theme) => theme.title,
      render: (theme) => {
        const forks = new Set([
          ...theme.certain.map(({ fork }) => fork),
          ...theme.possible.map(({ fork }) => fork),
          ...theme.exposed,
        ]);
        return (
          <>
            {blankCell(theme.title)}
            <span className="lens-sub">
              {blankCell(theme.sub)
                .split(/([a-z0-9]+(?:-[a-z0-9]+)*)/g)
                .map((part, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: tokens can repeat within a sentence
                  <Fragment key={index}>
                    {forks.has(part) ? (
                      <button
                        type="button"
                        className="lens-link"
                        onClick={(event) => {
                          event.stopPropagation();
                          const row = selection(theme, themes.indexOf(theme));
                          selectionStore.getState().select(row.id, row);
                          navigate({ kind: "service", id: part });
                        }}
                      >
                        {part}
                      </button>
                    ) : (
                      part
                    )}
                  </Fragment>
                ))}
            </span>
          </>
        );
      },
    },
    {
      label: "Kind",
      value: (theme) => theme.kind,
      render: (theme) => <span data-tone={theme.tone}>{theme.kind.toUpperCase()}</span>,
    },
    { label: "When", value: (theme) => theme.when ?? "" },
  ];
  return (
    <section className="lens" data-view-pane="horizon" aria-label="Horizon">
      <h1>Horizon</h1>
      {!evidence ? (
        <p>Waiting for a Watch snapshot</p>
      ) : (
        <>
          <SectionEvidence evidence={evidence} prefixes={["/briefing/horizon"]} />
          <h2 data-pointer="/briefing/horizon/headline">{evidence.briefing.horizon.headline}</h2>
          {themes.length > 0 && (
            <SectionEvidence evidence={evidence} prefixes={["/briefing/themes"]} />
          )}
          <LensTable
            lens="horizon"
            columns={columns}
            rows={themes.map((theme, index) => ({
              reading: theme,
              pointer: `/briefing/themes/${index}`,
              selection: selection(theme, index),
            }))}
          />
        </>
      )}
    </section>
  );
}
