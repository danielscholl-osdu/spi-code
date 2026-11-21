// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type SecurityPane,
  SecurityPaneSchema,
  type SecurityWords,
  type SetupState,
  type ViewSnapshot,
  ViewSnapshotSchema,
} from "@spi-code/contracts";
import { assertSmokeImage, VIEW_WIDTHS } from "./smoke-report.js";
import type { TodayCaptureContext } from "./smoke-today.js";

export const SECURITY_SCENARIOS = ["1116", "partial", "clean"] as const;
export type SecurityScenario = (typeof SECURITY_SCENARIOS)[number];

const PANE = ".centre-body .security-pane";
const LANE = (id: string) => `${PANE} .security-fig-row[data-lane="${id}"] .security-fig-name`;
const VIEW = (index: number) => `${PANE} .security-views button:nth-child(${index})`;
const FIRST_RULE = `${PANE} .security-rule .security-rule-title`;
const FIRST_REPOSITORY = `${PANE} .security-repo .security-repo-alerts`;

const text = (words: SecurityWords) =>
  words
    .map((part) =>
      typeof part === "string"
        ? part
        : "code" in part
          ? part.code
          : `${part.atLeast ? "≥" : ""}${part.n}`,
    )
    .join("");

/** The 16 Nov sweep with each generated Security pane in place of its own. */
export function securitySnapshots(
  fixturePath: string,
): Record<SecurityScenario, { snapshot: ViewSnapshot; pane: SecurityPane }> {
  const root = join(dirname(fixturePath), "..", "..");
  const base = ViewSnapshotSchema.parse(
    JSON.parse(readFileSync(join(root, "apps/window/src/views/today/snapshot-1116.json"), "utf8")),
  );
  return Object.fromEntries(
    SECURITY_SCENARIOS.map((name) => {
      const pane = SecurityPaneSchema.parse(
        JSON.parse(
          readFileSync(join(dirname(fixturePath), "generated", "security", `${name}.json`), "utf8"),
        ),
      );
      assert(pane.read, `The ${name} Security pane must have read a list`);
      return [name, { snapshot: ViewSnapshotSchema.parse({ ...base, security: pane }), pane }];
    }),
  ) as Record<SecurityScenario, { snapshot: ViewSnapshot; pane: SecurityPane }>;
}

/**
 * Every text box inside the Security page sits inside the centre pane, and neither the page, the
 * pane nor anything in it scrolls sideways. Returns the offenders, each with its text and widths.
 */
export const SECURITY_OVERFLOW = `(() => {
  const body = document.querySelector(".centre-body");
  const page = body?.querySelector(".security-pane");
  if (!body || !page) return ["no Security page in the centre pane"];
  const box = body.getBoundingClientRect();
  const left = box.left + body.clientLeft;
  const right = left + body.clientWidth;
  const found = [];
  const root = document.scrollingElement;
  if (root.scrollWidth > innerWidth + 1) found.push("window scrolls sideways: " + root.scrollWidth + " > " + innerWidth);
  if (body.scrollWidth > body.clientWidth + 1) found.push("centre pane scrolls sideways: " + body.scrollWidth + " > " + body.clientWidth);
  for (let element = page; element && element !== body; element = element.parentElement)
    if (element.scrollWidth > element.clientWidth + 1)
      found.push("scrolls sideways: " + element.className + " " + element.scrollWidth + " > " + element.clientWidth);
  for (const element of page.querySelectorAll("*")) {
    const style = getComputedStyle(element);
    if (/auto|scroll/.test(style.overflowX) && element.scrollWidth > element.clientWidth + 1)
      found.push("scrolls sideways: " + element.className + " " + element.scrollWidth + " > " + element.clientWidth);
  }
  const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent.trim()) continue;
    const owner = node.parentElement;
    if (owner.closest("[data-hidden], [hidden]") || getComputedStyle(owner).visibility !== "visible") continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (rect.width === 0) continue;
      if (rect.left < left - 0.5 || rect.right > right + 0.5)
        found.push("text outside the pane: " + JSON.stringify(node.textContent.trim().slice(0, 60)) +
          " in ." + owner.className + " spans " + Math.round(rect.left) + ".." + Math.round(rect.right) +
          ", pane " + Math.round(left) + ".." + Math.round(right));
    }
  }
  return found;
})()`;

type Context = Pick<TodayCaptureContext, "window" | "output" | "rendered" | "fixture"> & {
  setupState: SetupState;
};

async function settle(context: Context, condition: string) {
  await context.rendered(condition);
  await context.rendered(condition);
}

async function assertInside(context: Context, where: string) {
  const found: string[] = await context.window.webContents.executeJavaScript(SECURITY_OVERFLOW);
  assert.deepEqual(found, [], `Security at ${where}`);
}

async function click(context: Context, selector: string): Promise<boolean> {
  return context.window.webContents.executeJavaScript(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!target) return false;
    target.click();
    return true;
  })()`);
}

async function capture(context: Context, file: string, alt: string, figures: string[]) {
  const image = await context.window.webContents.capturePage();
  const png = image.toPNG();
  assertSmokeImage(file, { ...image.getSize(), bitmap: image.toBitmap(), bytes: png.length });
  writeFileSync(join(context.output, file), png);
  figures.push(
    `<figure><figcaption>${alt}</figcaption><a href="${file}"><img src="${file}" alt="${alt}"></a></figure>`,
  );
}

/** Every bar, both views, a bar's first rule opened and its first repository opened. */
async function walk(context: Context, pane: SecurityPane, where: string) {
  for (const lane of pane.lanes) {
    const at = `${where} ${lane.id}`;
    assert(await click(context, LANE(lane.id)), `${at}: no bar name`);
    await settle(
      context,
      `document.querySelector(${JSON.stringify(LANE(lane.id))})?.getAttribute("aria-pressed") === "true"`,
    );
    await assertInside(context, `${at} by rule`);
    if (await click(context, FIRST_RULE)) {
      await settle(
        context,
        `document.querySelector("${PANE} .security-rule[data-open] .security-opened")`,
      );
      await assertInside(context, `${at} opened rule`);
    }
    if (await click(context, VIEW(2))) {
      await settle(
        context,
        `document.querySelector(${JSON.stringify(VIEW(2))})?.getAttribute("aria-pressed") === "true"`,
      );
      await assertInside(context, `${at} by repository`);
      if (await click(context, FIRST_REPOSITORY)) {
        await settle(
          context,
          `document.querySelector("${PANE} .security-repo[data-open] .security-repo-open")`,
        );
        await assertInside(context, `${at} opened repository`);
      }
      assert(await click(context, VIEW(1)), `${at}: no By rule`);
    }
  }
}

/** Scrolls the page to its top, or an opened row to the top; says whether the row's first line clears the column heads. */
async function reveal(context: Context, row?: string): Promise<boolean> {
  const clear: boolean = await context.window.webContents.executeJavaScript(`(() => {
    const scroller = [...document.querySelector(".centre-body").children].find((element) =>
      /auto|scroll/.test(getComputedStyle(element).overflowY));
    const row = ${row ? `document.querySelector(${JSON.stringify(row)})` : "null"};
    if (!row) {
      scroller.scrollTop = 0;
      return true;
    }
    row.scrollIntoView({ block: "start" });
    const head = row.parentElement.querySelector(".security-rules-head, .security-repos-head");
    const first = row.firstElementChild.getBoundingClientRect();
    return first.top >= head.getBoundingClientRect().bottom - 0.5;
  })()`);
  await context.rendered("true");
  return clear;
}

async function show(context: Context, snapshot: ViewSnapshot, pane: SecurityPane, cursor: number) {
  const { window, fixture } = context;
  await window.webContents.executeJavaScript('location.hash = "#today"');
  await context.rendered(
    'document.querySelector(".today") && !document.querySelector(".security-pane")',
  );
  fixture("view.snapshot", { ...snapshot, cursor });
  await window.webContents.executeJavaScript('location.hash = "#security"');
  await settle(
    context,
    `document.querySelector("${PANE} .security-totals")?.textContent === ${JSON.stringify(text(pane.page.totals))} &&
      document.querySelector("${PANE} .security-headline")?.textContent.endsWith(${JSON.stringify(text(pane.page.headline))})`,
  );
}

/** Today's Can wait row and Template's repository link each open the Security page. */
async function doorsOpenSecurity(context: Context, snapshot: ViewSnapshot, cursor: number) {
  const { window, fixture } = context;
  fixture("view.snapshot", { ...snapshot, cursor });
  await window.webContents.executeJavaScript('location.hash = "#today"');
  const canWait = '.today tr.today-row--cause .today-row-place[data-place="security"]';
  await context.rendered(`document.querySelector(${JSON.stringify(canWait)})`);
  await window.webContents.executeJavaScript(
    `document.querySelector(${JSON.stringify(canWait)}).click()`,
  );
  await context.rendered(
    `location.hash === "#security" && document.querySelector("${PANE} .security-figure")`,
  );
  await window.webContents.executeJavaScript('location.hash = "#engineering-system"');
  const row = '.repos-row[data-repo="partition"] button';
  await context.rendered(`document.querySelector(${JSON.stringify(row)})`);
  await window.webContents.executeJavaScript(
    `document.querySelector(${JSON.stringify(row)}).click()`,
  );
  await context.rendered('document.querySelector(".repos-security")');
  await window.webContents.executeJavaScript('document.querySelector(".repos-security").click()');
  await context.rendered(
    `location.hash === "#security" && document.querySelector("${PANE} .security-figure")`,
  );
}

/** Opens the first rule core offers Ask on, beside an Also button when one has it, and checks Ask sits at the left. */
async function openAsk(context: Context, pane: SecurityPane) {
  const eligible = pane.lanes.flatMap((lane) =>
    lane.byRule.rules.filter(({ opened }) => opened.ask).map((rule) => ({ lane, rule })),
  );
  const found = eligible.find(({ rule }) => rule.opened.also.length > 0) ?? eligible[0];
  assert(found, "No rule in the 16 Nov pane offers Ask about this");
  const { lane, rule } = found;
  assert(await click(context, LANE(lane.id)), `No ${lane.id} bar at 740`);
  const row = `${PANE} .security-rule[data-security-rule=${JSON.stringify(rule.key)}]`;
  await settle(context, `document.querySelector(${JSON.stringify(`${row} .security-rule-title`)})`);
  assert(await click(context, `${row} .security-rule-title`), `No ${rule.key} row at 740`);
  const ask = `${row}[data-open] .security-opened-acts .ask-about`;
  await settle(context, `document.querySelector(${JSON.stringify(ask)})`);
  await assertInside(context, "1116 740 opened rule with Ask");
  assert(await reveal(context, row), "Opened rule with Ask at 740 starts under the column heads");
  const placed: string = await context.window.webContents.executeJavaScript(`(() => {
    const ask = document.querySelector(${JSON.stringify(ask)});
    const box = ask.getBoundingClientRect();
    const before = ask.previousElementSibling?.getBoundingClientRect();
    const start = ask.parentElement.getBoundingClientRect().left;
    const gap = parseFloat(getComputedStyle(ask.parentElement).columnGap) || 0;
    const after = before && before.top < box.bottom && box.top < before.bottom ? before.right + gap : start;
    return Math.abs(box.left - after) <= 1 ? "" : "Ask starts at " + box.left + ", not " + after;
  })()`);
  assert.equal(placed, "", `${rule.key}: Ask about this is not at the left of its row`);
}

/**
 * The Security page over the 16 Nov, partial and clean panes at each view width in both themes,
 * then an opened rule and an opened repository at 740. Every bar and view is walked for overflow
 * at each width before its capture.
 */
export async function captureSecurity(context: Context, fixturePath: string): Promise<string[]> {
  const { window, output, fixture, setupState } = context;
  const scenes = securitySnapshots(fixturePath);
  const figures: string[] = [];
  const files: string[] = [];
  let cursor = Math.max(...Object.values(scenes).map(({ snapshot }) => snapshot.cursor)) + 1;
  for (const theme of ["light", "dark"] as const) {
    window.setContentSize(1440, 800);
    await window.webContents.executeJavaScript(`{
      localStorage.removeItem("spi-code.panes");
      localStorage.setItem("spi-code.appearance", ${JSON.stringify(theme)});
      location.hash = "#today";
    }`);
    const loaded = once(window.webContents, "did-finish-load");
    window.webContents.reload();
    await loaded;
    await context.rendered('document.querySelector(".shell [data-sidebar-row=settings]")');
    await window.webContents.executeJavaScript(
      `void (Date.now = () => ${Date.parse(scenes["1116"].snapshot.sweptAt)})`,
    );
    fixture("setup.state", setupState);
    if (theme === "light") await doorsOpenSecurity(context, scenes["1116"].snapshot, cursor++);
    for (const width of VIEW_WIDTHS) {
      window.setContentSize(width, 800);
      await context.rendered(
        `Math.abs(innerWidth - ${width}) <= 1 && document.documentElement.dataset.theme === "${theme}"`,
      );
      for (const name of SECURITY_SCENARIOS) {
        const { snapshot, pane } = scenes[name];
        const where = `${name} ${width} ${theme}`;
        if (theme === "light") {
          await show(context, snapshot, pane, cursor++);
          await walk(context, pane, where);
        }
        await show(context, snapshot, pane, cursor++);
        await assertInside(context, where);
        await reveal(context);
        const file = `security-${name}-${width}-${theme}.png`;
        await capture(context, file, `${name}, ${width} px, ${theme}`, figures);
        files.push(file);
      }
    }
    if (theme !== "light") continue;
    const { snapshot, pane } = scenes["1116"];
    await show(context, snapshot, pane, cursor++);
    assert(await click(context, FIRST_RULE), "No rule to open at 740");
    await settle(
      context,
      `document.querySelector("${PANE} .security-rule[data-open] .security-opened")`,
    );
    await assertInside(context, "1116 740 opened rule");
    assert(
      await reveal(context, `${PANE} .security-rule[data-open]`),
      "Opened rule at 740 starts under the column heads",
    );
    await capture(
      context,
      "security-1116-rule-740-light.png",
      "1116, opened rule, 740 px, light",
      figures,
    );
    files.push("security-1116-rule-740-light.png");
    await openAsk(context, pane);
    await capture(
      context,
      "security-1116-ask-740-light.png",
      "1116, opened rule with Ask about this, 740 px, light",
      figures,
    );
    files.push("security-1116-ask-740-light.png");
    await show(context, snapshot, pane, cursor++);
    assert(await click(context, VIEW(2)), "No By repository at 740");
    assert(await click(context, FIRST_REPOSITORY), "No repository to open at 740");
    await settle(
      context,
      `document.querySelector("${PANE} .security-repo[data-open] .security-repo-open")`,
    );
    await assertInside(context, "1116 740 opened repository");
    assert(
      await reveal(context, `${PANE} .security-repo[data-open]`),
      "Opened repository at 740 starts under the column heads",
    );
    await capture(
      context,
      "security-1116-repository-740-light.png",
      "1116, opened repository, 740 px, light",
      figures,
    );
    files.push("security-1116-repository-740-light.png");
  }
  writeFileSync(
    join(output, "security.html"),
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Security</title>
<style>body{font:14px system-ui;margin:24px}figure{margin:24px 0}img{max-width:100%}</style>
<h1>Security</h1><p>The 16 Nov sweep's pane, one list not read (partial) and a clean bar, at 1440, 900 and 740 × 800 in both themes, then an opened rule, one with Ask about this and an opened repository at 740. Compare with design/spi-code-security.html; design/spi-code-security.md wins where they differ.</p>
${figures.join("\n")}`,
  );
  return files;
}
