// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

export {
  type Clock,
  createWindowsGitInstaller,
  type GitPin,
  MacGitInstaller,
  type Runner,
  run,
  WindowsGitInstaller,
} from "./git/installer.js";
export {
  createToolInstaller,
  type Extractor,
  extractBinary,
  type Readiness,
  ToolInstaller,
} from "./installer.js";
export { parseManifest, type ToolPin, type ToolPlatform } from "./manifest.js";
