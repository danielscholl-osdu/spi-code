// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT
//
// Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import { useSyncExternalStore } from "react";
import { routeLabel } from "../app/navigation.js";
import { type PinChange, pinnedPlace, restorePin, subscribePinChanges, unpin } from "./pins.js";

export type PinNotice = PinChange & { serial: number; label: string };
let notice: PinNotice | null = null;
let justPinned: string | null = null;
let serial = 0;
let claimed = false;
let undoing = false;
let remaining = 0;
let started = 0;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let flashTimer: ReturnType<typeof setTimeout> | undefined;
const pauses = new Set<string>();
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

export function clearPinNotice() {
  clearTimeout(noticeTimer);
  notice = null;
  claimed = false;
  emit();
}

function schedule() {
  clearTimeout(noticeTimer);
  started = Date.now();
  if (notice && pauses.size === 0) noticeTimer = setTimeout(clearPinNotice, remaining);
}

/** Hover and focus pause independently, preserving the unelapsed part of the eight seconds. */
export function pausePinNotice(reason: string, paused: boolean) {
  if (paused) {
    if (pauses.has(reason)) return;
    if (pauses.size === 0 && notice) remaining = Math.max(0, remaining - (Date.now() - started));
    pauses.add(reason);
    clearTimeout(noticeTimer);
  } else {
    if (!pauses.delete(reason)) return;
    if (pauses.size === 0) schedule();
  }
}

/** The sidebar owns the visibility reader and this subscription's lifetime. */
export function observePinFeedback(listShown: () => boolean) {
  return subscribePinChanges((change) => {
    if (undoing) return;
    clearTimeout(flashTimer);
    justPinned = null;
    clearPinNotice();
    if (change.kind === "pinned" && listShown()) {
      justPinned = change.pin;
      flashTimer = setTimeout(() => {
        justPinned = null;
        emit();
      }, 1_000);
    } else {
      const place = pinnedPlace(change.pin);
      notice = {
        ...change,
        serial: ++serial,
        label: place ? routeLabel({ kind: place }) : change.pin,
      };
      claimed = true;
      remaining = 8_000;
      schedule();
    }
    emit();
  });
}

/** Undo updates this window even when best-effort storage refuses the write. */
export function undoPinChange(): boolean {
  if (!notice) return false;
  const change = notice;
  clearPinNotice();
  undoing = true;
  try {
    if (change.kind === "unpinned") restorePin(change.pin, change.index);
    else unpin(change.pin);
  } finally {
    undoing = false;
  }
  return true;
}

export const pinUndoClaimsShortcut = () => claimed && notice !== null;
export const releasePinUndoShortcut = () => {
  claimed = false;
};
export const readPinNotice = () => notice;
export const readJustPinned = () => justPinned;
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export const usePinNotice = () => useSyncExternalStore(subscribe, readPinNotice, readPinNotice);
export const useJustPinned = () => useSyncExternalStore(subscribe, readJustPinned, readJustPinned);
