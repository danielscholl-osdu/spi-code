# The service home and Today

The clickable [draft 9 mock](spi-code-service-home.html) shows the home of one fork and Today across all 13. Where the mock and this file differ, this file wins.

The council (Opus 5.5, Codex Sol, Muse Wonder) held seven rounds on the service page. In round 7 they scored draft 7 at 8.5, 8.5 and 8.5, with no structural finding since round 4. On 2026-11-17 the maintainer approved draft 8 without a council score, with three changes after the last round. Healthy Main gained a green tint, the Code tab was cut, and the round-7 fixes were applied. The maintainer aligned on draft 9's Today the same day. The council did not score draft 9.

## The service home

| # | Part | What it shows |
|---|---|---|
| 1 | Top bar | Service name, repo pill, current version to next version with the bump in words (patch, minor, major), typed release PR pill, template icon and pin. The template icon opens Template and shows a check or grey “behind”, named “Template behind” for assistive technology. Unknown draws nothing. |
| 2 | Flow | Upstream, Sync PR and Integration lead into Main. Each station shows its mark and short state or PR. Its second line names what it holds or when it moves. A halted Upstream says “Sync halted” above its known behind count. A recorded sync failure says “Sync failed”. Healthy Main is tinted green and its second line names the last PR merged into main. “Straight into main” has doors for Release, Other PRs, Dependabot and Template when it holds a sync PR. Each open PR belongs to one station or door. One ⌀ marks an incomplete door group, and each door shows what it holds. A station or door that holds an Overview row opens and focuses it. |
| 3 | Tabs | Overview, Upstream, Pull requests, Issues, Runs and Security. Grey counts show changes to port, open PRs, actionable open issues, failing entries and alerts in shipped code. A failed Pull requests or Issues read keeps its held list and says when it was read, when known, with an Evidence link. The chip shows a known retained count and ⌀, including “0 ⌀”. An unknown count is ⌀. |
| 4 | Overview | Blocked, Waiting on you, Shared work and Can wait, oldest first within each section. Blocked and Waiting use Today's headline and age. The typed pill links out and the headline opens the cause in place. Shared work is neutral, carries no count and says “Counted on Upstream”. A Can wait PR gives its gate in the Pull requests tab's words when known. A quiet fork says “Nothing waiting on you” or shows the not-read line with its Evidence link. |
| 5 | Upstream | To port is neutral. Next sync shows what is queued. Open upstream gives the total, the MRs shown and one line accounting for the rest. |
| 6 | Pull requests and Issues | One row per PR or issue. Its typed pill links out and its title opens a summary in place. Open PR labels and issue labels are tags. PR rows show checks and the gate in Overview's words. Amber marks Waiting gates and failures are red. Empty checks say “No checks reported”. All skipped or neutral checks say “n skipped”. PR filters are Open, Merged and All. Issue filters are Open, Closed and All. Closed has no count and shows recent closures newest first by close time. A proven tracking issue rides on its open or merged sync PR, stays out of the issue count and appears under All as “tracks PR #n”. |
| 7 | Runs | “Failing now” leads with current failures and keeps the run that turned Main red reachable even outside the recent history. A cancelled or running retry leaves the failure listed. If the recent page has no decisive run for a carried failure, read that workflow's latest runs. A later pass or a missing workflow clears it. A newer failure takes its place. A failed read keeps the carry and marks history incomplete. “Every workflow” shows failing workflows first, then the others by name, with the remaining automation folded. Its strips run oldest to newest and each square opens its run. The heading says “last 14 days” for complete history or gives the oldest time held when incomplete. |
| 8 | Security | One list groups Shipped SPI code, Shipped upstream code and In tests. Font weight conveys severity. Each row has a typed Dependabot or CodeQL pill. A grouped count opens in place to individual pills with severity. A fix PR closed unmerged sits by its alert as a grey “closed” pill. |
| 9 | Service mark | The pinned sidebar row and search result share one mark. It counts Blocked plus Waiting rows, filled red if any is Blocked and ringed amber otherwise. With no rows it shows a check, or ⌀ if an area was not read. A known count stays visible. |
| 10 | Find | A service result opens Overview and uses the same mark as its pinned row. Under a service, Find lists its open PRs and actionable issues by number or title and its tabs with their counts. Choosing a PR or issue opens its row on its tab. |
| 11 | One clock | Show time alone today, weekday and time within six calendar days, and a date beyond. Ages use one unit. Under a day they read in seconds, minutes or hours. From 24 hours they round to the nearest day (24h to 35h reads 1d, 36h to 59h reads 2d, and 60h to 83h reads 3d). |

Out of scope are the Code tab (clone, editor, terminal), a subtree under a pinned service, Release and Lane stations, a headline above the flow, release history, run strips on Overview, in-app diffs, timelines and comments. The [threads design](spi-code-threads.md) adds a Threads tab after Security, listing the service's threads, and Ask about this on a row; a worktree or a request's branch belongs to a thread's Lands in.

## Today

| Part | Ruling |
|---|---|
| Fleet flow | Upstream counts forks stopped there. Sync PR and Integration count forks with an open PR and count red PRs below. Integration names the forks waiting for cascade on hover. Main leads with red when any fork is red, shows the actual green and running counts, and has no button. Environment shows its state and version and opens its place. Template, Release, Dependabot and Other PRs count what their doors hold. A partial figure shows its known count when it has one. One not-read line names affected forks and links to Evidence. |
| Filter | Upstream, Sync PR, Integration and the Template door toggle their filter. It keeps matching rows and group members in Yours, hides Can wait and dims other columns in Forks. “Show all” clears it. Pressing a filter from Activity opens Yours. A partial filter shows what it holds and keeps the not-read line. Integration also names forks waiting for cascade. Release and Dependabot open their Can wait rows. Other PRs opens the cause with the most forks. A door opens only when it has a target. |
| Yours | Blocked and Waiting on you group by situation in Fork, What, Link and Age. Sentence-case headlines expand the rows and fork names open their service pages. The count is the same member count the sidebar, dock badge and tray use. A deadline stays on its row as a clock. A Waiting template rollout counts one member for each fork proved behind with an open template sync PR, unless that PR is already held by another row. The member also appears in that fork's Overview and mark. The expanded group names proved-behind forks with no open PR separately. A stopped rollout is one Blocked row. |
| Can wait | Release, Dependabot and Other use the service doors by PR, leaving out what Yours already holds. Release and Dependabot name their Blocked and Waiting remainders separately. Release gives each fork's PR age. Dependabot gives counts and shared ecosystem/package pairs regardless of version. Other PRs and actionable issues group by normalized title within each category. High or critical alerts in shipped SPI and upstream code form one row with each fork's count and the rules with the most alerts and most forks. Mixed causes count the read forks and list program repositories under “Outside the forks”. Program-only causes name and count their repositories' work. Release and Security open their places. Fork pills open the service or its tab with the row open. |
| Forks | The tab shows “n stopped” when any fork is stopped. The sheet lists four stations, Template PR number, Release PR age, Other PR count and failure mark, Dependabot count and service mark. Forks with Blocked or Waiting rows come first in fleet order, then unread forks without Yours rows. One fold names the rest and what they hold. The disclosure expands the fork's Yours rows and Can wait facts. The name opens its service page. The disclosure, name and mark stay pinned while the sheet scrolls sideways. An unread fork gets one ⌀ beside or in place of its service mark. A read station keeps its word. An unread station or door shows only what it holds and is otherwise blank. ⌘L opens Forks. |
| Activity | Moving without you and the recent Sync Upstream and Sync Template outcomes. The history heading gives the window the read covers. Times use the shared local clock. |
| Width | Yours and Activity share the 960 px reading cap used by the other places. The Forks tab uses the full width. The fleet flow and caveat follow the active tab's width. |
| Find | Blocked, Waiting on you and Can wait appear in Today's order as “subject · headline”. Choosing one opens that row in Yours. A rollout result opens its group even when only one fork is listed. |
| Sweep | A failed or partial area has one caveat line with its Evidence link. Read again requests a sweep and stays disabled while a request is pending or a sweep is running. |

## Rulings

| # | Ruling |
|---|---|
| D1 | A service is a place with tabs. |
| D2 | A service lists the operator's work on Overview. |
| D3 | Stations and doors on a service page lead to rows in place. On Today they open a filter, a cause or Environment. |
| D4 | Count the fork-wide port row once, on Upstream. List it as Shared work on each service that owes ports. Upstream's sidebar mark is a warning-ring count of its Today rows when it has any, and the next-sync clock otherwise. |
| D5 | The fleet sheet lives on Today's Forks tab. Existing Line links open Forks. Today counts members once and core keeps each member's home. The Line has no sidebar row or Find rows, no dockable sheet, and no cell dots or popovers. A place's head has no stepper and place counts need not add up to Today. There is no On Today chip and no place link on an opened row. |
| D6 | The fleet flow and sidebar share a reading when they show the same fact. |
| S1 | Integration combines cascade state with the integration PR. After a sync merges, Integration says “Cascade waits” and names the merge and next monitor time. The edge shows work in transit. A monitor that passes without starting the cascade raises “Cascade didn't start” in Waiting on you. A failed lane can leave an integration PR red. Lanes belong to Environment. |
| Q1 | Keep the Release door and the release PR pill in the top bar. |
| Q2 | The station and column are Integration. The workflow's GitHub name is Cascade Integration. When the branch is behind, Today says “Integration PR needs its branch updated, then approval”. |
| Q3 | A completed Sync Upstream failure while a sync PR is open raises a Blocked row. A cancelled or running retry leaves it blocked. The next pass clears it. The open halt issue is the primary link when present. Otherwise the run is the primary link. |
| Open upstream | Show open non-draft MRs that moved within 30 days, newest first. Count the rest once as drafts or idle over 30 days. |
| Template | A template sync PR sits at the Template door on both the service page and Today. The sidebar counts template sync PRs waiting for review, the same figure as Today's Template door. |
| Not read | Only a known empty read yields 0 or “None open”. A read failure keeps the facts the surface still holds and shows where the read is incomplete. |

Back and Forward move within the current window launch using ⌘[ and ⌘] on macOS or Alt+Left and Alt+Right on Windows. A held key or a second press while a step is landing advances no further.

## Reading homes and reachability

| Area | Home |
|---|---|
| Service page | PS-02 exempts the route from the Briefing and Releases field walk. The route draws its own Service Home projection. |
| Upstream sync detail | The flow stations hold the fork's sync reading. Upstream holds what is queued. The old Upstream sync Detail fields are exempt. |
| Repository fields | Pull requests, Issues and Security hold the open PRs, issues and alerts. The old service Repository fields are exempt. |
| Reading and Attention | Overview lists the fork's rows and Today keeps the member. Fields exclusive to the old service reading and Attention are exempt. |
| Partial PR listing | Each held PR stays at its station or door. Failed or capped listings leave door counts unread. A known forge total can still serve Pull requests. |
| Runs and halt feed | Runs uses a bounded recent page across workflows. Its failure selection and Sync Upstream use the same failure rule with their own reads. Closed issues have a separate read from open issues and the halt feed. |
| Security | Match a closed Dependabot fix PR to its alert by package and manifest directory. |

## Mock data

The To port rows, the mock's Open upstream selection rule, partition's unread Issues state, storage's template-behind state and the Forks rows marked “example” are examples. Live reads use the Open upstream ruling above.
