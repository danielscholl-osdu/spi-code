// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, it } from "vitest";
import briefing from "../../../../../fixtures/rib-59d6895/oracle/briefing.json?raw";
import mixed from "../../../../../fixtures/watch/snapshot-mixed-59d6895.json?raw";
import {
  expectEvidenceMarks,
  expectNoEvidenceMarks,
} from "../../components/evidence/marks.test-helper.js";
import { mixedSnapshot, testSnapshot } from "../../store/test-snapshot.js";
import { watchStore } from "../../store/watch.js";
import Horizon from "./index.js";

afterEach(() => watchStore.setState({ snapshot: null }));

it("keeps coarse section evidence on the horizon lens", async () => {
  const body = mixedSnapshot(mixed);
  watchStore.setState({ snapshot: { cursor: 1, body } });
  const dom = document.createElement("div");
  const root = createRoot(dom);
  try {
    await act(async () => root.render(<Horizon />));
    expectEvidenceMarks(dom, body, { sections: [["/briefing/horizon"], ["/briefing/themes"]] });
    await act(async () =>
      watchStore.setState({
        snapshot: { cursor: 2, body: testSnapshot(briefing, '{"lines":[],"reading":false}') },
      }),
    );
    expectNoEvidenceMarks(dom);
  } finally {
    await act(async () => root.unmount());
  }
});
