// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type SecurityPane as Pane, SECURITY_NOT_READ } from "@spi-code/contracts";
import { useRef } from "react";
import { useStore } from "zustand";
import { PaneTitle } from "../../../app/title-row.js";
import { PinControl } from "../../../components/pin/PinControl.js";
import { placePin } from "../../../store/pins.js";
import { type createWatchStore, watchStore } from "../../../store/watch.js";
import { ByRepository } from "./ByRepository.js";
import { ByRule } from "./ByRule.js";
import { type SectionProps, type SecurityView, useSecurityState } from "./state.js";
import { Lead, Top } from "./Top.js";
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
  const saved = useStore(store, (state) => state.snapshot !== null);
  const security = useStore(store, (state) => state.snapshot?.body.security);
  const pane = given ?? security;
  const root = useRef<HTMLElement>(null);
  const { state, actions } = useSecurityState(root);
  if (!pane?.read)
    return (
      <section className="place security-pane" aria-label="Security">
        <Title />
        {pane ? (
          <div className="security-top">
            <Lead page={pane.page} />
          </div>
        ) : (
          saved && (
            <div className="security-top">
              <p className="security-headline">
                <Words words={[...SECURITY_NOT_READ]} />
              </p>
            </div>
          )
        )}
      </section>
    );
  const lane = pane.lanes.find(({ id }) => id === (state.lane ?? pane.page.opens));
  const props: SectionProps | undefined = lane && { pane, lane, state, actions };
  return (
    <section ref={root} className="place security-pane" aria-label="Security">
      <Title />
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
    </section>
  );
}

function Title() {
  return (
    <PaneTitle end={<PinControl pin={placePin("security")} name="Security" />}>
      <h1 data-place>Security</h1>
    </PaneTitle>
  );
}
