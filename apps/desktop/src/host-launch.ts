// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

export function hostLaunch(
  isPackaged: boolean,
  smoke: boolean,
  live: boolean,
  inherited: NodeJS.ProcessEnv,
) {
  const stub = smoke || (!isPackaged && !live && inherited.SPI_CODE_STUB_MODEL === "1");
  return {
    args: smoke ? ["--stub-model", "--smoke"] : stub ? ["--stub-model"] : [],
    env: Object.fromEntries(
      Object.entries(inherited).filter(([name]) => name.toUpperCase() !== "SPI_CODE_STUB_MODEL"),
    ),
  };
}
