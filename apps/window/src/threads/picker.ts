// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { createStore } from "zustand/vanilla";

/** "new" starts a draft in the picked scope; "change" moves the open draft there. */
export type Picking = { mode: "new" } | { mode: "change"; current: string };

export const scopePickerStore = createStore<{ picking: Picking | null }>()(() => ({
  picking: null,
}));

export const openScopePicker = (picking: Picking) => scopePickerStore.setState({ picking });
export const closeScopePicker = () => scopePickerStore.setState({ picking: null });
