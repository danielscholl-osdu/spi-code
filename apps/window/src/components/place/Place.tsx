// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Reading } from "@spi-code/contracts";
import { type Navigation, PLACES, routeLabel } from "../../app/navigation.js";
import { scopeRoute } from "../../views/inbox/queue.js";
import "./place.css";

export type PlaceProps = {
  name: string;
  reading: Reading;
  services?: readonly string[];
  onNavigate: Navigation["navigate"];
  /** Supply only when the place is outside the sidebar; pin persistence belongs to the caller. */
  onPin?: () => void;
};

/** A null reading content leaves only the place header, without an empty reading region. */
export function Place({ name, reading, services = [], onNavigate, onPin }: PlaceProps) {
  const { content } = reading;
  const groups = new Map<string, NonNullable<Reading["content"]>["items"]>();
  for (const item of content?.items.slice(0, 5) ?? []) {
    const group = groups.get(item.group);
    if (group) group.push(item);
    else groups.set(item.group, [item]);
  }
  return (
    <section className="place" aria-label={name}>
      <header className="place-header">
        <h1>{name}</h1>
        {onPin && (
          <button type="button" aria-label={`Pin ${name}`} onClick={() => onPin()}>
            Pin
          </button>
        )}
      </header>
      {content && (
        <section className="place-reading" aria-label={`${name} reading`}>
          <h2 className="place-headline">{content.headline}</h2>
          {content.qualifier && <p className="place-qualifier">{content.qualifier}</p>}
          <dl className="place-tiles">
            {content.tiles.map((tile) => (
              <div className="place-tile" key={tile.label}>
                <dt>{tile.label}</dt>
                <dd className="place-tile-value">{tile.value}</dd>
                <dd className="place-tile-counts">{tile.counts}</dd>
              </div>
            ))}
          </dl>
          {groups.size > 0 && (
            <div className="place-groups">
              {[...groups].map(([label, items]) => (
                <section className="place-group" aria-label={label} key={label}>
                  <h3>{label}</h3>
                  <ul>
                    {items.map((item) => {
                      const route =
                        PLACES.find((place) => routeLabel(place) === item.scope) ??
                        scopeRoute(item.scope, services);
                      return (
                        <li
                          className="place-item"
                          key={item.id}
                          data-item-id={item.id}
                          data-attention={item.attention}
                          data-owned={item.owned || undefined}
                        >
                          <span className="place-rank" data-rung={item.rung}>
                            P{item.rung}
                          </span>
                          <div className="place-item-body">
                            <div>
                              {route ? (
                                <button
                                  type="button"
                                  className="place-scope"
                                  title={`Open ${item.scope}`}
                                  onClick={() => onNavigate(route)}
                                >
                                  {item.scope}
                                </button>
                              ) : (
                                <span className="place-scope" data-aggregate>
                                  {item.scope}
                                </span>
                              )}
                              <span className="place-item-title">{item.title}</span>
                            </div>
                            {item.sub && <p className="place-item-sub">{item.sub}</p>}
                            {(item.due || item.owned) && (
                              <div className="place-item-meta">
                                {item.due && (
                                  <time dateTime={item.due.at}>Before {item.due.before}</time>
                                )}
                                {item.owned && <span className="place-owned">Owned</span>}
                              </div>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          )}
          {content.folded && <p className="place-folded">{content.folded}</p>}
        </section>
      )}
    </section>
  );
}
