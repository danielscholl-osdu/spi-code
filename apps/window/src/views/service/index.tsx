// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ServiceHome, ViewSnapshot } from "@spi-code/contracts";
import { useId, useState } from "react";
import { useStore } from "zustand";
import { navigate } from "../../app/navigation.js";
import { PaneTitle } from "../../app/title-row.js";
import { Flow, type FlowDoor, type FlowStation } from "../../components/flow/Flow.js";
import { Icon } from "../../components/icons/Icon.js";
import { LinkPill } from "../../components/kit/LinkPill.js";
import { PinControl } from "../../components/pin/PinControl.js";
import { type createWatchStore, watchStore } from "../../store/watch.js";
import { TABS } from "./tabs.js";
import "./service.css";

type WatchStore = ReturnType<typeof createWatchStore>;

const STATIONS: Readonly<Record<ServiceHome["stations"][number]["id"], string>> = {
  upstream: "Upstream",
  sync: "Sync PR",
  integration: "Integration",
  main: "Main",
};

const DOORS: Readonly<Record<ServiceHome["doors"][number]["id"], string>> = {
  template: "Template",
  release: "Release",
  other: "Other PRs",
  dependabot: "Dependabot",
};

const doorWord = (count: number | null) =>
  count === null ? "⌀ not read" : count === 0 ? "None open" : `${count} open`;

export default function ServicePage({
  id,
  tab,
  row,
  store = watchStore,
}: {
  id: string;
  tab?: string | undefined;
  row?: string | undefined;
  store?: WatchStore;
}) {
  const snapshot = useStore(store, (state) => state.snapshot?.body);
  const home = snapshot?.services?.find(({ service }) => service === id)?.home;
  return (
    <section className="service-page watch-pane" data-view-pane="service" aria-label={id}>
      <TopBar id={id} home={home} />
      {snapshot && home ? (
        <Home id={id} home={home} snapshot={snapshot} tab={tab} row={row} />
      ) : (
        <p className="service-quiet" data-quiet="unread">
          ⌀ This fork was not read.
        </p>
      )}
    </section>
  );
}

function TopBar({ id, home }: { id: string; home: ServiceHome | undefined }) {
  return (
    <PaneTitle end={<PinControl pin={id} name={id} />}>
      <h1 data-place>{id}</h1>
      {home && (
        <span className="service-top">
          <LinkPill
            link={{ label: home.repo, url: `https://github.com/${home.repo}`, kind: "other" }}
          />
          {home.released && (
            <span className="service-version" data-version="">
              {home.released}
              {home.next && ` → ${home.next}`}
              {home.bump && ` · ${home.bump}`}
            </span>
          )}
          {home.releasePr && (
            <LinkPill
              link={{ label: `PR #${home.releasePr.number}`, url: home.releasePr.url, kind: "pr" }}
            />
          )}
          {home.template !== "unknown" && (
            <button
              type="button"
              className="service-template"
              data-template={home.template}
              title={`Template ${home.template === "current" ? "current" : "behind"}. Open Template.`}
              onClick={() => navigate({ kind: "engineering-system" })}
            >
              <Icon name="layers" size={14} />
              {home.template === "current" ? <Icon name="check" size={14} stroke={2} /> : "behind"}
            </button>
          )}
        </span>
      )}
    </PaneTitle>
  );
}

function Home({
  id,
  home,
  snapshot,
  tab,
  row,
}: {
  id: string;
  home: ServiceHome;
  snapshot: ViewSnapshot;
  tab: string | undefined;
  row: string | undefined;
}) {
  const ids = useId();
  const [focus, setFocus] = useState(0);
  const [first] = TABS;
  const active = TABS.find((entry) => entry.id === tab) ?? first;
  const openRow = (row: string | undefined) =>
    row
      ? () => {
          setFocus((count) => count + 1);
          navigate({ kind: "service", id, tab: "overview", row });
        }
      : undefined;
  const stations: FlowStation[] = home.stations.map((station) => ({
    id: station.id,
    label: STATIONS[station.id],
    state: station.state,
    word: station.word,
    line: station.line,
    inTransit: station.inTransit,
    onOpen: openRow(station.row),
  }));
  const doors: FlowDoor[] = home.doors
    .filter((door) => door.id !== "template" || door.prs.length > 0)
    .map((door) => ({
      id: door.id,
      label: DOORS[door.id],
      word: doorWord(door.count),
      onOpen: openRow(door.row),
    }));
  if (!active) return null;
  return (
    <div className="service-home">
      <Flow label={`How code reaches ${id} main`} stations={stations} doors={doors} />
      <div className="service-tabs" role="tablist" aria-label={`${id} tabs`}>
        {TABS.map((entry) => {
          const count = entry.count?.({ id, home, snapshot });
          return (
            <button
              key={entry.id}
              type="button"
              role="tab"
              id={`${ids}-${entry.id}`}
              className="service-tab"
              data-tab={entry.id}
              aria-selected={entry === active}
              aria-controls={`${ids}-panel`}
              onClick={() =>
                navigate({ kind: "service", id, ...(entry === first ? {} : { tab: entry.id }) })
              }
            >
              {entry.label}
              {count === null ? (
                <span className="service-tab-count" title="Not read">
                  ⌀
                </span>
              ) : (
                !!count && <span className="service-tab-count">{count}</span>
              )}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id={`${ids}-panel`} aria-labelledby={`${ids}-${active.id}`}>
        <active.Panel
          id={id}
          home={home}
          snapshot={snapshot}
          row={tab === active.id ? row : undefined}
          focus={focus}
        />
      </div>
    </div>
  );
}
