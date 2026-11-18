// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Theme } from "@spi-code/contracts";
import { Fragment, useRef } from "react";
import { useStore } from "zustand";
import { navigate } from "../../app/navigation.js";
import { treeServices } from "../../app/queue.js";
import { SectionEvidence } from "../../components/evidence/SectionEvidence.js";
import { PopoverFields, usePlaceOpening } from "../../components/place/opening.js";
import { Place } from "../../components/place/Place.js";
import { Popover } from "../../components/popover/Popover.js";
import { placePin } from "../../store/pins.js";
import { watchStore } from "../../store/watch.js";
import { TimedText } from "../../time.js";
import { upstreamOpening } from "./opening.js";
import { upstreamReading } from "./reading.js";
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

export default function Upstream({ store = watchStore }: { store?: typeof watchStore }) {
  const pane = useRef<HTMLDivElement>(null);
  const snapshot = useStore(store, (state) => state.snapshot?.body);
  const { marked, anchor, opener, openItem, close } = usePlaceOpening(pane, snapshot);
  if (!snapshot) return null;
  const reading = upstreamReading(snapshot);
  const { horizon, themes } = snapshot.briefing;
  const opening = upstreamOpening(snapshot, marked);
  return (
    <div className="upstream" ref={pane}>
      <Place
        name="Upstream"
        pin={placePin("upstream")}
        reading={reading}
        snapshot={snapshot}
        services={treeServices(snapshot.tree)}
        onNavigate={navigate}
        onSelect={openItem}
        actions={
          <button
            type="button"
            title="Open Forks with Upstream highlighted"
            onClick={() => navigate({ kind: "today", tab: "forks", station: "upstream" })}
          >
            Forks ›
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
              <TimedText text={horizon.headline} hint={false} />
            </p>
          )}
          <ul>
            {themes.map((theme, index) => {
              const head = { kind: "theme", id: theme.id };
              const item = [...snapshot.briefing.focus, ...snapshot.briefing.rest].find(
                ({ id }) => id === theme.inspect,
              );
              return (
                <li
                  className="upstream-theme"
                  key={theme.id}
                  data-theme-id={theme.id}
                  data-pointer={`/briefing/themes/${index}`}
                  data-selected={
                    (marked?.kind === "theme" && marked.id === theme.id) ||
                    (marked?.kind === "item" && marked.id === theme.inspect) ||
                    undefined
                  }
                >
                  <button type="button" className="upstream-theme-head" {...opener(head)}>
                    <span className="upstream-theme-kind" data-tone={theme.tone}>
                      {theme.kind}
                    </span>
                    <span className="upstream-theme-title">{theme.title}</span>
                    {theme.when && (
                      <span className="upstream-theme-when">
                        <TimedText text={theme.when} hint={false} />
                      </span>
                    )}
                  </button>
                  {theme.sub && <ThemeSub theme={theme} />}
                  {item && (
                    <button
                      type="button"
                      className="upstream-theme-item upstream-fork"
                      {...opener({ kind: "item", id: item.id })}
                    >
                      <TimedText text={item.title} hint={false} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {opening && marked && anchor && (
        <Popover anchor={anchor} selection={marked} content={opening.content} onClose={close}>
          <PopoverFields fields={opening.fields} />
        </Popover>
      )}
    </div>
  );
}
