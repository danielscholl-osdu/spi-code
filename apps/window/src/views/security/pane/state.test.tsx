// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { INITIAL_STATE, securityReducer } from "./state.js";
import { Words, wordsText } from "./Words.js";

const CSRF = "spi:code:CodeQL:java/spring-disabled-csrf-protection";
const GUAVA = "tests:dep:com.google.guava:guava";

describe("securityReducer", () => {
  it("opens a rule in its own lane and By rule, marking the repository it came from", () => {
    const repository = securityReducer(INITIAL_STATE, { type: "repository", name: "workflow" });
    const opened = securityReducer(repository, { type: "rule", key: GUAVA, mark: "workflow" });
    expect(opened).toEqual({
      lane: "tests",
      view: "rule",
      rule: GUAVA,
      repository: null,
      mark: "workflow",
      focus: 2,
    });
  });

  it("closes what was open when another lane is chosen, and keeps it on the same lane", () => {
    const opened = securityReducer(INITIAL_STATE, { type: "rule", key: CSRF, mark: "file" });
    expect(securityReducer(opened, { type: "lane", lane: "spi" })).toBe(opened);
    expect(securityReducer(opened, { type: "lane", lane: "upstream" })).toMatchObject({
      lane: "upstream",
      rule: null,
      mark: null,
    });
  });

  it("keeps the lane and what is open when the view switches", () => {
    const opened = securityReducer(INITIAL_STATE, { type: "rule", key: CSRF });
    expect(securityReducer(opened, { type: "view", view: "repository" })).toMatchObject({
      lane: "spi",
      view: "repository",
      rule: CSRF,
    });
  });

  it("moves no focus when a rule or repository closes", () => {
    const opened = securityReducer(INITIAL_STATE, { type: "rule", key: CSRF });
    expect(securityReducer(opened, { type: "rule", key: null }).focus).toBe(opened.focus);
    expect(securityReducer(opened, { type: "repository", name: null }).focus).toBe(opened.focus);
  });
});

describe("Words", () => {
  const words = [
    { n: 275, atLeast: true },
    " open alerts: ",
    { n: 82, atLeast: false },
    " Dependabot in ",
    { code: "pom.xml" },
  ];

  it("puts ≥ only on a count an unread list could change", () => {
    expect(wordsText(words)).toBe("≥275 open alerts: 82 Dependabot in pom.xml");
    expect(renderToStaticMarkup(<Words words={words} />)).toBe(
      '<span data-at-least="true">≥275</span> open alerts: 82 Dependabot in <code>pom.xml</code>',
    );
  });
});
