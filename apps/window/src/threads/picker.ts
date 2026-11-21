// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { createStore } from "zustand/vanilla";
import type { AskTarget } from "./store.js";

/** "new" starts a draft in the picked scope, with a chip when given one; "change" moves the open draft there. */
export type Picking = { mode: "new"; target?: AskTarget } | { mode: "change"; current: string };

export const scopePickerStore = createStore<{ picking: Picking | null }>()(() => ({
  picking: null,
}));

export const openScopePicker = (picking: Picking) => scopePickerStore.setState({ picking });
export const closeScopePicker = () => scopePickerStore.setState({ picking: null });
