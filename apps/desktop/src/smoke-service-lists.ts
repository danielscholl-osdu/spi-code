// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import {
  type ServiceSecurity,
  ServiceSecuritySchema,
  type ViewSnapshot,
} from "@spi-code/contracts";

export const LISTS_SERVICE = "storage";

const repo = `https://github.com/Azure/osdu-spi-${LISTS_SERVICE}`;
const code = (number: number, severity: "high" | "medium", path: string) => ({
  number,
  severity,
  url: `${repo}/security/code-scanning/${number}`,
  path,
});
const dep = (number: number, path: string, closed?: number) => ({
  number,
  severity: "medium" as const,
  url: `${repo}/security/dependabot/${number}`,
  path,
  ...(closed ? { closedPr: { number: closed, url: `${repo}/pull/${closed}` } } : {}),
});
const provider = "provider/storage-azure/src/main/java/org/opengroup/osdu/storage/provider/azure";

/** The Nov 6 sweep read no alerts, so the Security capture gets one fork with alerts in all three groups. */
const SECURITY: ServiceSecurity = ServiceSecuritySchema.parse({
  count: 4,
  dependabot: { read: true, at: "2026-11-06T14:01:00.000Z" },
  code: { read: true, at: "2026-11-06T14:01:00.000Z" },
  rows: [
    {
      id: "spi:code:CodeQL:java/spring-disabled-csrf-protection",
      source: "code",
      group: "spi",
      severity: "high",
      title: "Disabled Spring CSRF protection",
      alerts: [
        code(3, "high", `${provider}/security/AADSecurityConfig.java`),
        code(2, "high", `${provider}/security/AzureIstioSecurityConfig.java`),
      ],
    },
    {
      id: "spi:code:CodeQL:java/tainted-arithmetic",
      source: "code",
      group: "spi",
      severity: "high",
      title: "User-controlled data in arithmetic expression",
      alerts: [code(5, "high", `${provider}/repository/QueryRepository.java`)],
    },
    {
      id: "upstream:code:CodeQL:java/log-injection",
      source: "code",
      group: "upstream",
      severity: "medium",
      title: "Log Injection",
      alerts: [
        code(
          6,
          "medium",
          "storage-core/src/main/java/org/opengroup/osdu/storage/service/ReplayService.java",
        ),
      ],
    },
    {
      id: "tests:code:CodeQL:java/spring-disabled-csrf-protection",
      source: "code",
      group: "tests",
      severity: "high",
      title: "Disabled Spring CSRF protection",
      alerts: [
        code(
          4,
          "high",
          "storage-core/src/test/java/org/opengroup/osdu/storage/SecurityConfiguration.java",
        ),
      ],
    },
    {
      id: "tests:dep:org.apache.httpcomponents.client5:httpclient5",
      source: "dependabot",
      group: "tests",
      severity: "medium",
      title: "org.apache.httpcomponents.client5:httpclient5",
      fix: "5.6.3",
      detail: "Connection leak on a decode error",
      alerts: [dep(23, "testing/storage-test-core/pom.xml"), dep(19, "testing/pom.xml")],
    },
    {
      id: "tests:dep:org.apache.commons:commons-lang3",
      source: "dependabot",
      group: "tests",
      severity: "medium",
      title: "org.apache.commons:commons-lang3",
      fix: "3.18.0",
      detail: "Uncontrolled recursion on long inputs",
      alerts: [dep(22, "testing/storage-test-core/pom.xml", 54)],
    },
  ],
});

export function withServiceLists(snapshot: ViewSnapshot): ViewSnapshot {
  const services = snapshot.services?.map((entry) =>
    entry.service === LISTS_SERVICE && entry.upstreamSecurity
      ? { ...entry, upstreamSecurity: { ...entry.upstreamSecurity, security: SECURITY } }
      : entry,
  );
  assert(
    services?.some((entry) => entry.upstreamSecurity?.security === SECURITY),
    `The Nov 6 projection must carry ${LISTS_SERVICE}'s lists`,
  );
  return { ...snapshot, services };
}
