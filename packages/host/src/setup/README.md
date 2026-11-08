# Setup sign-in

`setup.signin` starts the tool's own sign-in flow. Copilot and gh share one
`gh auth login --web` child; glab validates its transient token before storing it.
Every `setup.signin.progress` event names the original request in `requestId`.

`setup.signin.cancel` takes `{ requestId }`, naming that original request rather
than the cancellation message's ID. The host aborts only its matching running
gh or Copilot browser flow; glab's token flow is unchanged. Once the child stops,
progress reports `failed` with
`Sign-in was cancelled.` for the original tool and request. Late device codes
and waiting events are suppressed. Unknown, rejected and finished requests are
no-ops, including an old request cancelled while a newer flow runs.
If gh has already exited successfully, completion wins over a cancellation
received before its terminal progress is published.

Cancellation does not log out or delete credentials from the tool's store or
keychain. Reconnecting retires old flows instead: their progress cannot reach the
new window connection.
