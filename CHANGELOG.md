# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added
- **Explorer directory timeline** — folder context menus now include `Open Directory Timeline`, listing every commit that changed any nested child file under the selected directory. Commits stream into the view as `git log` produces them rather than waiting for the full path-filtered history, so the first batch is visible almost immediately on large repositories. The header shows `Loading commits... N loaded so far` during streaming and switches to `Matching commits: N (all loaded)` with the exact total when the stream completes. There is no commit cap — git log runs until the last reachable commit.
- **Commit list virtualization** — Directory Timeline, branch/tag history, and the Filter Graph webview now render only the rows in (and near) the viewport once the filtered list crosses `vscodeGitClient.commitListVirtualizationThreshold` (default `200`, set to `0` to disable). Top and bottom spacer rows keep the scrollbar accurate, so scrolling 10 000-commit histories stays smooth. (Limitation: row selection lives in the DOM, so commits scrolled outside the virtual window lose their selected state.)
- **Branches view remote delete** — remote group context menus now include `Delete this remote`, with confirmation before running `git remote remove`.
- **Git Graph pagination** — Git Graph TreeView and Filter Graph webview now load commits incrementally. In the tree view a "Load More..." item appears at the bottom when additional commits are available; click it to load the next page. In the Filter Graph webview, scroll to the bottom of the commit list to automatically load the next page; the header shows "(scroll to load more)" while more pages remain. `maxGraphCommits` now controls the page size (commits per page) rather than a hard cap — commits accumulate as pages are loaded.
- **Compare Branches — Message filter (fuzzy)** — new "Message" field in the filter row, before "Author", uses case-insensitive subsequence matching (type "mvw" to match "Move View Wrapper").
- **Compare Branches — Graph mode** — new List / Graph toggle in the filter row. Graph mode renders an inline SVG showing the two branches diverging from their merge base (left lane, right lane, joined at the bottom). Existing filters dim non-matching commits in graph mode so the topology stays visible; clicking a node opens commit details the same as a list row click. The selected mode persists per workspace.
- **Compare Branches — Refresh** — the compare webview now has a refresh button that refetches commits for the current left/right refs without reopening the panel and recovers cleanly if the refresh fails.
- **Compare with Revision — QuickPick refresh** — the revision picker now opens from cached refs first, lazily loads refs when empty, and offers a refresh button to update stale or partially loaded branch/tag lists without closing the picker.
- **Search Branches & Tags refresh** — the branch/tag search panel now has a refresh button beside the filter input and a `Refresh` entry in its webview context menu.
- **Sparse repository view auto-collapse** — Worktrees and Submodules now auto-collapse after loading when the repository only has the main/current worktree and no submodules.

### Changed
- **Search Branches & Tags loading count** — the search panel now shows the available branch/tag result count as soon as cached or partially refreshed refs arrive, instead of keeping the count label on `Loading...` until every refs phase completes.
- **Branches view remote actions** — The Remote section now exposes `Add Git remote` as a plus button on the section header, matching the existing Tags create action.
- **Branches/Search actions** — Branches now distinguish local and remote branch context menus so local-only actions (rename/delete/track/untrack) do not appear for remote refs. Search Branches & Tags now uses tag-specific actions for tag rows instead of routing them through branch actions.
- **Compare Branches graph selection parity** — Graph mode now keeps the same row-selection behavior as List mode, including `Shift`/`Ctrl`/`Cmd` multi-select and `Cmd/Ctrl+A` for visible commits in the active pane.
- **Commit file rename diffs** — commit file diff actions now preserve rename source paths, so renamed files compare the old path from the parent against the new path in the selected commit instead of appearing as an add/delete-only diff.
- **Filter Graph clear reliability** — clearing active Filter Graph filters now cancels pending debounced apply requests before posting the clear request, preventing stale typed filters from reappearing after Clear.
- **Filter Graph isolation** — typing in Filter Graph fields now filters only the Filter Graph webview session; the native Git Graph TreeView remains the master commit list and is no longer replaced by Filter Graph results.
- **Filter Graph ref scope** — unfiltered graph loading now includes commits from all local and remote-tracking refs, so Filter Graph can view/filter commits across both local and remote branches instead of only current-branch history.
- **Filter Graph branch-input reliability** — branch filtering now prefers exact branch refs when a full branch name is entered (preventing accidental sibling-branch matches), while still supporting partial branch keywords. Concurrent apply responses are now stale-safe, preventing in-progress typing from being overwritten by late filter responses.
- **Filter Graph logic fixes** — branch-filtered results no longer get incorrectly narrowed again by decorated refs in the webview, fast branch-name typing is protected from stale filter responses, stale scroll-pagination responses no longer append into newer filter sessions, empty states remain visible during pagination, and multi-selected commits now keep supported copy actions enabled in the shared context menu.
- **Commit Details behavior consolidation** — commit clicks from Git Graph, Filter Graph, Compare Branches, and commit-list webviews now share the same toggle behavior: click a commit to show details, click the same commit again to hide the details pane, click a different commit to replace the current details.
- **Commit Details selected-change context actions** — `Open Diffs` now applies to multi-selected rows, `Create Patch from Selected Changes` is now branch-aware (enabled only when the commit is not on current `HEAD` ancestry), and patch creation now offers save-to-file or copy-to-clipboard output before applying to the working tree.
- **Apply Patch command** — added `vscodeGitClient.commit.applyPatch` for Command Palette usage (`Apply Patch to Working Tree`) with clipboard-or-file input, working-tree patchability checks, and IntelliJ-style `Nothing to cherry pick.` messaging when patch content is already present.
- **Branches view — parallel cached loading** — branch and tag refreshes now start together and publish into `StateStore` as soon as each slice is ready. Basic tags appear without waiting for remote-availability checks, then update with remote indicators when those slower checks finish.
- **Selected commit-file changes** — `Cherry-pick Selected Changes` and `Revert Selected Changes` now apply the selected file patch into the current checkout instead of auto-creating a commit, and expanded Git Graph file rows expose the same selected-file actions as Commit Details.
- **Auto-refresh on external git changes** — Branches, Graph, Stashes, Worktrees, Submodules, and the working-tree change list now refresh automatically when git state changes outside the extension (terminal checkouts, stashes, worktree mutations, submodule init/update, rebase/merge/cherry-pick start/abort). Refreshes are scoped to what actually changed (HEAD ref/commit, working tree, index, merge) and remain serialised through the existing refresh scheduler — no broad `.git/**` watcher was reintroduced. Redundant VS Code Git API state events with no diff are now ignored.
- Renamed the extension command/view/configuration prefix from `intelliGit.*` to `vscodeGitClient.*`, including contributed commands, view container IDs, view IDs, context keys, settings, webview IDs, and docs.
- Rebranded user-visible extension surfaces to `VS Code Git Client`.
- Added compatibility fallback for existing `intelliGit.*` user settings and workspace state, and hidden command aliases for already-active extension sessions.
- **Compare Branches — Layout** — the "Exclude message (regex)" field moved to a second row alongside the existing checkboxes and export button, freeing room on the first row for the new "Message" filter.

## [0.15.5] - 2026-05-11

### Changed
- **Branch/Tag commit list open latency** — opening commits from the Branches tree (`Open Branch Commits` / `Open Tag Commits`) now opens the editor tab immediately, shows a loading state, and then hydrates commit data asynchronously (preferring currently cached state data for initial paint before Git fetch completes).
- **Compare with Revision multi-file selection** — when multiple files are selected in Explorer, `Compare with Revision…` now applies to all selected files (not only the first one) and opens a diff for each selected file using the same picked revision.
- **Operation feedback latency** — successful cherry-pick notifications and cherry-pick/merge/rebase conflict warnings are now shown immediately after Git reports the outcome, before the heavier full state refresh completes. This avoids multi-second delayed toasts on Windows while still refreshing extension state and opening conflict files afterward.
- **Remote URL update latency** — changing a remote URL now shows the success notification immediately after `git remote set-url` completes, before branch refresh finishes.
- **Cherry-pick commit notifications** — `vscodeGitClient.graph.cherryPick` now reports explicit outcomes with IDE-style feedback: success, conflict (with resolve + Continue/Abort guidance), failure, and nothing-to-cherry-pick (already applied/empty), including multi-commit summary handling.
- **Cherry-pick conflict workflow** — when cherry-pick hits conflicts (including `unmerged files` states), VS Code Git Client now shows a dedicated conflict warning, auto-opens conflict files in merge editors when possible, falls back to opening SCM for unresolved listing, and surfaces bottom status-bar actions for `Continue` / `Abort` while a cherry-pick is active.
- **Rebase conflict/iteration workflow** — starting or continuing rebase now handles conflict errors explicitly, opens conflict files in merge editors (with SCM fallback), supports step-by-step continuation through multi-commit rebases, and keeps `Abort` available throughout the operation.
- **Operation status bar actions** — bottom status bar controls are now unified for both `rebase` and `cherry-pick`, exposing `Continue` / `Skip` / `Abort` while active and showing rebase step progress on `Continue` when available.
- **Git Graph commit details action** — `Open Commit Details` from the Git Graph tree no longer opens an ad-hoc markdown text document; it now loads the Commit Details sidebar and immediately opens the first changed file diff.
- **Removed custom file-history action** — dropped `vscodeGitClient.fileHistory.open` from command registration and Explorer context menu because VS Code Timeline already covers file/folder history workflows.
- **Git Graph commit-row labeling** — commit rows in Git Graph now keep the title focused on the subject and move a 7-character commit hash into trailing metadata.
- **Go to Parent Commit behavior** — when the parent commit is outside the current graph cache, the action now still opens Commit Details view (instead of a temporary markdown document) and focuses the first changed-file diff.
- **Compare Branches commit context menu layering/placement** — raised menu z-index and improved viewport-aware clamping so commit context menu (including `Go to Parent Commit`) stays visible near bottom edges.
- **Compare Branches continuous multi-select details** — selecting a continuous commit range in the same compare pane now opens one merged Commit Details view showing net file changes across the selected span, and file clicks open range diffs (`oldest^ ↔ newest`) instead of per-commit-only details.
- **Filter Graph multi-select details** — selecting multiple commits in Filter Graph now opens merged Commit Details range output (net file changes across the selected commit span) instead of only single-commit details.
- **Filter Graph filter UX polish** — fixed per-field clear-button alignment to match Compare Branches styling, removed footer `Cancel / Clear Filters / Apply` buttons in Filter Graph, and made field changes apply filters immediately with lightweight debounce.
- **Compare/Filter commit-list parity** — Compare Branches panes and Filter Graph preview now share the same commit-table markup and base row/column styling (graph glyph, sticky author/date columns, hover/selection states) via common Handlebars partials.
- **View refresh action placement** — removed refresh icon buttons from VS Code Git Client view toolbars (Branches/Stashes/Graph/Worktrees/Submodules), added per-view `Refresh` entries to each view title context menu (`...` / right-click), removed the first refresh button from Submodules, and changed `Update All Submodules` toolbar action to an `arrow-down` icon.
- **Edit commit message across commit surfaces** — enabled `Edit Commit Message...` in shared commit context menu used by Git Graph, Compare Branches, and Filter Graph. The action now opens a rewrite flow that updates the selected commit message (via automated interactive rebase) instead of staying disabled.
- **Commit Details selected-files context menu** — added `Create Patch from Selected Changes` to the Commit Details tree so multi-file selections now expose IDE-style patch preview alongside branch-aware `Revert selected changes` / `Cherry-pick selected changes`.

## [0.15.4] - 2026-05-10

### Changed
- **Submodule view toolbar** — "Init All Submodules" button now renders as a refresh icon (`$(refresh)`) instead of a text label, consistent with other icon-only toolbar actions.
- **Activation events** — removed four redundant `onView` entries (`vscodeGitClient.commitView`, `vscodeGitClient.graph`, `vscodeGitClient.worktrees`, `vscodeGitClient.submodules`) from `package.json`. VS Code fires these simultaneously with `vscodeGitClient.branches` when the VS Code Git Client panel opens, so only one is needed; `vscodeGitClient.commitView` was dead code because the view requires the `vscodeGitClient.commitViewVisible` context which is only set inside `activate()`.
- **Commit multi-select across graph surfaces** — Filter Graph, Compare Branches, and shared commit-list webviews now support `Shift`/`Ctrl`/`Cmd` multi-selection; their commit context menu keeps existing options but disables actions that do not support batch execution. Git Graph tree context menu now also disables single-commit-only actions during multi-selection, while batch-capable actions apply to all selected commits.
- **Compare Branches filters** — added an `Exclude message (regex)` field between `Author` and date filters, renamed date labels to English (`From date`, `To date`), and added two advanced toggles under the filter row: `Ignore merge commits` and `Matching messages` (`author + date time + message`) to hide likely cherry-picked duplicates.
- **Compare Branches shortcuts + export** — in the compare webview, `Cmd/Ctrl+A` now selects all visible commits in the active pane, `Esc` clears selection, and the export button now follows `vscodeGitClient.compare.exportFormat`: `Export CSV` by default (writes two branch-specific CSV files) or `Export Excel` (writes one `.xlsx` with two sheets named after the compared branches).

### Fixed (Windows performance)
- **Watcher strategy simplification** — removed `.git/*`, worktree/submodule, and window-focus auto-refresh watchers from `stateStore.ts`; VS Code Git Client now relies on VS Code Git repository-state events and save-triggered updates to avoid watcher-driven refresh storms.
- **Parallel operation-state detection** — `GitService.getOperationState()` now runs all five `.git` directory existence checks (`rebase-merge`, `rebase-apply`, `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`) in a single `Promise.all()` instead of sequentially. On the happy path (no active operation) this reduces 5 serial file-system round-trips to 1, cutting 50–250 ms of latency per change-refresh cycle on machines with Windows Defender active.
- **Gutter-marker config caching** — `GutterDecorationController` now caches `gutterMarkers.maxLineCount` and `gutterMarkers.maxFileSizeKb` in constructor-initialised fields and refreshes them only when `onDidChangeConfiguration` fires. Previously `getConfiguration()` was called on every debounced gutter update (every 250 ms while typing).
- **Save-event debounce** — `onDidSaveTextDocument` in `extension.ts` now schedules `requestRefresh(['changes'], { delayMs: 150 })` instead of calling `refreshChanges()` immediately, coalescing rapid saves produced by format-on-save toolchains.
- **Configurable refresh debouncing** — debounce delays are now configurable through `vscodeGitClient.performance.refreshDebounceMs` and `vscodeGitClient.performance.saveRefreshDebounceMs`, so auto-refresh pressure can be tuned without code changes.
- **SCM state feedback-loop prevention** — `GitService.getChangedFilesFromVsCodeGit()` no longer invokes `repository.status()` on every VS Code Git Client refresh cycle; this avoids re-triggering VS Code Git state-change events and prevents continuous reload churn in the default Source Control view.
- **VS Code Git Client view churn reduction** — `StateStore.executeRefresh()` now emits tree-refresh events only when the refreshed slices actually changed, preventing continuous redraws in the VS Code Git Client container when watcher/repository-state events fire without data changes.

## [Unreleased] - 2026-04-18

### Added
- Bootstrapped a full VS Code extension project in TypeScript with compile/lint setup.
- Added Activity Bar container `VS Code Git Client` with three sidebar sections:
  - Branches
  - Stashes
  - Git Graph
- Added core architecture modules:
  - `gitService` (native Git CLI wrapper, logging, timeout handling)
  - `stateStore` (cached branch/stash/graph/compare state + auto-refresh)
  - Tree providers for branches, stashes, and graph
  - Command controller with centralized command registration and error handling
  - Editor orchestrator for merge/diff/compare workflows
- Added branch management features:
  - checkout, create, rename, delete
  - track/untrack upstream
  - merge into current, rebase current onto target
  - reset current branch to commit (soft/mixed/hard with confirmation)
  - compare with current branch
  - branch search/filter
- Added stash workflows:
  - list stashes with metadata
  - create stash (include untracked / keep index)
  - apply, pop, drop, rename, patch preview
- Added Git graph workflows:
  - commit list with metadata and ref display
  - commit context menu actions for copying commit ID and commit message
  - commit details view
  - checkout commit, create branch at commit
  - cherry-pick commit, cherry-pick range, revert commit
  - interactive rebase from selected commit
  - graph filtering by branch/author/message/date
- Added main-pane workflows:
  - 3-way merge orchestration via built-in VS Code merge editor
  - side-by-side diff flows (HEAD/INDEX/WORKTREE and ref-to-ref)
  - branch comparison webview with commit/file summaries and diff drill-down
- Added cross-cutting Git actions:
  - quick actions palette
  - push/pull with incoming/outgoing preview
  - fetch --prune
  - partial staging (`git add -p`), stage file, unstage file
  - amend commit
  - file history and blame commands
  - compare with revision from Explorer context menu (file/folder), including grouped revision picker and SHA-prefix lookup
- Added guardrails:
  - destructive operation confirmations for risky Git commands
  - deterministic state refresh after mutating operations
- Added persistent recent branch-compare pairs in workspace state.
- Added initial test scaffold (`src/test/gitParsing.test.ts`).

### Changed
- VS Code Git Client now activates lazily from its views and commands instead of doing a full Git refresh at VS Code startup.
- Reworked state refreshes to be scoped and coalesced, so save/focus changes update working-tree state without reloading all Git views.
- Reduced Windows Git process pressure with an internal Git command queue and lazy loading for expensive branch, tag, stash, worktree, and submodule details.
- Gutter markers now skip generated folders and large files using configurable size and line-count limits.
- Removed user-visible `VS Code Git Client:` prefix from command titles for cleaner command palette entries.
- Enhanced Git Graph UX:
  - each commit node is now expandable (caret toggler)
  - expanding a commit shows changed files
  - selecting a changed file opens side-by-side diff in the main pane (commit vs parent)
- Added commit form through VS Code SCM integration:
  - shows `Staged Changes` and `Changes`
  - supports commit message input
  - changed files in commit form open side-by-side diff in main pane
  - resource-level stage/unstage actions
- Added commit shortcut support aligned with default SCM behavior:
  - `Ctrl+Enter` (Windows/Linux)
  - `Cmd+Enter` (macOS)

### Fixed
- Fixed Windows submodule command path handling by resolving submodule working directories with platform-aware path utilities.
- Fixed Git `--format` argument handling to prevent errors like:
  - `fatal: ambiguous argument '%m?...'`
- Updated all relevant Git commands to use safe format argument forms.
- Replaced brittle output separators with safer delimiters for parsing stability.
- Improved ahead/behind parsing from upstream tracking output.
- Fixed staged/unstaged status parsing from `git status --porcelain`.
- Fixed stash listing behavior when no stash exists (now returns empty list safely).
- Fixed and stabilized lint configuration for ESLint v9+ flat config (`eslint.config.cjs`).

### Project/Tooling
- Added:
  - `package.json` extension contributions (views, commands, menus, keybindings)
  - `tsconfig.json`
  - `eslint.config.cjs`
  - `.vscodeignore`
  - extension icon and media assets
  - full source tree under `src/`
- Added/updated docs in `README.md` to reflect implemented capabilities and scope.
