// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  type Binding,
  bindingSchema,
  commandText,
  createRegistry,
  type Target,
  targetSchema,
  type Verb,
  verbAction,
  writeBlocked,
} from "../../src/act/verbs.js";

const PR: Target = {
  repo: "Azure/osdu-spi-legal",
  kind: "pr",
  number: 31,
  sha: "aaaaaaa1111",
  state: "open",
  label: "legal #31",
};
const RUN: Target = {
  repo: "Azure/osdu-spi-file",
  kind: "run",
  number: 41000103,
  sha: "bbbbbbb2222",
  state: "failure",
  label: "file run 41000103",
};
const verb: Verb = {
  id: "poke",
  label: "Poke",
  command: (t) => ["api", "-X", "POST", `repos/${t.repo}/poke/${t.number}`],
};
const binding: Binding = {
  verb: verb.id,
  item: "gate1:legal",
  swept: "2026-10-13T15:55:00Z",
  targets: [PR],
};

describe("the button", () => {
  test("carries the binding apart from its payload and confirms with the exact commands", () => {
    const item = verbAction(verb, { ...binding, targets: [PR, RUN] });
    expect(item.binding).toEqual({ ...binding, targets: [PR, RUN] });
    expect(item.payload).toBeUndefined();
    expect(item.label).toBe("Poke 2");
    expect(item.confirm?.body).toContain("gh api -X POST repos/Azure/osdu-spi-legal/poke/31");
    expect(item.confirm?.body).toContain("gh api -X POST repos/Azure/osdu-spi-file/poke/41000103");
    expect(item.confirm?.title).toBe("Poke · 2 targets");
    expect(bindingSchema.parse(item.binding)).toEqual(item.binding);
    expect(item.disabled).toBeUndefined();
  });

  test("a verb that cannot run renders disabled with its reason and no confirmation", () => {
    const item = verbAction(
      verb,
      { ...binding, item: "template-set" },
      { disabled: "2 need review" },
    );
    expect(item).toMatchObject({ disabled: true, reason: "2 need review" });
    expect(item.confirm).toBeUndefined();
  });

  test("keeps single-target defaults and confirmation overrides including typed subjects", () => {
    const single = verbAction(verb, binding);
    expect(single.label).toBe("Poke");
    expect(single.pendingLabel).toBe("Poke…");
    expect(single.confirm?.title).toBe("Poke · legal #31");
    const item = verbAction(verb, binding, {
      primary: true,
      label: "Apply",
      pending: "Applying…",
      title: "Apply this change?",
      detail: ["First sentence.", "Second sentence."],
      subject: { value: PR.repo, label: "Repository" },
    });
    expect(item).toMatchObject({
      tone: "brand",
      label: "Apply",
      pendingLabel: "Applying…",
      confirm: {
        title: "Apply this change?",
        confirmLabel: "Apply",
        irreversible: true,
        subject: PR.repo,
        label: "Repository",
      },
    });
    expect(item.confirm?.body).toBe(
      "First sentence. Second sentence.\n\n" +
        "Calls: gh api -X POST repos/Azure/osdu-spi-legal/poke/31.\n\n" +
        "Each target is read again first; one that changed since the board drew it is skipped and named in the result.",
    );
  });
});

test("strict bindings reject unknown keys and missing, empty or invalid targets", () => {
  expect(bindingSchema.parse(binding)).toEqual(binding);
  for (const invalid of [
    { ...binding, extra: true },
    { verb: "poke", item: "i", swept: "s" },
    { ...binding, targets: [] },
    { ...binding, targets: [{ ...PR, extra: true }] },
    { ...binding, targets: [{ repo: PR.repo, kind: "pr" }] },
    ...["verb", "item", "swept"].map((key) => ({ ...binding, [key]: "" })),
  ]) {
    expect(bindingSchema.safeParse(invalid).success).toBe(false);
  }
});

test("targets validate identities and optional dispatch fields without requiring revalidation data", () => {
  const target = { repo: PR.repo, kind: "workflow", label: "dispatch" };
  expect(targetSchema.parse(target)).toEqual(target);
  expect(
    targetSchema.safeParse({ ...target, workflow: "env-refresh.yml", issue: 1, pr: 2 }).success,
  ).toBe(true);
  for (const invalid of [
    { ...target, repo: "not/a/repository" },
    { ...target, kind: "unknown" },
    { ...target, label: "" },
    { ...target, workflow: "../env-refresh.yml" },
    ...["number", "pr", "issue"].flatMap((key) =>
      [0, -1, 1.5].map((value) => ({ ...target, [key]: value })),
    ),
  ]) {
    expect(targetSchema.safeParse(invalid).success).toBe(false);
  }
});

test("registries isolate verbs, reject duplicates and unregister without disturbing replacements", () => {
  const first = createRegistry();
  const second = createRegistry();
  const remove = first.registerVerb(verb);
  expect(first.verbOf(verb.id)).toBe(verb);
  expect(second.verbOf(verb.id)).toBeUndefined();
  const other = { ...verb, label: "Other" };
  second.registerVerb(other);
  expect(second.verbOf(verb.id)).toBe(other);
  expect(() => first.registerVerb(other)).toThrow("verb poke is already registered");
  remove();
  expect(first.verbOf(verb.id)).toBeUndefined();
  first.registerVerb(other);
  remove();
  expect(first.verbOf(verb.id)).toBe(other);
  expect(second.verbOf(verb.id)).toBe(other);
});

test("command text quotes shell arguments and joins a follow-up only after success", () => {
  const withFollowUp: Verb = {
    ...verb,
    command: () => ["api", "", "two words", "it's", "$(touch nope)"],
    followUp: () => ["workflow", "run", "env-refresh.yml", "-R", PR.repo],
  };
  expect(commandText(verb, PR)).toBe("gh api -X POST repos/Azure/osdu-spi-legal/poke/31");
  expect(commandText(withFollowUp, PR)).toBe(
    "gh api '' 'two words' 'it'\\''s' '$(touch nope)' && gh workflow run env-refresh.yml -R Azure/osdu-spi-legal",
  );
  expect(verbAction(withFollowUp, binding).confirm?.body).toContain(commandText(withFollowUp, PR));
});

test("write eligibility keeps the rib's sweep and scope rules, including fine-grained tokens", () => {
  expect(writeBlocked(undefined, [])).toBe("no sweep has read GitHub yet");
  expect(writeBlocked("", ["repo"])).toBe("no sweep has read GitHub yet");
  for (const scopes of [[], ["workflow"]]) {
    expect(writeBlocked(binding.swept, scopes)).toBe(
      "gh's token lacks the repo scope; run gh auth refresh -s repo",
    );
  }
  expect(writeBlocked(binding.swept, undefined)).toBeUndefined();
  expect(writeBlocked(binding.swept, ["repo"])).toBeUndefined();
});
