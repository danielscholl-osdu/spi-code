Recorded tool output.

- Real output: `gh-login-device.txt` (gh 2.103.3, isolated config, aborted after the code),
  `gh-status-signed-out.txt`, `glab-status-signed-out.txt` and `glab-status-rejected.txt` (pinned
  glab 1.74.0, isolated config, bogus token).
- `gh-status-ok.txt` is real output with the account name replaced. The no-workflow and
  classic-token variants edit its scopes and token prefix.
- `glab-status-ok.txt` and `glab-pat-self*.json` follow the lines glab prints and GitLab's
  personal access token API; no valid token was available to record them.
