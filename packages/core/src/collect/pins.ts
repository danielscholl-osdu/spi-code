// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

export interface PinRead {
  osCoreCommon?: string;
  coreLibAzure?: string;
}

export function pinsOf(pom: string): PinRead {
  const prop = (name: string) =>
    new RegExp(`<${name.replace(/\./g, "\\.")}>\\s*([^<$\\s]+)\\s*<`).exec(pom)?.[1];
  const artifact =
    /<artifactId>\s*core-lib-azure\s*<\/artifactId>\s*<version>\s*([^<$\s]+)\s*</.exec(pom)?.[1];
  const osCoreCommon = prop("os-core-common.version");
  const coreLibAzure = prop("core-lib-azure.version") ?? artifact;
  return {
    ...(osCoreCommon ? { osCoreCommon } : {}),
    ...(coreLibAzure ? { coreLibAzure } : {}),
  };
}
