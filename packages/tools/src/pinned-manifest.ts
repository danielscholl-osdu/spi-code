// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

// Keep in sync with ../manifest.json; manifest.test.ts checks the packaged copy.
export const pinnedManifest = {
  git: {
    version: "2.56.0-windows.4",
    portable: {
      url: "https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.4/PortableGit-2.56.0.4-64-bit.7z.exe",
      sha256: "b1f3e52216e2ed6882d1bebfd4d3fdf319bec40d2edbbf9fd26ec4fd3fce7ed1",
    },
    minimal: {
      url: "https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.4/MinGit-2.56.0.4-64-bit.zip",
      sha256: "e3bf78351fe777fba47ddee5950082f8a98bb0f02604fdc7ba3ee2cb68ffa877",
    },
  },
  tools: [
    {
      tool: "gh",
      version: "2.83.0",
      platforms: {
        "darwin-arm64": {
          url: "https://github.com/cli/cli/releases/download/v2.83.0/gh_2.83.0_macOS_arm64.zip",
          sha256: "fecba907bc361d5e33620dbf1145f11432c39fb2b388a839463cfbb89a84820b",
        },
        "win32-x64": {
          url: "https://github.com/cli/cli/releases/download/v2.83.0/gh_2.83.0_windows_amd64.zip",
          sha256: "41c3b14842ebe7a1509488b8be60c27033096549de989158d06fd9200a929bd3",
        },
      },
    },
    {
      tool: "glab",
      version: "1.74.0",
      platforms: {
        "darwin-arm64": {
          url: "https://gitlab.com/gitlab-org/cli/-/releases/v1.74.0/downloads/glab_1.74.0_darwin_arm64.tar.gz",
          sha256: "cc67a9f79079ed9578cd93ca385e3df13975e2ccb03f047c0c6bf51f708af395",
        },
        "win32-x64": {
          url: "https://gitlab.com/gitlab-org/cli/-/releases/v1.74.0/downloads/glab_1.74.0_windows_amd64.zip",
          sha256: "b9dbddd927af5caa1d0f0b3186abcea1366bdaf9078c9d82dd00133d6827e722",
        },
      },
    },
  ],
};
