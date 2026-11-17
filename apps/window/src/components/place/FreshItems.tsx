// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { PlaceRow, ViewSnapshot } from "@spi-code/contracts";
import { useEffect, useRef } from "react";
import { type Destination, setOpenSelection, useOpenSelection } from "../../app/navigation.js";
import { selectionRows } from "../../panels/selection-rows.js";
import { plainTitle } from "../../text.js";
import { TimedText } from "../../time.js";
import { Chip } from "../kit/Chip.js";
import { type OpenedContent, todayContent } from "../opened-body/content.js";
import { OpenedBody } from "../opened-body/OpenedBody.js";
import "./place.css";

export function freshItemIds(snapshot: ViewSnapshot | undefined, place: PlaceRow["place"]) {
  return snapshot?.briefing.places?.find((row) => row.place === place)?.fresh?.itemIds ?? [];
}

export function FreshChip({ id }: { id: string }) {
  return (
    <span data-fresh-item={id}>
      <Chip label="new" text="New since your last look" tone="accent" />
    </span>
  );
}

/** Keeps fresh items reachable when the reading folds them or the place uses a grid. */
export function FreshItems({
  snapshot,
  place,
  shown = [],
}: {
  snapshot: ViewSnapshot | undefined;
  place: PlaceRow["place"];
  shown?: readonly string[] | undefined;
}) {
  const fresh = freshItemIds(snapshot, place);
  const freshKey = fresh.join("|");
  const opened = useOpenSelection();
  const element = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (opened?.kind !== "fresh-item" || !freshKey.split("|").includes(opened.id)) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !element.current?.contains(event.target))
        setOpenSelection(null);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [opened, freshKey]);
  if (!snapshot || !fresh.length) return null;
  const items = [...snapshot.briefing.focus, ...snapshot.briefing.rest];
  const rows = selectionRows(snapshot);
  const missing = [...new Set(fresh)].flatMap((id) => {
    const item = items.find((item) => item.id === id);
    const row = rows.find((row) => row.kind === "queue" && row.id === id);
    return item && row && !shown.includes(id) ? [{ item, row }] : [];
  });
  if (!missing.length) return null;
  return (
    <ul className="place-fresh-items" aria-label="New items" ref={element}>
      {missing.map(({ item }) => {
        const selection = { kind: "fresh-item", id: item.id };
        const line = snapshot.briefing.lines?.find(({ members }) =>
          members.some((member) => member.id === item.id || member.ids.includes(item.id)),
        );
        const member = line?.members.find(
          (member) => member.id === item.id || member.ids.includes(item.id),
        );
        const home = member?.home ?? place;
        const destination: Destination =
          home === "engineering" ? { kind: "engineering-system" } : { kind: home };
        const bodyPlace = {
          label:
            home === "line"
              ? "Line"
              : home === "engineering"
                ? "Template"
                : home === "environment"
                  ? "Environment"
                  : home === "upstream"
                    ? "Upstream"
                    : "Security",
          destination,
        };
        const content: OpenedContent =
          line && member
            ? todayContent({ line, member, items, place: bodyPlace })
            : {
                title: plainTitle(item.title),
                place: bodyPlace,
                subject: null,
                cause: plainTitle(item.cause),
                effect: plainTitle(item.effect),
                steps: item.next ? [plainTitle(item.next)] : [],
                ...(item.evidence[0] ? { primary: item.evidence[0] } : {}),
                links: item.evidence,
              };
        const isOpen = opened?.kind === selection.kind && opened.id === selection.id;
        return (
          <li className="place-item" key={item.id} data-item-id={item.id}>
            <span className="place-rank" data-rung={item.rung}>
              P{item.rung}
            </span>
            <div className="place-item-body">
              <button
                type="button"
                className="place-item-content"
                data-selection-id={item.id}
                onClick={() => {
                  setOpenSelection(isOpen ? null : selection, content.subject);
                }}
              >
                <span className="place-item-title">
                  {item.scope}: <TimedText text={plainTitle(item.title)} hint={false} />
                </span>
              </button>
              <FreshChip id={item.id} />
            </div>
            {isOpen && (
              <div className="place-fresh-body">
                <OpenedBody
                  content={content}
                  selection={selection}
                  origin="place"
                  onClose={() => setOpenSelection(null)}
                />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
