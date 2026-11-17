// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import type { BrowserWindow } from "electron";

/** The repository sweep behind the mock, with storage's counted issue opened in the shared shell. */
export async function captureRepositories(
  window: BrowserWindow,
  snapshot: ViewSnapshot,
  output: string,
  designPath: string,
  appearance: "light" | "dark",
  rendered: (condition: string) => Promise<void>,
  fixture: (snapshot: ViewSnapshot) => void,
): Promise<void> {
  const root = join(dirname(designPath), "..");
  const sweep = JSON.parse(
    readFileSync(join(root, "apps/window/src/views/template/repositories-1116.json"), "utf8"),
  );
  const body = structuredClone(snapshot);
  body.cursor += 1;
  body.briefing.repositories = sweep.repositories;
  const url = "https://github.com/Azure/osdu-spi-storage/issues/67";
  assert(body.briefing.today);
  body.briefing.today.canWait = [
    {
      id: "repositories",
      label: "Repositories",
      place: "engineering",
      notRead: [],
      counts: [
        {
          kind: "issue",
          label: "human-required",
          count: 1,
          tone: "neutral",
          names: ["storage"],
          urls: [url],
        },
      ],
    },
  ];
  fixture(ViewSnapshotSchema.parse(body));
  try {
    await window.webContents.executeJavaScript('location.hash = "#engineering-system"');
    await rendered('document.querySelector(".repos-row[data-repo=storage] button")');
    await window.webContents.executeJavaScript(
      'document.querySelector(".repos-row[data-repo=storage] button").click()',
    );
    await rendered(
      `document.querySelector('[data-line="issue:Azure/osdu-spi-storage:67"] .repos-line-text')`,
    );
    await window.webContents.executeJavaScript(`{
      const button = document.querySelector('[data-line="issue:Azure/osdu-spi-storage:67"] .repos-line-text');
      button.scrollIntoView({ block: "center" });
      button.click();
    }`);
    await rendered(
      "document.querySelector(\".popover[data-selection='rline~storage|issue:Azure/osdu-spi-storage:67']\")",
    );
    const text: string = await window.webContents.executeJavaScript(
      'document.querySelector(".popover").textContent',
    );
    assert(text.includes("Not on Today. Counted under Can wait."));
    assert(!text.includes("Copilot"));
    const file = `repositories-storage-67-1440-${appearance}.png`;
    writeFileSync(join(output, file), (await window.webContents.capturePage()).toPNG());
    writeFileSync(
      join(output, `repositories-${appearance}.html`),
      `<!doctype html><meta charset="utf-8"><title>Repository line</title><p>Compare with design/spi-code-today-and-places.html#view=engineering&amp;sel=rline~storage%7Cissue%3AAzure%2Fosdu-spi-storage%3A67, Z3 and Z7. The fixture's Can wait row counts this issue's URL.</p><img style="max-width:100%" src="${file}" alt="Storage issue 67 popover"><pre>${text.replace(/[&<>]/g, (char) => `&#${char.charCodeAt(0)};`)}</pre>`,
    );
    await window.webContents.executeJavaScript('document.querySelector(".popover-close").click()');
    await rendered('!document.querySelector(".popover")');
  } finally {
    fixture({ ...snapshot, cursor: body.cursor + 1 });
    await window.webContents.executeJavaScript('location.hash = "#today"');
    await rendered('document.querySelector(".today")');
  }
}
