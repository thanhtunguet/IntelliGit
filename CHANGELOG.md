# Changelog

All notable changes to this project are documented in this file.

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
