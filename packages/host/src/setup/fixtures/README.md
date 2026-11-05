Recorded tool output.

- Real output: `gh-login-device.txt` (gh 2.103.3, isolated config, aborted after the code),
  `gh-status-signed-out.txt`, `glab-status-signed-out.txt` and `glab-status-rejected.txt` (pinned
  glab 1.74.0, isolated config, bogus token).
- `gh-login-device-color.txt` is real gh 2.103.3 output with `GH_FORCE_TTY=1` and
  `CLICOLOR_FORCE=1` set (isolated config, aborted after the code), with the code replaced by the
  one in `gh-login-device.txt`.
- `gh-status-ok.txt` is real output with the account name replaced. The no-workflow and
  classic-token variants edit its scopes and token prefix.
- `glab-status-ok.txt` and `glab-pat-self*.json` follow the lines glab prints and GitLab's
  personal access token API; no valid token was available to record them.
- `gh-login-device-fallback.txt` is synthesized from gh source `internal/authflow/flow.go:67-70`
  (the line gh prints when the clipboard is disabled or the copy fails).
- `gh-status-inactive-classic.txt` is synthesized: two accounts, a classic token only on the
  inactive one, in the layout of `gh-status-ok.txt`.
