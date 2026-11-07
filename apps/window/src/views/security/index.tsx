// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { useStore } from "zustand";
import { navigate } from "../../app/navigation.js";
import { treeServices } from "../../app/queue.js";
import { Place } from "../../components/place/Place.js";
import { watchStore } from "../../store/watch.js";

export default function Security() {
  const snapshot = useStore(watchStore, (state) => state.snapshot?.body);
  const reading = snapshot?.readings.find(({ anchor }) => anchor.kind === "security") ?? {
    anchor: { kind: "security" },
    content: null,
  };
  return (
    <Place
      name="Security"
      reading={reading}
      services={treeServices(snapshot?.tree)}
      onNavigate={navigate}
    />
  );
}
