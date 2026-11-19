# spicode-xia.6 live thread

On macOS arm64 with Copilot SDK 1.0.26, the host's Asking thread in the
Partition service scope fetched both configured remotes and journaled the
checkout's HEAD at turn start. The probe sent one real Copilot turn through
`thread.send`, received a built-in file tool call and the expected reply over
`thread.subscribe`, and received a completed outcome.

Run `pnpm build` and then `node docs/notes/spicode-xia.6-live.mjs` on macOS
with the existing GitHub CLI keychain entry. The probe holds the credential
in memory, prints only the outcome and evidence flags, and removes its
temporary app data.
