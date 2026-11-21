// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SecurityPane as Pane, ViewSnapshot } from "@spi-code/contracts";
import { useRef } from "react";
import { useStore } from "zustand";
import { navigate } from "../../../app/navigation.js";
import { treeServices } from "../../../app/queue.js";
import { PaneTitle } from "../../../app/title-row.js";
import { PinControl } from "../../../components/pin/PinControl.js";
import { FreshItems } from "../../../components/place/FreshItems.js";
import { Place } from "../../../components/place/Place.js";
import { placePin } from "../../../store/pins.js";
import { type createWatchStore, watchStore } from "../../../store/watch.js";
import { ByRepository } from "./ByRepository.js";
import { ByRule } from "./ByRule.js";
import { type SectionProps, type SecurityView, useSecurityState } from "./state.js";
import { Top } from "./Top.js";
import { Words } from "./Words.js";
import "./pane.css";

type WatchStore = ReturnType<typeof createWatchStore>;

const VIEWS: readonly SecurityView[] = ["rule", "repository"];

/** The Security place: the top of the page, then the chosen lane by rule or by repository. */
export function SecurityPane({
  store = watchStore,
  pane: given,
}: {
  store?: WatchStore;
  pane?: Pane;
}) {
  const snapshot = useStore(store, (state) => state.snapshot?.body);
  const pane = given ?? snapshot?.security;
  const root = useRef<HTMLElement>(null);
  const { state, actions } = useSecurityState(root);
  if (!pane?.read) return <Unread snapshot={snapshot} />;
  const lane = pane.lanes.find(({ id }) => id === (state.lane ?? pane.page.opens));
  const props: SectionProps | undefined = lane && { pane, lane, state, actions };
  return (
    <section ref={root} className="place security-pane" aria-label="Security">
      <PaneTitle end={<PinControl pin={placePin("security")} name="Security" />}>
        <h1 data-place>Security</h1>
      </PaneTitle>
      {props && (
        <>
          <Top {...props} />
          {props.lane.total.n > 0 && (
            <div className="security-tools">
              <span className="security-summary">
                <Words words={props.lane.byRule.summary} />
              </span>
              <fieldset className="security-views">
                {VIEWS.map((view) => (
                  <button
                    key={view}
                    type="button"
                    aria-pressed={state.view === view}
                    onClick={() => actions.setView(view)}
                  >
                    {pane.views[view]}
                  </button>
                ))}
              </fieldset>
            </div>
          )}
          {state.view === "rule" ? <ByRule {...props} /> : <ByRepository {...props} />}
        </>
      )}
      <FreshItems snapshot={snapshot} place="security" />
    </section>
  );
}

/** Before any list was read: what the place drew from the security reading, or its title alone. */
function Unread({ snapshot }: { snapshot: ViewSnapshot | undefined }) {
  const reading = snapshot?.readings.find(({ anchor }) => anchor.kind === "security") ?? {
    anchor: { kind: "security" },
    content: null,
  };
  return (
    <Place
      name="Security"
      pin={placePin("security")}
      reading={reading}
      snapshot={snapshot}
      services={treeServices(snapshot?.tree)}
      onNavigate={navigate}
    />
  );
}
