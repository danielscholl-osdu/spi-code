# Threads: Copilot in SPI Code

The threads design, settled on 2026-11-19. Its mock is `spi-code-threads.html` beside this page. This page wins over the mock, and for threads over the today-and-places page, the service home, the window layout, the window design and the visual design: the thread view and its right panel, how a thread starts, scopes, Lands in, the owner tag, what Copilot is told, and what Copilot may do and where. It replaces the PRD's anchors and thread kinds, the composer on every place, and the rule that Copilot has no shell or file tools. Appendix A lists the PRD rows it changes.

The maintainer chose SPI Code's own engine on 2026-11-19, after two throwaway prototypes (spicode-2b7 embedded T3 Code's server; spicode-74h built the own engine) and four reviews, and answered the design's open decisions the same day (spicode-xia.1). The mock still lists those decisions as open; the rulings below are the answers. The mock's prototype results, sandbox checks and alternatives not chosen are the record of how the design was reached, and rule nothing.

## What a thread is

A thread is a conversation with Copilot that takes the centre, as a place does. The sidebar, top row and palette stay SPI Code's. Threads run in SPI Code's host on the Copilot SDK session the host already starts.

The engine is its own package, `@spi-code/threads`, which imports nothing from SPI Code. The host hands it four things: where a thread works, which tools are offered, the instructions and context, and the channel its events travel on. Another app can supply its own four and use the same engine and view.

T3 Code supplies the behaviour and the look, re-made in SPI Code's kit, and none of the code.

| T3 Code has | In SPI Code | |
|---|---|---|
| Event log, thread statuses, turns, stop, queued messages | The engine's journal and timeline. On restart, work in flight is marked cancelled and Copilot is told on the next turn (RN-06) | re-made |
| Timeline, grouped work log, composer, approval and question rows | The thread view, in SPI Code's tokens. An approval row shows the diff or the command | re-made |
| Worktrees, setup progress, commit, push, create PR | The engine's worktrees and the host's own git, gh and glab, as buttons on the Thread tab | re-made |
| Projects and the add, clone and scratch project flows | Scopes from the fleet. Nothing creates one | replaced |
| Branch toolbar: environment mode and base branch | Lands in | replaced |
| Sidebar and command palette | SPI Code's own, listing the engine's threads; ⌘K gains thread results and ask | replaced |
| Context on a message: files, mentions | The packed place or row; @ completes places | replaced |
| Model and effort picker | Copilot's models only, no provider rail (CP-09) | narrowed |
| Access modes | Supervised and Auto-accept edits | narrowed |
| Plan mode, terminal drawer, diff panel, Open in editor, file and image attachments, @ for files, $ and / | After the threads epic | later |
| Other providers, remote machines, mobile, guest sharing, side chat, preview and device panels, Linear | Not carried | left out |

## Scopes

A thread has one scope, picked from a fixed list SPI Code seeds from the fleet it already reads: the program, the 13 services, the template and the environment. That is 16 scopes. The engine sees each as a project whose folder SPI Code owns under app data. The operator never sees the word project, a folder picker or a clone dialog, and cannot add a repository as a scope.

| Scope | Folder the engine works in | Remotes |
|---|---|---|
| Program | None. It clones nothing and reads through SPI tools | none |
| A service (one of 13) | `repos/<service>`, one clone; a worktree per thread that changes code | origin, the fork on GitHub (`Azure/osdu-spi-partition`); upstream, the project on GitLab (`osdu/platform/system/partition`) |
| Template | `repos/osdu-spi` | origin, `Azure/osdu-spi` |
| Environment | `repos/osdu-spi-stack` | origin, `Azure/osdu-spi-stack` |

- The scope comes from where the thread starts (Starting a thread has the table). ⌘N and the compose icon ask for it in the scope picker; the other ways in name it.
- Before the first message the draft's Ask in control changes the scope, through the same picker, and keeps the typed text. After that it is fixed, because the worktree and history belong to one folder.
- A fork and its upstream share history through the fork's upstream branch, so one clone holds both.
- A scope's repositories are cloned on first use, and the clone is the first row of the timeline. Nothing is cloned for a scope the operator never opens a thread in.
- A program thread reads across everything and changes nothing (ruling T3). It has no folder, so Copilot has no file, write or shell tools in it; its timeline says so on each turn, where another scope's would report its sandbox.

## Lands in

Lands in replaces T3 Code's branch toolbar. Its options are the only destinations a change in that scope can have.

| Lands in | The thread's branch starts from | A push goes to | It opens |
|---|---|---|---|
| Asking | the shared clone, read only; no branch, no worktree | nothing is pushed | nothing |
| Fork · main | `origin/main` | the fork on GitHub, a `spi/` branch | a pull request into main |
| Fork · fork_integration | `origin/fork_integration` | the fork on GitHub, a `spi/` branch | a pull request into fork_integration |
| Upstream | upstream's default branch | GitLab, where the operator can push | a merge request into upstream |

- A service offers all four. Template and Environment offer Asking and their repository's main. Program offers Asking only.
- A thread starts on Asking unless where it starts names a branch. A thread started from an existing pull request or merge request works on that request's own branch and opens no new request.
- An Asking thread moves into a worktree later through the same chip, with its history kept, so the operator need not decide before the question is answered.
- One thread holds a branch at a time (CT-03).
- A request opens as a draft.
- A maintainer of the upstream project pushes a branch to it. Anyone else pushes to their own fork of it on GitLab, which the clone holds as a third remote, and the merge request goes from that fork into upstream. SPI Code reads which applies with glab when the thread first lands in Upstream and names the remote on the Thread tab. It creates no fork: when the operator has neither, the Thread tab says so and links to the upstream project.

## The owner tag

Changes tags each file fork or upstream. When a file's owner does not match where the thread lands, its row says so ("Upstream owns this file. The next sync overwrites a change made here.") and offers to redo that file in a thread that lands in the right place. The button opens a draft in the same scope, landing Upstream or on Fork · main, whose text names the file. The change itself stays in this thread, and the operator redoes it in the new one; carrying the file's diff across is later work (spicode-1rj7). The same rule goes to Copilot in its scope instructions, so it proposes the split itself.

The tag is a warning and blocks nothing: some fork changes touch an upstream-owned file on purpose, in a sync conflict for one. It comes from core's split of SPI code and upstream code, exposed per path. Until core can classify a path, the file carries no tag and no warning, never a guess.

## What Copilot is told

| Layer | What it carries | When | How it travels |
|---|---|---|---|
| Scope instructions | The scope's repositories and remotes, the branch model (upstream, sync, integration, main), which paths the fork owns, where each kind of change lands, and that SPI tools answer program questions faster than re-reading GitHub | Every thread | The session's instructions, resent only when they change |
| What the operator was looking at | The place, opened row or popover the thread started from, packed as PS-14's context chip. Never a raw log, diff or issue body | On the first message, and whenever the operator adds one with @ | A draft chip in the composer that can be removed; snapshotted onto the message when sent |
| SPI tools | Reads over the last sweep: Today, a service's home, Upstream, Template, Environment, Releases, Security, one item by id, and the evidence behind a value | When Copilot asks | Tools the host registers on the session. No server is involved |

The packed chip is what the host's inspect already returns for a row or popover. The SPI tools say when the snapshot was read. For anything deeper, Copilot reads the code in the thread's folder and runs git there, and the work log shows each call. A fresher read of GitHub or GitLab is an SPI tool the host answers (ruling T1).

A message carries up to eight chips. Each is at most 6,000 UTF-8 bytes, about 2,000 tokens on the measured chips. A trimmed chip keeps its identity, what the sweep could say, and the evidence references that fit. It counts any references left out and names the SPI tool for the rest.

SPI tools only read. Program operations that write (dispatch, re-run, merge) are not offered to a thread and arrive with M4 as typed tools that raise a card.

## Starting a thread

A thread starts as a draft in the centre, and nothing is sent until the operator sends it. No place carries a standing composer (ruling T2). Every way in lands in that same draft.

| From | How | Scope | Context chip |
|---|---|---|---|
| Anywhere | ⌘N, or the compose icon beside Find or ask at the head of the sidebar | Picked in the scope picker, which opens over the page with nothing preselected: Environment and Template, then the pinned services, then the others, in sidebar order. Program is not a row | None |
| A service, Template or Environment | The Ask icon at the end of the top bar, after the pin ("Ask Copilot about <scope>") | That scope | None |
| An opened row or a popover | Ask about this, one control at the end of the source pills | The row's fork when it has one; otherwise Program | That row or popover's subject |
| Find or ask | A sentence typed into ⌘K, then ↵ on Ask Copilot | The open service, Template or Environment; otherwise Program | The open row or popover if one is open; the sentence becomes the draft's text |
| A scope's thread list | New thread on a service's Threads tab, or under Template's or Environment's reading | That scope | None |
| A program thread's answer | Continue in, on the scopes the answer names, or Another scope… | The scope chosen | The answer, as a finding; the new thread shows it as lineage |

The draft is one centred block. Its title bar is a muted link back to where it was opened. "Ask in <scope ▾>" is the only place the scope shows, and its control opens the picker. Under the composer sit the Lands in chip and, once a scope is set, up to three of that scope's Today rows that need the operator: one click attaches a row as the chip, and a row a thread already owns opens that thread instead. A draft with a chip and no text sends the chip with a fixed sentence, which the empty composer shows as its placeholder. ⌘N inside a draft moves it to another scope and keeps its text, and Back after a send returns to the page the draft came from.

Ask about this is the only Copilot control on a row or popover, and it sends nothing. It answers what ruling Z7 on Today and places left open: the removed buttons promised an outcome ("Ask Copilot why", "Port !968"), while this one names what it produces, a thread about this row, and the request stays in the operator's words. When a thread already owns the row, the control reads that thread's title and status and opens it (TH-05).

## Threads in the sidebar and on a service

- A thread's status is Waiting on you, Working, Open (its turn ended and it is not settled) or Settled. Settled is stored in the thread's journal, not derived. A sent message un-settles a thread, and one idle for 7 days settles on its own unless the operator un-settled it by hand.
- In the sidebar, threads nest under their service's pinned row. Threads of unpinned services, and of the program, the template and the environment, go under Other threads. Each row ends with its status: a spinner for Working, an alert for Waiting on you, a check for Done (its last turn completed since the operator last opened it), otherwise its age. A thread that opened a request shows the request's pill on its row.
- "Settled N ›" sits at the sidebar's foot, above the gear, and opens the settled list in place, its rows dimmed. A thread settles from its row's hover check, right-click Settle, the Settle button in its title row, or ⌘⇧S, which toggles. A settle by hand offers Undo, and settling the open thread moves to the next unsettled one, or to Today.
- A thread whose journal cannot be read stays listed as a muted "Can't be read" row. It opens nothing, and its tooltip names the thread id.
- A service page gains a Threads tab after Security, with the count of its threads that are Waiting on you or Working. It lists every thread scoped to that service, settled ones under a fold.
- Template and Environment list their threads under their reading.

## The thread view

- The timeline holds messages, a grouped work log whose rows open to a call's arguments and result, clone and setup rows, and approval rows.
- The composer holds any context chips, the model picker (CP-09), the access mode, and send or stop. The Lands in chip sits with it. @ completes places.
- The right panel exists only in a thread (PS-11). Its tabs are Thread, Changes, Reading and Evidence. Thread holds the scope and its remotes, Lands in with its branch and what it opens, the worktree path, lineage, Commit, one Push / Open request button, and the request. Changes lists files against the base with added and removed counts, the owner tag and a unified diff per file. Reading and Evidence are the scope's place and its sweep evidence, one tab away.
- Push / Open request reads "Push / Open draft PR" or "Push / Open draft MR" for a thread that has no request yet: it pushes the commit the tab shows and opens a draft request. A thread on an existing request, or one whose request is already open, pushes to that request's branch and opens nothing; the button then reads Push. The tab shows the commit, the branch and the remote's head as the thread last read it. When the remote moved since, the push is refused and an Update button reads the remote again.
- A push whose range changes a file under `.github/` asks for a value typed beside the button before it is sent: the request's number for a thread on an existing request, or, for a new request, which has no number yet, the target branch's name. The tab says which and why. A push that changes nothing under `.github/` asks for nothing.
- The Request field shows the request's pill once there is one, and reads "Pending until the next sweep reads it" until a sweep row holds the request, then "Owned by this thread". Until then Today, the service page and the Forks sheet draw it as a dashed row marked "pending · not yet in a sweep" outside their sections, so it never counts as a Today member; once the sweep holds it, the sweep's own row carries the thread's marker. The [service home](spi-code-service-home.md) places those rows.
- A program thread's Thread tab says it changes no code; its answer offers the scopes involved, and choosing one starts a child thread there carrying the finding, shown as lineage.

Not built in the threads epic, each to come later as its own work: plan mode, the terminal drawer, the diff panel over the timeline, Open in editor, file and image attachments, @ for files, $ for playbooks and / for thread commands. The mock's "@ a file", "/ a command" and Open in editor show these and are not part of the first build.

## Authority

Copilot has its own shell and file tools in a thread, and every one of them runs inside the Copilot SDK's sandbox, set through the session's `sandboxConfig`. The engine sets the policy; the operator's approval decides whether a call runs at all.

Commands are not offered until they run as a host-run tool (spicode-7ay).

| Inside the sandbox | Policy |
|---|---|
| Files written | The thread's worktree and a temp folder. An Asking thread writes nothing in the clone |
| Files read | The worktree, the clone and the toolchain folders. The home folder, `~/.ssh` and the gh config are unreadable |
| The clone's git folder | Writable when the thread has a worktree, with its hooks and config read only (CT-08) |
| Network | The hosts Settings lists: GitHub, the OSDU GitLab, Maven Central and the OSDU package registry (ruling T4) |
| Environment | An allow-list with no token variables (CT-09); the runtime is started with a cleaned environment, because the sandbox does not filter it |
| Sign-in | None. gh and glab have no sign-in inside the sandbox (ruling T1) |
| Leaving the sandbox | Not offered. A request to leave it is denied |

- The engine supplies the policy on every create and every resume, because a session resumed without it runs unconfined and says nothing.
- Before each turn the host confirms the sandbox is engaged. A thread whose sandbox is not confirmed offers no shell or file tools, and says why.
- An approval is never granted by its kind alone, because a request to leave the sandbox arrives as an ordinary write request with a flag.

| Action | Who does it | Control |
|---|---|---|
| Read files, search code | Copilot, in the worktree or the shared clone | The sandbox's read paths. No prompt |
| Edit a file | Copilot | An approval row with the diff in Supervised; no prompt in Auto-accept edits |
| Run a command (build, test, git) | Copilot, in the sandbox, with no sign-in | Not offered in the threads epic (spicode-7ay). When it returns, an approval row with the command, in every access mode |
| Read GitHub or GitLab | The host, through SPI tools | Typed read tools |
| Commit, push, open a pull request or merge request | The host's own git, gh and glab. Staging and commit run confined under `@microsoft/mxc-sdk` (ruling T9); push and the requests run outside the sandbox under the operator's sign-in (CT-11) | Buttons the operator presses on the Thread tab |
| A program operation (dispatch, re-run, merge) | The host | A typed SPI tool that raises a card, M4, unchanged |

Copilot has no commit, push or request tool. A git command it runs is a command like any other, approved row by row; it can commit in the worktree, and it cannot push or open a request, because it has no sign-in inside the sandbox. The Thread tab's buttons are the only way a change leaves the machine.

A command the host spawns itself, such as its own `git add` and `git commit` (ruling T9) or a fork's build or verify script (CT-16), is not a Copilot tool and the SDK's sandbox does not cover it. Those run under `@microsoft/mxc-sdk` with the same policy. The Copilot runtime's sandbox is that same library, so one policy format serves both. It takes the place of the hand-written Seatbelt profile and Windows restricted token the PRD once named. On Windows it needs Windows 11, and SPI Code accepts MXC's required Windows telemetry.

The sandbox has been observed on macOS only. The Windows checks (spicode-xia.17) ran on Windows Server 2025 in CI: MXC loaded, but the host offered no ProcessContainer, so nothing ran confined, and a Windows 11 client was not observed. A Windows thread therefore asks and reads and offers no shell or file tools, and Commit says confined Git is not available on this platform.

## Rulings

| # | Ruling |
|---|---|
| T1 | gh and glab get no sign-in inside the sandbox. Copilot reads the forges through SPI tools, and the host sends. |
| T2 | The composer on every place is retired. A thread starts as a draft in the centre. |
| T3 | Program threads are Asking only. A change continues in a child thread in a service, the template or the environment. |
| T4 | The hosts a build may reach from the sandbox are GitHub, the OSDU GitLab, Maven Central and the OSDU package registry, listed in Settings. |
| T5 | The access modes are Supervised and Auto-accept edits. A command always asks. T3 Code's Auto and Full access are not offered. |
| T6 | The journal redacts results before writing them. SPI results, errors and chips go through those same rules before Copilot sees them. A horizon card keeps its theme name after the text is checked for credentials. The sandbox is the control for built-in tools. They read a fresh clone and have no sign-in, token variable, credential store or access to Azure hosts. The host masks GitHub and GitLab token prefixes, PEM blocks and known credential values on success. A failed built-in result reaches Copilot as the runtime produced it. |
| T7 | The threads epic (spicode-xia) carries what the PRD split between M3 threads and M5 code threads. M3's Diagnose, Lane watch and campaigns stay in their epic (spicode-cp0) and build on it. |
| T8 | `@microsoft/mxc-sdk` is a direct dependency for commands the host spawns itself, with Windows 11 as the minimum and its required Windows telemetry accepted. |
| T9 | SPI Code's own `git add` and `git commit` run inside an `@microsoft/mxc-sdk` sandbox, so a program a nested repository's config names, such as `core.fsmonitor` or a filter driver, runs confined. `git add` and `git commit` have no switch to ignore a nested repository, so the host confines them instead of refusing commands one at a time. Status, diff and push stay outside the sandbox (CT-11). Decided 2026-11-19 on spicode-xia.13; built by spicode-xia.24. |

## Build order

| Slice | The operator can |
|---|---|
| 1 · Ask in a service | Start a thread from a row, ⌘N or a service, on Asking; stop it; quit and continue |
| 2 · Change code | Pick Lands in, approve edits, see changed files, commit |
| 3 · Send it | Push and open a pull request or a merge request; see the owner tag |
| 4 · Everywhere | Ask across the program, in Template and in Environment; ask from ⌘K; see a service's Threads tab |
| 5 · Windows | Do the same on Windows |

## Appendix A: what this changes elsewhere

| Where | What it says now |
|---|---|
| TH-01 | A thread has one scope of four kinds (Program, a service, Template, Environment). The item it started from is context, not identity. |
| TH-03, PS-05 | No standing composer. Four ways in lead to one draft. A service lists its threads on a Threads tab. |
| TH-04 | No kind. Lands in decides whether there is a worktree, and can change from Asking later. |
| TH-08 | Two access modes are carried: Supervised and Auto-accept edits. Plan mode, the terminal drawer, the diff panel, Open in editor, attachments, @ files, $ and / come later. |
| CP-04, CP-05, NF-01 | The built-in shell and file tools are on, inside the sandbox, behind an approval. URL fetch, memory and subagent tools stay off. |
| EV-05 | Ruling T6. |
| CT-07 | The SDK's `sandboxConfig` for Copilot's tools and `@microsoft/mxc-sdk` for host-run commands, in place of a hand-written Seatbelt profile and Windows restricted token. |
| CT-04 | A push that changes `.github/` needs the request's number typed, or the target branch's name for a new request. |
| CT-10, CT-13, CT-14 | A command is an approval row. Commit is a button the operator presses, and Push / Open request is one button that pushes and opens a draft. A changed file's diff is on the Changes tab. |
| CT-11 | Ruling T9. The host's own `git add` and `git commit` run confined under `@microsoft/mxc-sdk`. Status, diff and push run outside the sandbox. All of them run with hooks off, name the clone's git folder directly, never follow the worktree's `.git` file and check the repository config; status and diff pass `--ignore-submodules=all`. |
| Milestones | A Threads row carries both, in the build order above. |
| Open questions | The `sandboxConfig` question is settled; the Windows question is whether the SDK's sandbox engages there. |
| Today and places, Z7 | Ask about this is the one Copilot control on a row or popover. |
| Service home | Threads nest under their service's pinned sidebar row. The service page gains a Threads tab and an Ask icon after the pin, rows gain Ask about this, and a request a thread opened shows pending until a sweep reads it. |

Unchanged: the host drives Copilot through the SDK (CP-01 to CP-03), one runtime and no MCP server, the home and environment rules (CT-09), one right panel that exists only in a thread (PS-11), threads by status and the Settled shelf (PS-08, TH-07), the thread marker on an owned row (TH-05, PS-15), the model picker (CP-09), and M4's cards for program operations.
