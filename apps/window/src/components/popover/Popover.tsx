// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ReactNode, useEffect, useLayoutEffect, useRef } from "react";
import { type OpenSelection, openSelection } from "../../app/navigation.js";
import type { OpenedContent } from "../opened-body/content.js";
import { OpenedBody } from "../opened-body/OpenedBody.js";
import { placePopover } from "./place.js";
import "./popover.css";

export type PopoverProps = {
  /** What was clicked. The popover hangs under it, or above it near the window's foot, and focus returns to it on close. */
  anchor: HTMLElement;
  /**
   * What is open on the place. The body registers it with `setOpenSelection(selection,
   * content.subject)`, so the Swept capsule opens Evidence for the subject and Back reopens this.
   */
  selection: OpenSelection;
  /** The shared reading; its title heads the popover, since the place does not show the subject. */
  content: OpenedContent;
  /**
   * Clear the open selection. Called on Escape, the close button and a click outside it within the
   * anchor's nearest `[data-popover-scope]` (the place's page or sheet), so the Swept capsule can
   * still open Evidence for what is open.
   */
  onClose(): void;
  /** Rows under the body that belong to this place, such as a cell's other members. */
  children?: ReactNode;
};

/** The one popover every place opens on what was clicked: a Line cell, a rung, a run, a repository line. */
export function Popover({ anchor, selection, content, onClose, children }: PopoverProps) {
  const element = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    const popover = element.current;
    if (!popover) return;
    const place = () => {
      popover.style.maxHeight = "";
      const box = anchor.getBoundingClientRect();
      const at = placePopover(
        box,
        { width: popover.offsetWidth, height: popover.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      );
      popover.style.top = `${at.top}px`;
      popover.style.left = `${at.left}px`;
      popover.style.maxHeight = at.maxHeight === undefined ? "" : `${at.maxHeight}px`;
      popover.dataset.side = at.side;
    };
    place();
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
    };
  });

  useLayoutEffect(() => {
    const popover = element.current;
    popover?.focus({ preventScroll: true });
    return () => {
      const focus = document.activeElement;
      const lost = !focus || focus === document.body || popover?.contains(focus);
      if (lost && anchor.isConnected && !anchor.closest("[inert]"))
        anchor.focus({ preventScroll: true });
    };
  }, [anchor]);

  const { kind, id } = selection;
  useEffect(() => {
    const popover = element.current;
    const mine = () => {
      const open = openSelection();
      return open?.kind === kind && open.id === id;
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      const focus = document.activeElement;
      if (focus && !popover?.contains(focus) && focus.closest("[role='dialog'], [role='menu']"))
        return;
      event.preventDefault();
      event.stopPropagation();
      close.current();
    };
    // After the page's own handlers, so a click that opened something else leaves it open.
    const outside = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || popover?.contains(target) || anchor.contains(target)) return;
      if (!(anchor.closest("[data-popover-scope]") ?? document).contains(target)) return;
      if (target instanceof Element && target.closest("[role='menu']")) return;
      if (mine()) close.current();
    };
    window.addEventListener("keydown", onEscape, true);
    document.addEventListener("click", outside);
    return () => {
      window.removeEventListener("keydown", onEscape, true);
      document.removeEventListener("click", outside);
    };
  }, [anchor, kind, id]);

  return (
    <div
      ref={element}
      className="popover"
      role="dialog"
      aria-label={content.title}
      tabIndex={-1}
      data-selection={`${kind}~${id}`}
    >
      <button type="button" className="popover-close" aria-label="Close" onClick={onClose}>
        ×
      </button>
      <OpenedBody content={content} selection={selection} origin="place" onClose={onClose} />
      {children}
    </div>
  );
}
