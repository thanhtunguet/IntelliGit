# IntelliGit Client (VS Code Extension)

IntelliGit is an IntelliJ-like Git client extension for VS Code focused on core parity. It adds a dedicated Activity Bar container with branch/graph/commit views, a Stashes panel in the SCM sidebar, a Repo Structure panel for worktrees and submodules, inline gutter change markers, commit message templates, and full merge/diff/compare workflows.

**Panel layout:**
- **IntelliGit** (Activity Bar): `Branches`, `Commit Details`, `Git Graph`
- **Source Control** (SCM panel): `Stashes`
- **Repo Structure** (bottom panel): `Worktrees`, `Submodules`
- **Editor**: Gutter change markers, side-by-side diff, 3-way merge editor, branch comparison

## Inspiration & Motivation

This extension was inspired by the Git client experience in IntelliJ IDEA and other IntelliJ-based IDEs.

While working with those tools, I found their Git workflows to be incredibly smooth and powerful — especially when it comes to:

* Comparing branches and revisions
* Cherry-picking changes across branches
* Navigating repository history in a flexible way

After switching to Visual Studio Code, I realized that while the built-in Git integration is great for everyday tasks, some of these advanced workflows were either missing or required combining multiple extensions and external tools.

That gap became the main motivation for this project.


### Goals

The goal of this extension is not to replace VSCode’s built-in Git, but to complement it by:

* Bringing more advanced Git workflows into a single place
* Reducing the need for multiple extensions or external tools
* Keeping everything aligned with the VSCode ecosystem and APIs
* Providing a smooth and intuitive developer experience


### Feedback & Contributions

This project is open-source and still evolving.

If you:

* Find bugs
* Have feature ideas
* Want to improve existing workflows

Please feel free to open an issue on GitHub:
👉 https://github.com/thanhtunguet/IntelliGit/issues

Contributions and PRs are always welcome!

## Implemented Features

### Branches (Tree View)

Hierarchical branch tree grouped by prefix (`feature/*`, `release/*`, etc.) plus a Recent group.

- Local + remote branches
- Current branch marker with upstream tracking, ahead/behind counts
- Branch actions (right-click or Branch Action Hub):
  - Checkout
  - Create
  - Rename
  - Delete
  - Track / untrack upstream
  - Merge into current
  - Rebase current onto selected branch
  - Reset current branch to selected commit (`soft|mixed|hard`) with confirmation
  - Compare with current branch
  - Open branch commits in Git Graph
- Branch search/filter command (toolbar)
- **Branch Action Hub** — quick-access picker accessible from the SCM title bar and the built-in `git.branch` menu

#### Tags

Tags appear in the Branches tree alongside branches. Tag actions:
- Checkout (detached)
- Checkout New Branch from tag
- Copy Revision Number
- View Repository At Revision
- Compare With Current
- Create Patch
- Open Tag Commits in Git Graph

### Stashes (Tree View — SCM panel)

Stash list with message, author, timestamp, file count. Stash actions:
- Create stash (include untracked, keep index)
- Apply
- Pop
- Drop (guarded)
- Rename message
- Patch preview (diff document)
- Unshelve (apply without removing from stash list)
- Shelve a specific SCM resource directly from the Source Control file list

### Git Graph (Tree View)

Commit list with graph-like glyph, refs, author, date, and message. Each commit is expandable to show its changed files.

**Commit actions:**
- Open Commit Details (loads the Commit Details sidebar view)
- Checkout commit (detached, guarded)
- Create branch at commit
- Create tag at commit
- Cherry-pick commit
- Revert commit
- Cherry-pick range
- Compare commit with current branch
- Interactive rebase from selected commit
- Go to parent commit
- Create patch from commit
- Open file at revision
- Show repository at revision

**Graph filters (toolbar):**
- branch/ref
- author
- message text
- since / until dates

### Commit Details (Tree View — sidebar)

A dedicated sidebar view that appears when a commit is selected from Git Graph. Shows the full list of changed files for that commit.

- Open file diff (commit vs parent) inline in the editor
- Revert selected file changes back to the commit's parent
- Cherry-pick selected file changes onto the current working tree

### Compare with Revision (Explorer context menu)

Right-click any file or folder in the Explorer and choose **Compare with Revision…**.

- Picker groups refs as **Local branches**, **Remote branches**, and **Tags**
- Type a commit SHA prefix (4–40 lowercase hex chars) to resolve and select a specific commit
- File target: opens diff with **left = selected revision**, **right = working tree**
- Folder target: populates **Commit Details** with changed files and opens the first file in preview diff mode

### Worktrees (Tree View — Repo Structure panel)

Worktrees are grouped into: **Current**, **Other Worktrees**, **Locked**, **Prunable / Stale**.

- Open worktree in this window or a new window
- Reveal in Finder / Explorer
- Open Terminal in worktree directory
- Add worktree from an existing branch
- Add worktree with a new branch
- Add detached worktree
- Lock / Unlock
- Remove / Force Remove (with confirmation)
- Preview prunable worktrees
- Prune stale worktrees

### Submodules (Tree View — Repo Structure panel)

Submodules are grouped into: **Needs Attention**, **Clean**, **Uninitialized**, **Nested**.

- Init submodule / Init all submodules
- Update submodule / Update all / Update recursive
- Sync submodule URL / Sync all
- Open submodule in this window or a new window
- Checkout recorded commit (when pointer is out of sync)
- Pull tracked branch
- Show pointer diff
- Stage pointer change
- Deinit submodule

### Gutter Change Markers

Inline gutter decorations show lines added, modified, or deleted relative to HEAD, updated as you type (debounced). Controlled by the `intelliGit.gutterMarkers.enabled` setting.

To keep editing responsive on Windows and large repositories, gutter markers automatically skip generated folders and files above the configured line-count or file-size limits.

### SCM Integration

IntelliGit integrates with VS Code's native Source Control panel:

- **Commit message templates** — pick a template from a configurable list; placeholders: `{branch}`, `{ticket}`, `{scope}`, `{cursor}`. Templates are defined in `intelliGit.commitMessageTemplates`.
- **AI-generated commit messages** — generates a commit message from staged diff; timeout is configurable via `intelliGit.aiGenerateTimeoutMs`.
- **Amend from SCM input** — amend the last commit with the text currently in the SCM input box.
- **Shelve resource** — right-click any unstaged file in Source Control to create a stash from that single file.
- Commit shortcut: `Ctrl+Enter` / `Cmd+Enter`

### Main Editor Workflows

**3-way merge:**
- Open conflicted file in VS Code's built-in merge editor
- Next/previous conflict navigation commands
- Finalize guard: blocks completion if unresolved conflicts remain

**Side-by-side diff entry points:**
- Working tree vs HEAD
- Index vs HEAD
- Commit vs parent
- Any two refs for a file

**Branch comparison tab:**
- Dedicated webview for `A..B` / `B..A` commit and changed-file summaries
- Drill down into file-level diff
- Recent compare pairs persisted in workspace state

### Cross-cutting Features

- Quick Git Actions command palette entry
- Push/pull previews (incoming/outgoing commit summaries)
- Fetch `--prune`
- Partial staging (`git add -p`)
- Stage file / unstage file
- Amend last commit
- File history and blame from active editor file (also available in Explorer right-click)
- Guardrails for destructive operations with modal confirmation
- Output channel logging of executed Git commands
- Deterministic state refresh after mutating operations

## Architecture

| Module                                                     | Purpose                                                                                      |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `src/services/gitService.ts`                               | Native `git` CLI wrapper with typed methods, error normalisation, command logging            |
| `src/services/gitParsing.ts`                               | Output parsers for branches, stashes, log, status, blame                                     |
| `src/services/repositoryContext.ts`                        | Resolves the active Git repository root                                                      |
| `src/services/submoduleService.ts` / `submoduleParsing.ts` | Submodule discovery and command wrappers                                                     |
| `src/services/worktreeParsing.ts`                          | Worktree list parser                                                                         |
| `src/state/stateStore.ts`                                  | Central cached state for branches/stashes/graph/compare; auto-refresh on `.git` file changes |
| `src/state/changelistStore.ts`                             | Tracks selected changes in the Commit Details view                                           |
| `src/state/commitTemplates.ts`                             | Loads and resolves commit message templates                                                  |
| `src/providers/branchTreeProvider.ts`                      | Branch (and tag) sidebar tree provider                                                       |
| `src/providers/stashTreeProvider.ts`                       | Stash sidebar tree provider                                                                  |
| `src/providers/graphTreeProvider.ts`                       | Git Graph sidebar tree provider                                                              |
| `src/providers/commitFilesTreeProvider.ts`                 | Commit Details sidebar tree provider                                                         |
| `src/providers/commitFileDecorationProvider.ts`            | File decoration badges in Commit Details view                                                |
| `src/providers/worktreeTreeProvider.ts`                    | Worktrees sidebar tree provider                                                              |
| `src/providers/submoduleTreeProvider.ts`                   | Submodules sidebar tree provider                                                             |
| `src/commands/commandController.ts`                        | Command registration, action orchestration, guardrails                                       |
| `src/editor/editorOrchestrator.ts`                         | Merge / diff / compare tab orchestration                                                     |
| `src/editor/gutterDecorationController.ts`                 | Inline gutter change markers vs HEAD                                                         |
| `src/editor/lineDiff.ts`                                   | Line-level diff computation for gutter markers                                               |
| `src/editor/virtualGitContentProvider.ts`                  | Virtual document provider (`intelligit://`) for showing file content at a revision           |
| `src/views/compareView.ts`                                 | Branch comparison webview UI                                                                 |
| `src/views/graphFilterView.ts`                             | Graph filter webview/input                                                                   |
| `src/views/branchSearchView.ts`                            | Branch search webview/input                                                                  |
| `src/views/commitActions.ts`                               | Shared context-menu actions for commits                                                      |
| `src/views/templateRenderer.ts`                            | Handlebars-based template rendering for webviews                                             |

## Available Commands

Key command IDs (not exhaustive):

- `intelliGit.quickActions` — Quick Git Actions palette
- `intelliGit.refresh` — Refresh all views
- `intelliGit.branch.*` — Checkout, create, rename, delete, track, merge, rebase, reset, compare, search, actionHub, openCommits
- `intelliGit.tag.*` — Checkout, checkoutNewBranch, copyRevisionNumber, showRepositoryAtRevision, compareWithCurrent, createPatch, openCommits
- `intelliGit.stash.*` — Create, apply, pop, drop, rename, previewPatch, unshelve
- `intelliGit.graph.*` — openDetails, openFileDiff, checkoutCommit, createBranchHere, createTagHere, cherryPick, cherryPickRange, revert, rebaseInteractiveFromHere, compareWithCurrent, createPatch, showRepositoryAtRevision, openRepositoryFileAtRevision, goToParentCommit, filter, clearFilter
- `intelliGit.commit.*` — revertSelectedChanges, cherryPickSelectedChanges, amend
- `intelliGit.diff.open` — Open diff for a file
- `intelliGit.compare.open` — Open branch comparison
- `intelliGit.merge.*` — openConflict, next, previous, finalize
- `intelliGit.conflict.*` — acceptOurs, acceptTheirs, acceptBoth
- `intelliGit.operation.*` — abort, continue, skip (merge/rebase/cherry-pick)
- `intelliGit.git.*` — pushWithPreview, pullWithPreview, fetchPrune
- `intelliGit.stage.*` — patch (hunk staging), file
- `intelliGit.unstage.file`
- `intelliGit.scm.*` — shelveResource, commitTemplate, generateCommitMessage, amendFromInput
- `intelliGit.worktree.*` — open, openInNewWindow, addFromBranch, addNewBranch, addDetached, remove, removeForce, lock, unlock, prunePreview, prune, revealInFinder, openTerminal
- `intelliGit.submodule.*` — init, initAll, update, updateAll, updateRecursive, sync, syncAll, open, openInNewWindow, checkoutRecorded, pullTrackedBranch, diffPointer, stagePointerChange, deinit
- `intelliGit.fileHistory.open`
- `intelliGit.compareWithRevision` (Explorer context menu)
- `intelliGit.fileBlame.open`

## Run Locally

1. Install deps:

```bash
npm install
```

2. Compile:

```bash
npm run compile
```

3. Open this folder in VS Code and press `F5` to launch the extension host.

4. In the launched window, open Activity Bar > `IntelliGit`.

## Settings

| Setting                                 | Default         | Description                                                                                                                    |
| --------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `intelliGit.gitPath`                    | `"git"`         | Git executable path                                                                                                            |
| `intelliGit.commandTimeoutMs`           | `15000`         | Timeout for Git commands (ms)                                                                                                  |
| `intelliGit.maxGraphCommits`            | `200`           | Maximum commits shown in Git Graph                                                                                             |
| `intelliGit.recentBranchesCount`        | `3`             | Number of branches shown in the Recent group (1–10)                                                                            |
| `intelliGit.gutterMarkers.enabled`      | `true`          | Show inline gutter markers for lines added/modified/deleted vs HEAD                                                            |
| `intelliGit.gutterMarkers.maxFileSizeKb` | `512`           | Skip gutter marker computation for files larger than this size in KB                                                           |
| `intelliGit.gutterMarkers.maxLineCount` | `10000`         | Skip gutter marker computation for files with more lines than this value                                                       |
| `intelliGit.performance.logGitCommands` | `false`         | Log Git commands that take 500ms or longer to the IntelliGit output channel                                                    |
| `intelliGit.commitMessageTemplates`     | *(see below)*   | Reusable commit message templates. Each item: `{label, template}`. Placeholders: `{branch}`, `{ticket}`, `{scope}`, `{cursor}` |
| `intelliGit.commitMessageTicketPattern` | `"[A-Z]+-\\d+"` | Regex to extract a ticket ID from the branch name for the `{ticket}` placeholder                                               |
| `intelliGit.aiGenerateTimeoutMs`        | `5000`          | Timeout (ms) for AI commit message generation                                                                                  |

## Performance Notes

IntelliGit activates lazily when one of its views or commands is used. Refreshes are scoped to the visible surface where possible, so saving a file or returning focus to VS Code refreshes working-tree state without reloading branches, tags, stashes, worktrees, submodules, and graph data.

### Windows

On Windows, Git command execution is queued with lower concurrency (2 vs 4 on macOS/Linux) to reduce `CreateProcess` pressure on the Extension Host. Additional mitigations applied in v0.15.4:

- **Watcher debouncing** — worktree and submodule file watchers now use a 250 ms debounce (matching the main `.git` watcher). `ReadDirectoryChangesW` emits multiple events per logical change; without debouncing each event triggered an immediate `git` process spawn.
- **Parallel operation-state detection** — `git` dir stat checks for rebase/merge/cherry-pick state now run in parallel (`Promise.all`), reducing 5 sequential file-system round-trips to 1 on the happy path.
- **Gutter config caching** — gutter-marker size/line-count limits are cached at startup and refreshed only on `onDidChangeConfiguration`, removing per-keystroke `getConfiguration()` calls.
- **Save debounce** — `onDidSaveTextDocument` uses a 150 ms delay to coalesce rapid saves (e.g. format-on-save chains).

If a workspace still feels slow, enable `intelliGit.performance.logGitCommands` and inspect the IntelliGit output channel for slow Git operations. Adding the repository folder and `.git` directory to Windows Defender exclusions usually has the largest practical impact.

**Default commit message templates:**

```json
[
  { "label": "feat",   "template": "feat({scope}): {cursor}" },
  { "label": "fix",    "template": "fix({scope}): {cursor}" },
  { "label": "chore",  "template": "chore: {cursor}" },
  { "label": "ticket", "template": "[{ticket}] {cursor}" }
]
```

## Notes / Current Boundaries

- Single-repo per window (first workspace folder)
- Native Git CLI required on system path (or configure `intelliGit.gitPath`)
- Uses built-in VS Code merge/diff editors for reliability
- Graph is tree-based rendering with glyph hints, not a fully custom canvas DAG
- AI commit message generation requires a compatible language model provider; it times out gracefully if unavailable
- PR/issue tracker integrations are intentionally not included in this core-parity scope
