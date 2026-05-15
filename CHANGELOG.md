# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added
- **Compare Branches — Message filter (fuzzy)** — new "Message" field in the filter row, before "Author", uses case-insensitive subsequence matching (type "mvw" to match "Move View Wrapper").
- **Compare Branches — Graph mode** — new List / Graph toggle in the filter row. Graph mode renders an inline SVG showing the two branches diverging from their merge base (left lane, right lane, joined at the bottom). Existing filters dim non-matching commits in graph mode so the topology stays visible; clicking a node opens commit details the same as a list row click. The selected mode persists per workspace.

### Changed
- **Branches view — progressive loading** — the Branches view now appears in four phases instead of waiting for everything before showing anything: local branches first, then remote branches, then tag names, then per-remote tag availability annotations (the network-bound `git ls-remote --tags` calls). A failure in any later phase no longer erases data already published by earlier phases.
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
