// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type {
  SecurityLane,
  SecurityLaneId,
  SecurityPane,
  SecurityRuleKey,
  SecurityRuleRow,
} from "@spi-code/contracts";
import { type RefObject, useEffect, useMemo, useReducer, useRef } from "react";

export type SecurityView = "rule" | "repository";

export interface SecurityState {
  /** The chosen lane; null until chosen, when the page's own opening lane applies. */
  lane: SecurityLaneId | null;
  view: SecurityView;
  /** The rule or package opened in By rule. */
  rule: SecurityRuleKey | null;
  /** The repository opened in By repository. */
  repository: string | null;
  /** The repository marked in the opened rule. */
  mark: string | null;
  /** Bumped when an action moves focus to what it opened. */
  focus: number;
}

/** What every section is handed; sections call these and add none. */
export interface SecurityActions {
  chooseLane(lane: SecurityLaneId): void;
  setView(view: SecurityView): void;
  /** Opens a rule from a block, a tick or a repository pill, in its own lane, and moves focus there. */
  openRule(key: SecurityRuleKey | null, mark?: string): void;
  openRepository(name: string | null): void;
}

export interface SectionProps {
  pane: SecurityPane;
  lane: SecurityLane;
  state: SecurityState;
  actions: SecurityActions;
}

export interface OpenedRuleProps extends SectionProps {
  rule: SecurityRuleRow;
}

/** Marks a rule's row, and a repository's line inside it, so an opening action can move focus there. */
export const RULE_ATTR = "data-security-rule";
export const REPOSITORY_ATTR = "data-security-repository";

export type SecurityAction =
  | { type: "lane"; lane: SecurityLaneId }
  | { type: "view"; view: SecurityView }
  | { type: "rule"; key: SecurityRuleKey | null; mark?: string | undefined }
  | { type: "repository"; name: string | null };

export const INITIAL_STATE: SecurityState = {
  lane: null,
  view: "rule",
  rule: null,
  repository: null,
  mark: null,
  focus: 0,
};

/** The lane a rule key belongs to. */
export const laneOf = (key: SecurityRuleKey) => key.slice(0, key.indexOf(":")) as SecurityLaneId;

export function securityReducer(state: SecurityState, action: SecurityAction): SecurityState {
  switch (action.type) {
    case "lane":
      return action.lane === state.lane
        ? state
        : { ...state, lane: action.lane, rule: null, repository: null, mark: null };
    case "view":
      return { ...state, view: action.view };
    case "rule":
      if (action.key === null) return { ...state, rule: null, mark: null };
      return {
        ...state,
        lane: laneOf(action.key),
        view: "rule",
        rule: action.key,
        repository: null,
        mark: action.mark ?? null,
        focus: state.focus + 1,
      };
    case "repository":
      return {
        ...state,
        view: "repository",
        repository: action.name,
        rule: null,
        mark: null,
        focus: action.name === null ? state.focus : state.focus + 1,
      };
  }
}

const selector = (attr: string, value: string) =>
  `[${attr}="${value.replaceAll(/["\\]/g, "\\$&")}"]`;

function moveFocus(root: HTMLElement, state: SecurityState) {
  const row =
    state.view === "rule" && state.rule
      ? root.querySelector<HTMLElement>(selector(RULE_ATTR, state.rule))
      : state.view === "repository" && state.repository
        ? root.querySelector<HTMLElement>(selector(REPOSITORY_ATTR, state.repository))
        : null;
  const target =
    (state.mark && row?.querySelector<HTMLElement>(selector(REPOSITORY_ATTR, state.mark))) || row;
  if (!target) return;
  if (!target.hasAttribute("tabindex") && target.tabIndex < 0)
    target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
  target.scrollIntoView?.({ block: "nearest" });
}

/** The page's state and the actions sections share; focus follows what an action opened. */
export function useSecurityState(root: RefObject<HTMLElement | null>) {
  const [state, dispatch] = useReducer(securityReducer, INITIAL_STATE);
  const actions = useMemo<SecurityActions>(
    () => ({
      chooseLane: (lane) => dispatch({ type: "lane", lane }),
      setView: (view) => dispatch({ type: "view", view }),
      openRule: (key, mark) => dispatch({ type: "rule", key, mark }),
      openRepository: (name) => dispatch({ type: "repository", name }),
    }),
    [],
  );
  const latest = useRef(state);
  latest.current = state;
  const { focus } = state;
  useEffect(() => {
    if (focus > 0 && root.current) moveFocus(root.current, latest.current);
  }, [focus, root]);
  return { state, actions };
}
