// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ViewSnapshot } from "@spi-code/contracts";
import { type RefObject, useCallback, useLayoutEffect, useRef, useState } from "react";
import { type OpenSelection, setOpenSelection, useOpenSelection } from "../../app/navigation.js";
import type { SelectionField } from "../../panels/selection-rows.js";
import { plainTitle } from "../../text.js";
import { TimedText, timedText } from "../../time.js";
import { type BodyPlace, type OpenedContent, todayContent } from "../opened-body/content.js";
import "./opening.css";

export const openingKey = ({ kind, id }: OpenSelection) => `${kind}~${id}`;

const marking = (scope: ParentNode, key: string) =>
  [...scope.querySelectorAll<HTMLElement>("[data-opens]")].find(
    (element) => element.dataset.opens === key,
  );

/**
 * The control clicked for the open selection, else the place's own item, else the first marked as
 * opening it on the page, else in the shell's title row, where a place's head actions draw.
 */
function anchorOf(
  root: HTMLElement | null,
  key: string,
  clicked: { key: string; element: HTMLElement } | null,
): HTMLElement | null {
  if (!root) return null;
  if (clicked?.key === key && clicked.element.isConnected) return clicked.element;
  const item = key.startsWith("item~")
    ? [...root.querySelectorAll<HTMLElement>(".place [data-selection-id]")].find(
        (element) => element.dataset.selectionId === key.slice(5),
      )
    : undefined;
  return item ?? marking(root, key) ?? marking(root.ownerDocument, key) ?? null;
}

/**
 * What a place opens in its popover: the open selection, the element it hangs under (also when Back
 * reopens it), and the props that make a control open and close it.
 */
export function usePlaceOpening(root: RefObject<HTMLElement | null>, redraw: unknown) {
  const marked = useOpenSelection();
  const key = marked && openingKey(marked);
  const clicked = useRef<{ key: string; element: HTMLElement } | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new snapshot redraws the anchors.
  useLayoutEffect(() => {
    const found = key ? anchorOf(root.current, key, clicked.current) : null;
    const folded = found?.closest("details");
    if (folded && !folded.open) folded.open = true;
    setAnchor(found);
  }, [key, redraw]);
  const close = useCallback(() => setOpenSelection(null), []);
  const toggle = (selection: OpenSelection, element: HTMLElement) => {
    const next = openingKey(selection);
    clicked.current = { key: next, element };
    setOpenSelection(key === next ? null : selection);
  };
  const opener = (selection: OpenSelection) => ({
    "data-opens": openingKey(selection),
    "aria-haspopup": "dialog" as const,
    "aria-expanded": key === openingKey(selection),
    onClick: (event: { currentTarget: HTMLElement }) => toggle(selection, event.currentTarget),
  });
  /** For a place item, which the Place draws with its own button and reports by id. */
  const openItem = (id: string) => {
    const element = [
      ...(root.current?.querySelectorAll<HTMLElement>(".place [data-selection-id]") ?? []),
    ].find((element) => element.dataset.selectionId === id);
    if (element) toggle({ kind: "item", id }, element);
  };
  const shown = anchor?.isConnected ? anchor : null;
  return { marked, anchor: shown, opener, openItem, toggle, close };
}

const said = (text: string) => timedText(plainTitle(text), { hint: false });

/** The body's words with the instants core wrote in them read as local times. */
export function timed(content: OpenedContent): OpenedContent {
  const { cause, effect, steps, deadline } = content;
  return {
    ...content,
    title: said(content.title),
    ...(deadline ? { deadline: { ...deadline, reason: said(deadline.reason) } } : {}),
    ...(cause ? { cause: said(cause) } : {}),
    ...(effect ? { effect: said(effect) } : {}),
    ...(steps ? { steps: steps.map(said) } : {}),
  };
}

/** An item on a place: its Today member's reading, else the item's own, else its repository's. */
export function itemContent(
  snapshot: ViewSnapshot,
  id: string,
  place: BodyPlace,
): OpenedContent | undefined {
  const content = rawItemContent(snapshot, id, place);
  return content && timed(content);
}

function rawItemContent(
  snapshot: ViewSnapshot,
  id: string,
  place: BodyPlace,
): OpenedContent | undefined {
  const items = [...snapshot.briefing.focus, ...snapshot.briefing.rest];
  for (const line of snapshot.briefing.lines ?? []) {
    const member = line.members.find((m) => m.id === id || m.ids.includes(id));
    if (!member) continue;
    return todayContent({ line, member, items, place });
  }
  const item =
    items.find((item) => item.id === id) ??
    snapshot.readings.flatMap(({ content }) => content?.items ?? []).find((item) => item.id === id);
  if (!item) {
    const repository = snapshot.briefing.repositories.rows.find((row) => row.id === id);
    return repository && { title: repository.title, place, subject: null, cause: repository.sub };
  }
  return {
    title: item.title,
    place,
    subject: null,
    cause: item.cause,
    effect: item.effect,
    steps: item.next ? [item.next] : [],
    ...(item.evidence[0] ? { primary: item.evidence[0] } : {}),
    links: item.evidence,
  };
}

/** A row's own reading under the body, for a selection the sweep carries as facts, not a story; "·" reads blank. */
export function PopoverFields({ fields }: { fields: readonly SelectionField[] }) {
  if (!fields.length) return null;
  return (
    <dl className="popover-fields">
      {fields.map(({ label, value, href }, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: labels repeat (Detail lines) and values can too.
        <div key={index}>
          <dt>{label}</dt>
          <dd>
            {href ? (
              <a
                href={href}
                onClick={(event) => {
                  event.preventDefault();
                  void window.spi?.openExternal(href);
                }}
              >
                <TimedText text={value} hint={false} />
              </a>
            ) : value === "·" ? (
              ""
            ) : (
              <TimedText text={value} hint={false} />
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
