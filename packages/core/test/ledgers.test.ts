// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { Facts } from "../src/facts";
import { buildModel } from "../src/model/index";
import { FIXTURE_NOW, fixtureFacts } from "./harness";
import "./briefing-setup";

const ENT = "osdu/platform/security-and-compliance/entitlements";

function model(edit?: (f: Facts) => void) {
  const f = fixtureFacts();
  edit?.(f);
  return buildModel(f, FIXTURE_NOW);
}

function owed(m: ReturnType<typeof buildModel>) {
  return Object.fromEntries(
    Object.entries(m.radar.services).map(([svc, r]) => [svc, r.ports?.owed.map((o) => o.iid)]),
  );
}

describe("the port ledger", () => {
  test("upstream MRs that changed fork-owned paths since the seed are owed until a fork PR cites them", () => {
    const m = model();
    expect(
      Object.fromEntries(
        Object.entries(m.radar.services).map(([svc, r]) => [
          svc,
          r.ports?.owed.map((o) => [o.iid, o.trees]),
        ]),
      ),
    ).toEqual({
      partition: [],
      entitlements: [
        [963, ["testing/entitlements-v2-test-azure"]],
        [956, ["provider/entitlements-v2-azure"]],
      ],
      legal: [[783, ["provider/legal-azure"]]],
      schema: [],
      file: [],
    });
  });

  test("a ported MR, its URL in a fork PR body, is no longer owed", () => {
    const m = model((f) => {
      const svc = f.radar.data?.services.entitlements;
      if (!svc?.forkPrs) throw new Error("fixture has entitlements fork PRs");
      svc.forkPrs.push({
        number: 99,
        url: "https://github.com/Azure/osdu-spi-entitlements/pull/99",
        state: "merged",
        refs: [`${ENT}!963`],
      });
    });
    const r = m.radar.services.entitlements;
    expect(r?.ports?.owed.map((o) => o.iid)).toEqual([956]);
    expect(r?.ports?.ported).toEqual([
      { iid: 963, pr: "https://github.com/Azure/osdu-spi-entitlements/pull/99" },
    ]);
    expect(m.queue.items.find((i) => i.id === "port:entitlements")?.text).toBe(
      "2 upstream MRs changed provider/entitlements-v2-azure since the seed, 1 of 2 ported",
    );
  });

  test("an upstream MR that only deletes fork-owned code is the removal, not a port", () => {
    const m = model((f) => {
      const ent = f.radar.data?.services.entitlements;
      if (!ent?.merged) throw new Error("fixture has entitlements merged MRs");
      const gone = [
        "provider/entitlements-v2-azure/pom.xml",
        "testing/entitlements-v2-test-azure/pom.xml",
      ];
      ent.merged.push({
        iid: 969,
        title: "chore: remove Azure provider and Azure CI/CD",
        url: "u",
        mergedAt: "2026-10-20T00:00:00Z",
        headSha: "f00",
        paths: [...gone, "README.md"],
        deleted: gone,
      });
      ent.merged.push({
        iid: 970,
        title: "Delete one file, edit another",
        url: "u",
        mergedAt: "2026-10-21T00:00:00Z",
        headSha: "f01",
        paths: [
          "provider/entitlements-v2-azure/src/Old.java",
          "provider/entitlements-v2-azure/src/New.java",
        ],
        deleted: ["provider/entitlements-v2-azure/src/Old.java"],
      });
    });
    expect(owed(m)).toMatchObject({ entitlements: [963, 956, 970] });
    expect(m.radar.services.entitlements?.removal).toBe("fork-only");
  });

  test("an unread fork PR list or merged diff leaves the ledger unmeasured: '?' and no item", () => {
    const m = model((f) => {
      const ent = f.radar.data?.services.entitlements;
      const legal = f.radar.data?.services.legal;
      if (!ent || !legal?.merged?.[0]) throw new Error("fixture services");
      delete ent.forkPrs;
      legal.merged[0] = { ...legal.merged[0], paths: undefined };
    });
    expect(m.radar.services.entitlements?.ports).toBeUndefined();
    expect(m.radar.services.legal?.ports).toBeUndefined();
    expect(owed(m)).toMatchObject({ entitlements: undefined, legal: undefined });
    expect(m.queue.items.some((i) => i.kind === "port")).toBe(false);
  });
});

describe("library skew", () => {
  function libraries(m: ReturnType<typeof buildModel>) {
    return Object.fromEntries(
      Object.entries(m.radar.services).map(([svc, r]) => [svc, r.libraries?.state]),
    );
  }

  test("a fork behind upstream is skewed; one on upstream but behind the latest release is behind", () => {
    const m = model();
    expect(libraries(m)).toEqual({
      partition: "behind",
      entitlements: "skewed",
      legal: "skewed",
      schema: "behind",
      file: "behind",
    });
    expect(m.radar.services.entitlements?.libraries).toMatchObject({
      osCoreCommon: { fork: "7.1.3", upstream: "8.2.0", latest: "9.3.0" },
      coreLibAzure: { fork: "3.0.1", latest: "3.0.4" },
    });
    expect(m.radar.services.legal?.libraries?.osCoreCommon.upstream).toBe("9.2.0");
  });

  test("an unread pom is unread and never counts as matching", () => {
    const states = libraries(
      model((f) => {
        const legal = f.radar.data?.services.legal;
        const file = f.radar.data?.services.file;
        if (!legal || !file?.pins) throw new Error("fixture pins");
        delete legal.pins;
        file.pins = { upstream: file.pins.upstream };
      }),
    );
    expect(states).toMatchObject({ partition: "behind", schema: "behind" });
    expect(states.legal).toBeUndefined();
    expect(states.file).toBe("unread");
  });
});

describe("the Azure removal stage", () => {
  function stages(m: ReturnType<typeof buildModel>) {
    return Object.fromEntries(Object.entries(m.radar.services).map(([svc, r]) => [svc, r.removal]));
  }

  test("each service takes its stage from its removal issue's SPI fork label", () => {
    const m = model();
    expect(stages(m)).toEqual({
      partition: "established",
      entitlements: "established",
      legal: "established",
      schema: "established",
      file: "established",
    });
    expect(m.radar.removalDue).toBe("2026-11-13");
  });

  test("a merged MR that deletes the fork's Azure provider tree makes it fork-only", () => {
    const m = model((f) => {
      const partition = f.radar.data?.services.partition;
      if (!partition?.merged) throw new Error("fixture has partition merged MRs");
      const gone = ["provider/partition-azure/pom.xml", "provider/partition-azure/src/A.java"];
      partition.merged.push({
        iid: 999,
        title: "Remove Azure provider",
        url: "u",
        mergedAt: "2026-10-13T00:00:00Z",
        headSha: "f00",
        paths: gone,
        deleted: gone,
      });
    });
    expect(m.radar.services.partition?.removal).toBe("fork-only");
  });

  test("a service no removal issue names has no stage", () => {
    const m = model((f) => {
      const removal = f.radar.data?.removal;
      if (!removal) throw new Error("fixture has removal labels");
      delete removal.labels["osdu/platform/security-and-compliance/legal"];
    });
    expect(m.radar.services.legal?.removal).toBeUndefined();
  });
});
