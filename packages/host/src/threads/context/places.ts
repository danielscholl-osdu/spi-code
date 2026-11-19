// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { AreaName, Reading, ViewSnapshot } from "@spi-code/contracts";
import {
  areaEnvelopes,
  governedBy,
  NOT_READ,
  type ReadState,
  readState,
  readStateAt,
} from "./sweep.js";

type Content = NonNullable<Reading["content"]>;

export interface PlaceRead {
  readonly place: string;
  /** A JSON pointer into the saved sweep that spi_evidence can take. */
  readonly at?: string;
  readonly state: ReadState;
  readonly reading: Content | typeof NOT_READ;
}

/** Upstream's tiles and fold that the radar counts; with the radar not read they say so. */
function withoutRadar(content: Content): Content {
  return {
    ...content,
    tiles: content.tiles.map((tile) =>
      tile.label === "Toolchain" || tile.label === "Largest"
        ? { ...tile, value: NOT_READ, counts: NOT_READ }
        : tile,
    ) as Content["tiles"],
    folded: content.folded === null ? null : NOT_READ,
  };
}

interface Place {
  readonly place: string;
  readonly anchor: Reading["anchor"]["kind"];
  readonly state: (view: ViewSnapshot) => ReadState;
  readonly at?: string;
  readonly masks?: Partial<Record<AreaName, (content: Content) => Content>>;
}

const areas =
  (...names: AreaName[]) =>
  (view: ViewSnapshot) =>
    readState(areaEnvelopes(view, names));

/** The places a thread can read or attach, by the id the window gives each. */
export const PLACES: Readonly<Record<string, Place>> = {
  "place:upstream": {
    place: "Upstream",
    anchor: "upstream",
    state: areas("upstream", "radar"),
    masks: { radar: withoutRadar },
  },
  "place:engineering-system": {
    place: "Template",
    anchor: "engineering",
    state: areas("template"),
  },
  "place:security": { place: "Security", anchor: "security", state: areas("security") },
  "place:releases": {
    place: "Releases",
    anchor: "releases",
    at: "/releases",
    state: (view) => governedBy(readStateAt(view, "/releases/lines") ?? readState([]), "releases"),
  },
};

/** Environment and Program pack with the scopes that read them, which threads do not have yet. */
export const UNPACKED_PLACES: readonly string[] = ["place:environment", "place:program"];

export const SERVICE_PLACE = "service:";

function contentOf(view: ViewSnapshot, match: (anchor: Reading["anchor"]) => boolean) {
  return view.readings.find(({ anchor }) => match(anchor))?.content ?? undefined;
}

/** A place's reading from the saved sweep, with what an unread area could not say masked as not read. */
export function readPlace(view: ViewSnapshot, id: string): PlaceRead | undefined {
  if (id.startsWith(SERVICE_PLACE)) {
    const service = id.slice(SERVICE_PLACE.length);
    const index = view.services?.findIndex((entry) => entry.service === service) ?? -1;
    if (index < 0) return undefined;
    const home = view.services?.[index]?.home ? `/services/${index}/home` : undefined;
    const content = contentOf(view, (anchor) => anchor.kind === "service" && anchor.id === service);
    return {
      place: `Service ${service}`,
      at: home ?? `/services/${index}`,
      state: (home && readStateAt(view, home)) || readState([]),
      reading: content ?? NOT_READ,
    };
  }
  const place = Object.hasOwn(PLACES, id) ? PLACES[id] : undefined;
  if (!place) return undefined;
  const state = place.state(view);
  const content = contentOf(view, (anchor) => anchor.kind === place.anchor);
  const masked = Object.entries(place.masks ?? {}).reduce(
    (at, [area, mask]) => (at && state.notRead.includes(area) ? mask(at) : at),
    content,
  );
  return {
    place: place.place,
    ...(place.at === undefined ? {} : { at: place.at }),
    state,
    reading: masked ?? NOT_READ,
  };
}
