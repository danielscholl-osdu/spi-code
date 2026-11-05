// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ToolManifestEntry } from "./install.js";

export const uvManifest: ToolManifestEntry = {
  tool: "uv",
  version: "0.13.7",
  platforms: {
    "darwin-arm64": {
      url: "https://github.com/astral-sh/uv/releases/download/0.13.7/uv-aarch64-apple-darwin.tar.gz",
      sha256: "81b811b57e4624df7ed3aac148e0359100d9962f3d9dce00aec533dc2e086731",
      executable: "uv-aarch64-apple-darwin/uv",
    },
    "darwin-x64": {
      url: "https://github.com/astral-sh/uv/releases/download/0.13.7/uv-x86_64-apple-darwin.tar.gz",
      sha256: "20c47e4c1f630b8abaff8c291fa9b9aa300fef92c4fbff95adf198b55287cda7",
      executable: "uv-x86_64-apple-darwin/uv",
    },
  },
};
