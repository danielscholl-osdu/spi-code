// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SecurityPane as Pane } from "@spi-code/contracts";
import { useRef } from "react";
import { useStore } from "zustand";
import { PaneTitle } from "../../../app/title-row.js";
import { PinControl } from "../../../components/pin/PinControl.js";
import { placePin } from "../../../store/pins.js";
import { type createWatchStore, watchStore } from "../../../store/watch.js";
import { ByRepository } from "./ByRepository.js";
import { ByRule } from "./ByRule.js";
import { type SectionProps, useSecurityState } from "./state.js";
import { Top } from "./Top.js";
import "./pane.css";

type WatchStore = ReturnType<typeof createWatchStore>;

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
  const lane = pane?.lanes.find(({ id }) => id === (state.lane ?? pane.page.opens));
  const props: SectionProps | undefined = pane && lane && { pane, lane, state, actions };
  return (
    <section ref={root} className="place security-pane" aria-label="Security">
      <PaneTitle end={<PinControl pin={placePin("security")} name="Security" />}>
        <h1 data-place>Security</h1>
      </PaneTitle>
      {props && (
        <>
          <Top {...props} />
          {state.view === "rule" ? <ByRule {...props} /> : <ByRepository {...props} />}
        </>
      )}
    </section>
  );
}
