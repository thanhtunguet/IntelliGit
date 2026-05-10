---
name: project-overview
description: Purpose, tech stack, and structure of the vscode-git-client project
type: project
---

# Project: vscode-git-client (IntelliGit Client)

**Purpose:** A VS Code extension providing an IntelliJ-like Git client with branch tree, stashes, graph, worktrees, submodules, merge/diff/compare workflows, and inline gutter markers.

**Publisher:** thanhtunguet  
**Version:** 0.15.4  
**Repo:** https://github.com/thanhtunguet/IntelliGit

## Tech Stack
- TypeScript (strict mode, ES2022 target, CommonJS modules)
- VS Code Extension API (vscode ^1.90.0)
- ESLint with @typescript-eslint
- esbuild for bundling (`npm run bundle`)
- No runtime dependencies

## Source Structure
```
src/
  extension.ts              # Entry point: activate/deactivate
  types.ts                  # Shared types
  logger.ts                 # Logger wrapper
  guards.ts                 # Type guards
  commands/
    commandController.ts    # Registers all VS Code commands
  services/
    gitService.ts           # Git CLI wrapper (cp.spawn), command queue, caching
    gitCommandQueue.ts      # Concurrency limiter (2 on Windows, 4 on macOS/Linux)
    gitParsing.ts           # Output parsers
    repositoryContext.ts    # Workspace/repo detection
    submoduleService.ts     # Submodule commands
    submoduleParsing.ts     # Submodule output parsers
    worktreeParsing.ts      # Worktree list parser
  state/
    stateStore.ts           # Central cached state + auto-refresh via FileSystemWatcher
    refreshScheduler.ts     # Debounce/coalesce refresh requests
    changelistStore.ts      # Selected changes in Commit Details view
    commitTemplates.ts      # Commit message template loader
  providers/
    branchTreeProvider.ts
    stashTreeProvider.ts
    graphTreeProvider.ts
    commitFilesTreeProvider.ts
    commitFileDecorationProvider.ts
    worktreeTreeProvider.ts
    submoduleTreeProvider.ts
  editor/
    editorOrchestrator.ts
    gutterDecorationController.ts   # Gutter markers vs HEAD (config cached in fields)
    gutterGuards.ts
    lineDiff.ts
    virtualGitContentProvider.ts    # intelligit:// URI scheme
  views/
    compareView.ts
    graphFilterView.ts
    branchSearchView.ts
    commitActions.ts
    commitDate.ts
    commitFilterModel.ts
    commitListView.ts
    revisionPicker.ts
    templateRenderer.ts
    branchContextMenu.ts
  test/
    gitParsing.test.ts
    lazyStash.test.ts
    performanceHelpers.test.ts
    refreshScheduler.test.ts
    revisionPicker.test.ts
    workingTreeDiff.test.ts
```

## Views
- `intelliGit.branches` — branch + tag tree (Activity Bar)
- `intelliGit.graph` — git log graph (Activity Bar)
- `intelliGit.commitView` — commit file details, when: `intelliGit.commitViewVisible` (Activity Bar, hidden until activated)
- `intelliGit.worktrees` — worktree list (Activity Bar)
- `intelliGit.submodules` — submodule list (Activity Bar)
- `intelliGit.stashes` — stash list (SCM panel)

## Extension ID prefix: `intelliGit.*`

## Key architectural invariants
- `StateStore` is the single source of truth; providers subscribe via `onDidChange`
- `RefreshScheduler` coalesces overlapping refresh requests within a configurable delay window
- `GitCommandQueue` serialises git process spawns (concurrency 2 on Windows, 4 elsewhere)
- `GutterDecorationController` caches config values (maxLineCount, maxFileSizeKb) at construction; refreshes on `onDidChangeConfiguration`
- All `.git` file watchers use 250 ms debounce; `onDidSaveTextDocument` uses 150 ms debounce
- See memory `project/windows-performance` for full Windows lag investigation notes
