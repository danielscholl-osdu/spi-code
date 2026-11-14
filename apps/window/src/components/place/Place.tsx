// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { PlaceRow, Reading, Tone, ViewSnapshot } from "@spi-code/contracts";
import type { ReactNode } from "react";
import { type Navigation, PLACES, routeLabel } from "../../app/navigation.js";
import { PlacePin } from "../../app/PlacePin.js";
import { scopeRoute } from "../../app/queue.js";
import { PaneTitle } from "../../app/title-row.js";
import { plainTitle } from "../../text.js";
import { instantsIn, TimedText, timedText } from "../../time.js";
import { FreshChip, FreshItems, freshItemIds } from "./FreshItems.js";
import "./place.css";

type Item = NonNullable<Reading["content"]>["items"][number];

/** An item's due, unless its group heading names the same instant and so already says it. */
function ownDue(item: Item): Item["due"] {
  return item.due && instantsIn(item.group).includes(Date.parse(item.due.at))
    ? undefined
    : item.due;
}

/** A lead tile; a tone inks its value, and frames it when it leads. */
export type PlaceTile = { label: string; value: string; counts: string; tone?: Tone };

export type PlaceProps = {
  name: string;
  reading: Reading;
  snapshot?: ViewSnapshot | undefined;
  services?: readonly string[];
  onNavigate: Navigation["navigate"];
  /** Without onSelect, item content stays static and scope chips still navigate. */
  onSelect?: (id: string) => void;
  selectedId?: string;
  actions?: ReactNode;
  /** The pin this place is kept under in the sidebar; without it the header has no Pin. */
  pin?: string | undefined;
  /** Tiles drawn in place of the reading's own. */
  tiles?: readonly PlaceTile[] | undefined;
  /** Drawn between the tiles and the items. */
  belowTiles?: ReactNode;
  /** Drawn after the items. */
  belowItems?: ReactNode;
};

/** A null reading content leaves only the place header, without an empty reading region. */
export function Place({
  name,
  reading,
  snapshot,
  services = [],
  onNavigate,
  onSelect,
  selectedId,
  actions,
  pin,
  tiles,
  belowTiles,
  belowItems,
}: PlaceProps) {
  const { content } = reading;
  const place = (
    {
      program: "line",
      environment: "environment",
      engineering: "engineering",
      security: "security",
    } as Partial<Record<Reading["anchor"]["kind"], PlaceRow["place"]>>
  )[reading.anchor.kind];
  const fresh = place ? freshItemIds(snapshot, place) : [];
  const ItemContent = onSelect ? "button" : "div";
  const lead = tiles ?? content?.tiles;
  const groups = new Map<string, Item[]>();
  for (const item of content?.items.slice(0, 5) ?? []) {
    const group = groups.get(item.group);
    if (group) group.push(item);
    else groups.set(item.group, [item]);
  }
  return (
    <section className="place" aria-label={name}>
      <PaneTitle>
        <h1 data-place>{name}</h1>
        {actions}
        {pin && <PlacePin pin={pin} name={name} />}
      </PaneTitle>
      {(content || tiles || belowTiles) && (
        <section className="place-reading" aria-label={`${name} reading`}>
          {content && (
            <h2 className="place-headline">
              <TimedText text={content.headline} hint={false} />
            </h2>
          )}
          {content?.qualifier && <p className="place-qualifier">{content.qualifier}</p>}
          {lead && (
            <dl className="place-tiles">
              {lead.map((tile: PlaceTile, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: The three tile positions are fixed; labels may repeat.
                <div className="place-tile" key={index} data-tone={tile.tone}>
                  <dt>{tile.label}</dt>
                  <dd className="place-tile-value">{tile.value}</dd>
                  <dd className="place-tile-counts">
                    <TimedText text={tile.counts} hint={false} />
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {belowTiles}
          {groups.size > 0 && (
            <div className="place-groups">
              {[...groups].map(([label, items]) => (
                <section
                  className="place-group"
                  aria-label={timedText(label, { hint: false })}
                  key={label}
                >
                  <h3>
                    <TimedText text={label} hint={false} />
                  </h3>
                  <ul>
                    {items.map((item) => {
                      const route =
                        PLACES.find((place) => routeLabel(place) === item.scope) ??
                        scopeRoute(item.scope, services);
                      const due = ownDue(item);
                      return (
                        <li
                          className="place-item"
                          key={item.id}
                          data-item-id={item.id}
                          data-attention={item.attention}
                          data-owned={item.owned || undefined}
                          data-selected={(onSelect && selectedId === item.id) || undefined}
                        >
                          <span className="place-rank" data-rung={item.rung}>
                            P{item.rung}
                          </span>
                          <div className="place-item-body">
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
                            <ItemContent
                              className="place-item-content"
                              type={onSelect ? "button" : undefined}
                              data-selection-id={onSelect ? item.id : undefined}
                              aria-label={
                                onSelect
                                  ? timedText(`${item.scope}: ${plainTitle(item.title)}`, {
                                      hint: false,
                                    })
                                  : undefined
                              }
                              title={
                                !due && item.due
                                  ? timedText(`Before ${item.due.before}`, { hint: false })
                                  : undefined
                              }
                              aria-pressed={onSelect ? selectedId === item.id : undefined}
                              onClick={onSelect ? () => onSelect(item.id) : undefined}
                            >
                              <span className="place-item-title">
                                <TimedText text={plainTitle(item.title)} hint={false} />
                              </span>
                              {item.sub && (
                                <span className="place-item-sub">
                                  <TimedText text={plainTitle(item.sub)} hint={false} />
                                </span>
                              )}
                              {(due || item.owned) && (
                                <span className="place-item-meta">
                                  {due && <time dateTime={due.at}>Before {due.before}</time>}
                                  {item.owned && <span className="place-owned">Owned</span>}
                                </span>
                              )}
                              {item.next && (
                                <span className="place-item-next">{plainTitle(item.next)}</span>
                              )}
                            </ItemContent>
                            {fresh.includes(item.id) && <FreshChip id={item.id} />}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          )}
          {content?.folded && <p className="place-folded">{content.folded}</p>}
          {belowItems}
        </section>
      )}
      {place && (
        <FreshItems
          snapshot={snapshot}
          place={place}
          shown={content?.items.map(({ id }) => id)}
          onSelect={onSelect}
        />
      )}
    </section>
  );
}
