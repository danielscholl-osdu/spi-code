// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, sep } from "node:path";

/** @typedef {{ name: string, directory: string, environment: string }} VitestProject */
/** @typedef {{ name: string, status?: string, message?: string, assertionResults: { status: string }[] }} JsonFileResult */
/** @typedef {{ testResults: JsonFileResult[] }} JsonReport */
/** @typedef {{ passed: number, failed: number }} Counts */

/** @param {unknown} value */
function record(value) {
  return typeof value === "object" && value !== null
    ? /** @type {Record<string, unknown>} */ (value)
    : undefined;
}

/**
 * The projects a vitest config declares, each with the directory its first include pattern
 * collects from.
 * @param {unknown} projects `test.projects` from vitest.config.ts
 * @returns {VitestProject[]}
 */
export function configuredProjects(projects) {
  assert.ok(Array.isArray(projects) && projects.length > 0, "vitest config must declare projects");
  return projects.map((project) => {
    const test = record(record(project)?.test);
    const name = test?.name;
    const include = test?.include;
    assert.ok(typeof name === "string", "every vitest project must have a name");
    assert.ok(
      Array.isArray(include) && typeof include[0] === "string",
      `vitest project ${name} must include a pattern`,
    );
    const segments = include[0].split("/");
    const glob = segments.findIndex((segment) => /[*?{[]/.test(segment));
    const directory = segments.slice(0, glob === -1 ? -1 : glob).join("/");
    const environment = typeof test?.environment === "string" ? test.environment : "node";
    return { name, directory, environment };
  });
}

/**
 * The package vitest needs installed for an environment, as vitest itself names it.
 * @param {string} environment
 */
export function environmentPackage(environment) {
  if (environment === "node" || environment.startsWith(".") || isAbsolute(environment)) {
    return undefined;
  }
  /** @type {Record<string, string>} */
  const known = { jsdom: "jsdom", "happy-dom": "happy-dom", "edge-runtime": "@edge-runtime/vm" };
  return known[environment] ?? `vitest-environment-${environment}`;
}

/**
 * One line per project whose environment package does not resolve from `root`.
 * @param {VitestProject[]} projects
 * @param {string} root
 */
export function unresolvedEnvironments(projects, root) {
  const require = createRequire(join(root, "package.json"));
  const problems = [];
  for (const project of projects) {
    const name = environmentPackage(project.environment);
    if (name === undefined) continue;
    try {
      require.resolve(`${name}/package.json`);
    } catch {
      try {
        require.resolve(name);
      } catch {
        problems.push(
          `vitest project ${project.name} runs in ${project.environment}, but package ${name} does not resolve from ${join(root, "node_modules")}; run pnpm install`,
        );
      }
    }
  }
  return problems;
}

/**
 * Compares each project's results in a vitest JSON report with the counts expected of it, and
 * names every project that is missing or off.
 * @param {VitestProject[]} projects
 * @param {JsonReport} report
 * @param {string} root the directory vitest ran in, as the report spells its paths
 * @param {Counts} expected per project
 */
export function projectSummary(projects, report, root, expected) {
  /** @type {Map<string, { counts: Counts, files: number, messages: string[] }>} */
  const found = new Map();
  const unexpected = [];
  for (const file of report.testResults) {
    const path = relative(root, file.name).split(sep).join("/");
    const project = projects
      .filter((p) => path.startsWith(`${p.directory}/`))
      .sort((a, b) => b.directory.length - a.directory.length)[0];
    if (project === undefined) {
      unexpected.push(path);
      continue;
    }
    const entry = found.get(project.name) ?? {
      counts: { passed: 0, failed: 0 },
      files: 0,
      messages: [],
    };
    entry.files++;
    for (const test of file.assertionResults) {
      if (test.status === "passed") entry.counts.passed++;
      if (test.status === "failed") entry.counts.failed++;
    }
    if (file.status === "failed" && file.message) entry.messages.push(file.message);
    found.set(project.name, entry);
  }
  const want = `${expected.passed} passed, ${expected.failed} failed`;
  const problems = [];
  const lines = [];
  for (const project of projects) {
    const entry = found.get(project.name);
    if (entry === undefined) {
      problems.push(`vitest project ${project.name} is missing: no results (expected ${want})`);
      lines.push(`  ${project.name}: missing`);
      continue;
    }
    const got = `${entry.counts.passed} passed, ${entry.counts.failed} failed`;
    lines.push(`  ${project.name}: ${got}`);
    if (got !== want) {
      const reason = entry.messages.length > 0 ? `: ${entry.messages.join("; ")}` : "";
      problems.push(`vitest project ${project.name} has ${got} (expected ${want})${reason}`);
    }
  }
  for (const path of unexpected) {
    problems.push(`${path} belongs to no configured vitest project`);
  }
  const text = [
    `vitest projects: expected ${projects.length} (${projects.map((p) => p.name).join(", ")}), found ${found.size}`,
    ...lines,
    ...problems.map((problem) => `  problem: ${problem}`),
  ].join("\n");
  return { problems, text };
}
