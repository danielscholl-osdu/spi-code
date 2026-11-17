// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ButtonHTMLAttributes } from "react";
import { type QueueEntry, scopeRoute } from "../../app/queue.js";
import type { Route } from "../../app/routes.js";
import { plainTitle } from "../../text.js";
import { TimedText } from "../../time.js";
import "./queue.css";

/** One queue item; its title opens what the page opens for it. */
export function QueueRow({
  entry: { item, pointer },
  selected,
  services,
  onNavigate,
  opens,
}: {
  entry: QueueEntry;
  selected: boolean;
  services: readonly string[];
  onNavigate(route: Route): void;
  opens: ButtonHTMLAttributes<HTMLButtonElement>;
}) {
  const route = scopeRoute(item.scope, services);
  return (
    <li
      className="inbox-row"
      data-selection-id={item.id}
      data-pointer={pointer}
      data-selected={selected || undefined}
    >
      <span className="inbox-priority" data-rung={item.rung}>
        P{item.rung}
      </span>
      <span className="inbox-row-body">
        <span className="inbox-row-line">
          {route ? (
            <button
              type="button"
              className="inbox-scope"
              data-scope={item.scope}
              title={`Open ${item.scope}`}
              onClick={() => onNavigate(route)}
            >
              {item.scope}
            </button>
          ) : (
            <span className="inbox-scope" data-scope={item.scope} data-fleet>
              {item.scope}
            </span>
          )}
          <button type="button" className="inbox-row-title" {...opens}>
            <TimedText text={plainTitle(item.title)} hint={false} />
          </button>
          <span className="inbox-class">{item.cls}</span>
        </span>
        <span className="inbox-sub">{plainTitle(item.sub)}</span>
      </span>
    </li>
  );
}
