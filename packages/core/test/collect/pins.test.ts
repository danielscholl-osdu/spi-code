// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, test } from "vitest";
import { pinsOf } from "../../src/collect/pins.js";

test("pins come from os-core-common.version and core-lib-azure.version, or the artifact's own version", () => {
  expect(
    pinsOf(
      "<properties>\n  <os-core-common.version>7.1.3</os-core-common.version>\n  <core-lib-azure.version>3.0.1</core-lib-azure.version>\n</properties>",
    ),
  ).toEqual({ osCoreCommon: "7.1.3", coreLibAzure: "3.0.1" });
  expect(
    pinsOf(
      "<dependency><groupId>org.opengroup.osdu</groupId><artifactId>core-lib-azure</artifactId>\n<version>3.0.4</version></dependency>",
    ),
  ).toEqual({ coreLibAzure: "3.0.4" });
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Maven property reference, not a JS template.
  expect(pinsOf("<os-core-common.version>${core.version}</os-core-common.version>")).toEqual({});
});
