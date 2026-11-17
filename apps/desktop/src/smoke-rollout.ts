// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import type { BrowserWindow } from "electron";

/** The 16 Nov rollout fields and opened member, on the packaged smoke's schema-valid base. */
export async function captureRollout(
  window: BrowserWindow,
  snapshot: ViewSnapshot,
  output: string,
  designPath: string,
  appearance: "light" | "dark",
  rendered: (condition: string) => Promise<void>,
  fixture: (snapshot: ViewSnapshot) => void,
): Promise<void> {
  const root = join(dirname(designPath), "..");
  const read = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));
  const rollout = read("apps/window/src/views/template/rollout-1116.json");
  const opened = read("apps/window/src/components/opened-body/sweep-1116.json");
  const body = structuredClone(snapshot);
  body.cursor += 1;
  const engineering = body.briefing.places?.find(({ place }) => place === "engineering");
  assert(engineering);
  engineering.visual = rollout.visual;
  body.briefing.since = rollout.since;
  body.briefing.lines = body.briefing.lines?.map((line) =>
    line.id === "waiting:rollout"
      ? opened.lines.find((next: { id: string }) => next.id === line.id)
      : line,
  );
  body.briefing.focus = body.briefing.focus.map((item) =>
    item.id === "rollout" ? { ...item, ...rollout.item } : item,
  );
  body.briefing.rest = body.briefing.rest.map((item) =>
    item.id === "rollout" ? { ...item, ...rollout.item } : item,
  );
  fixture(ViewSnapshotSchema.parse(body));
  try {
    await window.webContents.executeJavaScript('location.hash = "#engineering-system"');
    await rendered('document.querySelector("[data-rung=indexer]")');
    await window.webContents.executeJavaScript(
      'document.querySelector("[data-rung=indexer]").click()',
    );
    await rendered("document.querySelector(\".popover[data-selection='rung~indexer'] time\")");
    const text: string = await window.webContents.executeJavaScript(
      'document.querySelector(".popover").textContent',
    );
    assert(
      text.includes(
        "To 7 forks: indexer, search, workflow, indexer-queue, unit, crs-catalog, crs-conversion.",
      ),
    );
    const file = `rollout-indexer-1440-${appearance}.png`;
    writeFileSync(join(output, file), (await window.webContents.capturePage()).toPNG());
    writeFileSync(
      join(output, `rollout-${appearance}.html`),
      `<!doctype html><meta charset="utf-8"><title>Rollout rung</title><p>Compare with design/spi-code-today-and-places.html#view=engineering&amp;sel=rung~indexer, Z3 and Z7. Epic R1 removes the Dispatch operation until M4.</p><img style="max-width:100%" src="${file}" alt="Indexer rollout popover"><pre>${text.replace(/[&<>]/g, (char) => `&#${char.charCodeAt(0)};`)}</pre>`,
    );
    await window.webContents.executeJavaScript('document.querySelector(".popover-close").click()');
    await rendered('!document.querySelector(".popover")');
  } finally {
    fixture({ ...snapshot, cursor: body.cursor + 1 });
    await window.webContents.executeJavaScript('location.hash = "#today"');
    await rendered('document.querySelector(".today")');
  }
}
