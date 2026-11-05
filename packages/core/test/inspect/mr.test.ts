// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { fleetOf } from "../../src/config";
import { createContext } from "../../src/context";
import { mrBoard, mrTitle } from "../../src/inspect/mr";
import { buildModel, type Model } from "../../src/model/index";
import { fixtureContext } from "../briefing-setup";
import settings from "../fixtures/rib-59d6895/render.json";
import { fixtureFacts } from "../harness";

const now = new Date(settings.now);
const model = buildModel(fixtureFacts(), now, {}, fixtureContext);
const oracle: Readonly<Record<string, string>> = {
  "mr:partition:830": "d238bf53262ab7e23b4c22f1453d4852d5475dfcd4f96d13949a5427fe6a1f2c",
  "mr:partition:831": "f1546331cc06905c1d972d9f84d5641a5f272967f1d9fa61e3f3ea9f06888419",
  "mr:partition:821": "59b54ec79df7cd36ea6f741f52005d7c1748ff31d399160b18bfe2bd5119b0c3",
  "mr:partition:822": "65241bec244f488ce095527e88a4fc6961ab1503f85d94af653ca742df16192b",
  "mr:partition:820": "5dbc715de56983346842128dcc633244b30a728a4c6023372453093e3456a8e0",
  "mr:partition:809": "265c626205d38969932b04355132f8813f52827e80505bd77de730818ffff4a4",
  "mr:partition:795": "13839a57cb468dff8086404f5e251d7928d834ce0a11ee55d8f888620a0f0e95",
  "mr:entitlements:960": "969300315d4948e2acb3b0d32e4afef6779cafd638cbca8c8798241a9c1fe7f1",
  "mr:entitlements:953": "345759c97ed0f67d3898d1088fbfc0f28d9fbd81a46bdd86b33da268cdd57502",
  "mr:entitlements:927": "f287513399ca8c642df525b406338d15882b17414082f07eebcdfc5b87960bbb",
  "mr:entitlements:926": "3c441b31b60ec08307815c381c493b0344f2696142ccc3280901e1ffeb8f93ce",
  "mr:entitlements:923": "7b2e4a9fba484112074db8a31bc1d5b28161aa87fc883dc20cf5f5db19aa2842",
  "mr:entitlements:889": "3d80dca9cf374c273fc35798db74d39ba63ff22d8d0e7e4e2082e71902f659ce",
  "mr:legal:785": "1b4f937513fb4760ea891c43c3532ec1639b4bb9b15d21c3e62662fba75dc669",
  "mr:legal:756": "fd6cf1a9114df4a152256682bb552e9ecc7dd428d35c9a44969284f56179c14f",
  "mr:legal:736": "a1d98568b37f13e4cd3c2be7cdb148632816d30a9b432c1329786fd75e9598f2",
  "mr:legal:768": "9a6263da42cb0942f6b5ca19b513a2f03c14f3a93c65d8ec391502c91c32ab8e",
  "mr:legal:715": "e63bcbe5043f5285f9ad0b7792ee48d43237940dcd8e85f3dc58778cbf684542",
  "mr:legal:777": "d979bf66adf28f35be6f561e471dfd4f15a1803c1fba8fd53ebb691674d42673",
  "mr:legal:727": "674ab9b5afce5a954301f5a7b056fbdb16faeea906f225560e5746a7edd428e0",
  "mr:legal:714": "e1a501bff7ace528775b7d43053982cf7830f5bafccb0de20f7cb7b59d870799",
  "mr:schema:867": "8904140d7beb82db9820bc700025db8a0bfea2dc314b1d6437ffe1e8e9bdb88d",
  "mr:schema:868": "8e1b435c1458964bf22b76cfa45597bcdced1daa52c51f9a8d1a8d1892a64d21",
  "mr:schema:866": "7fdae3ee86ec1895835a45dd481955180f8a20b1ce4d1e13696d4c8ce8e138b2",
  "mr:schema:854": "282f13e05f2bc2b34c652dda93859867e43ae788eb4857c4de3b3a45b93c985f",
  "mr:schema:828": "3588407b7f7220a105f175150f3e7014b1b657333ff99516cfc32f2b18129390",
  "mr:file:752": "029dc063dd23e0d92150c96e2966225df68c44186a6eb2ac7b36522926d14e50",
  "mr:file:753": "063436f41a323dd7f5214f3a9ff0d6fe63d8a094ef08c17b5073525412660aeb",
  "mr:file:726": "1b4c85340699701652bb849fe4cbe42b6507b491a82ed00b948e07f9ad2b7470",
  "mr:file:736": "19eaad954ffce06a9a7f5e20a93dae29ff14ffb464ee5942a8ef69e9c043abf6",
};

function fingerprint(model: Model, id: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify({ title: mrTitle(model, id), board: mrBoard(model, id, now, fixtureContext) }),
    )
    .digest("hex");
}

describe("MR inspector parity with keelson-rib-spi@59d6895", () => {
  test.each(Object.entries(oracle))("%s matches the complete rib title and board", (id, hash) => {
    expect(fingerprint(model, id)).toBe(hash);
  });

  test("the oracle covers every MR in the recorded sweep", () => {
    const ids = Object.entries(model.radar.services).flatMap(([fork, service]) =>
      [...new Set(service.possible.flatMap((v) => (v.mr ? [v.mr.iid] : [])))].map(
        (iid) => `mr:${fork}:${iid}`,
      ),
    );
    expect(ids).toEqual(Object.keys(oracle));
  });

  test("a real draft and a closed MR match the rib board", () => {
    const facts = fixtureFacts();
    const partition = facts.radar.data?.services.partition;
    const java = partition?.mrs.find((mr) => mr.iid === 830);
    if (!partition || !java) throw new Error("Fixture must have partition !830");
    partition.mrs.push({ ...java, iid: 900, draft: true, title: "Draft: Java 25 again" });
    expect(fingerprint(buildModel(facts, now, {}, fixtureContext), "mr:partition:900")).toBe(
      "96eb03379d05d08436b2eb2b08c58c3dcadfb084fc7908590f5dd161df4c4aaf",
    );
    expect(fingerprint(model, "mr:legal:1")).toBe(
      "5bde0d5d29798b087788764fef82633180fac952f66958e61c523a65cee507e8",
    );
  });

  test("keeps the rib's bucket order, distinct path counts and cross-fork reach", () => {
    const board = mrBoard(model, "mr:legal:756", now, fixtureContext);
    expect(board.header.status).toEqual({ label: "HALT", tone: "warn" });
    expect(board.sections.flatMap((section) => section.title ?? [])).toEqual([
      "Halt · 5 paths",
      "Toolchain · 1 path",
      "Shared · 53 paths",
      "Filtered · 5 paths",
      "Forks it reaches",
      "Evidence",
    ]);
    expect(
      board.sections.find((s) => s.title === "Forks it reaches")?.items.map((r) => r.text),
    ).toEqual(["legal", "partition, entitlements, schema and file"]);
  });

  test("filter links use the supplied fleet rather than the built-in repository", () => {
    const context = createContext({
      fleet: fleetOf(
        fixtureContext.fleet.services.map((service) =>
          service.id === "legal" ? { ...service, repo: "Example/legal" } : service,
        ),
      ),
    });
    const board = mrBoard(model, "mr:legal:756", now, context);
    expect(board.sections.find((s) => s.title === "Evidence")?.items[1]?.href).toBe(
      "https://github.com/Example/legal/blob/main/.github/upstream-filter.yml",
    );
  });
});
