# Changelog

All notable changes to this project are documented in this file.

## [0.15.4] - 2026-05-10

### Changed
- **Submodule view toolbar** — "Init All Submodules" button now renders as a refresh icon (`$(refresh)`) instead of a text label, consistent with other icon-only toolbar actions.
- **Activation events** — removed four redundant `onView` entries (`intelliGit.commitView`, `intelliGit.graph`, `intelliGit.worktrees`, `intelliGit.submodules`) from `package.json`. VS Code fires these simultaneously with `intelliGit.branches` when the IntelliGit panel opens, so only one is needed; `intelliGit.commitView` was dead code because the view requires the `intelliGit.commitViewVisible` context which is only set inside `activate()`.

### Fixed (Windows performance)
- **Worktree & submodule watcher debounce** — `onWorktreeChange` and `onSubmoduleChange` callbacks in `stateStore.ts` now route through `requestRefresh(..., { delayMs: 250 })` instead of calling refresh immediately. On Windows, `ReadDirectoryChangesW` emits multiple events per logical file-system change; the missing debounce caused rapid-fire `git` process spawns after any worktree or submodule operation.
- **Parallel operation-state detection** — `GitService.getOperationState()` now runs all five `.git` directory existence checks (`rebase-merge`, `rebase-apply`, `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`) in a single `Promise.all()` instead of sequentially. On the happy path (no active operation) this reduces 5 serial file-system round-trips to 1, cutting 50–250 ms of latency per change-refresh cycle on machines with Windows Defender active.
- **Gutter-marker config caching** — `GutterDecorationController` now caches `gutterMarkers.maxLineCount` and `gutterMarkers.maxFileSizeKb` in constructor-initialised fields and refreshes them only when `onDidChangeConfiguration` fires. Previously `getConfiguration()` was called on every debounced gutter update (every 250 ms while typing).
- **Save-event debounce** — `onDidSaveTextDocument` in `extension.ts` now schedules `requestRefresh(['changes'], { delayMs: 150 })` instead of calling `refreshChanges()` immediately, coalescing rapid saves produced by format-on-save toolchains.

## [Unreleased] - 2026-04-18

### Added
- Bootstrapped a full VS Code extension project in TypeScript with compile/lint setup.
- Added Activity Bar container `IntelliGit` with three sidebar sections:
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
- IntelliGit now activates lazily from its views and commands instead of doing a full Git refresh at VS Code startup.
- Reworked state refreshes to be scoped and coalesced, so save/focus changes update working-tree state without reloading all Git views.
- Reduced Windows Git process pressure with an internal Git command queue and lazy loading for expensive branch, tag, stash, worktree, and submodule details.
- Gutter markers now skip generated folders and large files using configurable size and line-count limits.
- Removed user-visible `IntelliGit:` prefix from command titles for cleaner command palette entries.
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
