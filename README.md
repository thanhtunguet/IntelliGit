# vscode-git-client

`vscode-git-client` is a Git workflow extension for VS Code. It keeps daily Git work inside the editor: branch management, commit history, commit details, stashes, worktrees, submodules, gutter markers, merge/rebase/cherry-pick recovery, and branch comparison.

The extension was first inspired by the IntelliJ Git client experience, then adapted for VS Code and extended with workflows that are especially useful in larger repositories: worktree and submodule management, richer branch comparison filters, and cherry-pick matching that can compare commits by author, timestamp, and message instead of relying only on commit ids.

![screen-overview](media/screenshot-overview.png)

![screen-recording](media/screen-recording.gif)

## Why Use It

- Keep advanced Git workflows in one VS Code extension instead of switching between several tools.
- Compare branches with commit and file summaries, filters, export, and matching-message detection.
- Inspect commits through a dedicated Commit Details view and open diffs without temporary text documents.
- Manage stashes, worktrees, and submodules from VS Code views.
- Recover from merge, rebase, cherry-pick, and revert conflicts with visible Continue / Skip / Abort actions.
- Use VS Code's native merge and diff editors for the final file-level experience.

## Quick Start

1. Open a folder that contains a Git repository.
2. Open the extension's Activity Bar container.
3. Use `Branches` for branch/tag operations, `Git Graph` for history, and `Commit Details` for changed files and diffs.
4. Use VS Code Source Control for regular staging/commit work; the extension adds stash, commit-template, generated-message, amend, and shelve actions there.
5. Use `Quick Git Actions` from the Command Palette when you know the action but not the view.

### Where Things Live

| Surface                | What it contains                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| Activity Bar container | `Branches`, `Commit Details`, `Git Graph`, `Worktrees`, `Submodules`                     |
| Source Control panel   | `Stashes` plus SCM input/file actions                                                    |
| Explorer context menu  | Compare files or folders with a branch, tag, or commit                                   |
| Editor                 | Gutter change markers, file diffs, merge editor, branch comparison tabs                  |
| Status bar             | Continue / Skip / Abort controls during merge, rebase, cherry-pick, or revert operations |

## Daily Workflows

### Browse And Switch Branches

Open `Branches` to see local branches, remote branches, tags, and a Recent group. Branches are grouped by prefix such as `feature/*` and `release/*`.

Branch and tag refreshes are cached in extension state and load in parallel when the extension activates, the view opens, or git repository events trigger a ref refresh. The tree renders from that state, so basic tags can appear while slower remote-availability checks continue in the background.

Common actions are available from right-click menus and the Branch Action Hub. Local branches expose local-only actions such as rename, delete, track, and untrack; remote branches expose checkout/compare/merge/rebase actions without local-only destructive entries.

- Checkout, create, rename, or delete branches.
- Track or untrack upstream branches.
- Merge a selected branch into the current branch.
- Rebase the current branch onto another branch.
- Reset the current branch to a selected commit with `soft`, `mixed`, or `hard` confirmation.
- Compare a branch with the current branch.
- Open branch or tag commits in `Git Graph`.
- Add a remote from the Remote section plus button, change/set remote URLs with immediate update feedback, or delete a remote from its context menu after confirmation.

Tags appear with branches and support checkout, checkout-new-branch, copy revision, repository-at-revision, compare-with-current, patch preview, and graph navigation actions. The branch/tag search panel uses tag-specific actions for tag rows.

### Inspect History And Commit Details

Open `Git Graph` for a tree-style commit list with refs, author/date metadata, subject-first titles, short hashes, and expandable changed files. When there are more commits beyond the current page, a "Load More..." item appears at the bottom of the tree; click it to load the next page. The `maxGraphCommits` setting controls how many commits load per page (default 200).

From a commit you can:

- Open `Commit Details` and immediately inspect changed files; click the same commit again to hide the details pane.
- Open file diffs against the commit parent.
- Checkout the commit in detached mode.
- Create a branch or tag at that commit.
- Cherry-pick, revert, create a patch, or compare with the current branch.
- Start an interactive rebase from the selected commit.
- Go to a parent or child commit.
- Multi-select commits with `Shift`, `Ctrl`, or `Cmd`; unsupported context-menu actions are disabled.

`Commit Details` and expanded Git Graph file rows also support selected-file actions: `Open Diffs` (single or multi-select), branch-aware `Revert Selected Changes` / `Cherry-pick Selected Changes`, and `Create Patch from Selected Changes` (save to file or copy to clipboard, then apply to the current working tree).

You can also run `Apply Patch to Working Tree` from the Command Palette to apply patch text from clipboard or a patch file.

### Filter Commit History

Use `Filter Graph` from the Git Graph toolbar to narrow commits by:

- Branch or ref.
- Author.
- Message text.
- Since and until dates.

Filter fields apply as you type or change values inside the Filter Graph webview without changing the main Git Graph TreeView list. The Branch field narrows branch suggestions while typing and applies commit filtering only after selecting a suggestion. When more commits are available beyond the current page, scroll to the bottom of the commit list to automatically load the next page; the header shows "(scroll to load more)" while additional pages remain. Selecting multiple commits in Filter Graph opens a merged Commit Details range that shows the net file changes across the selection.

### Compare Branches

Use `Compare Branches` when you need to understand what differs between two refs before merging, rebasing, or cherry-picking.

The comparison tab shows both directions (`A..B` and `B..A`) with commit and changed-file summaries. It supports:

- File-level diff drill-down.
- Multi-select commits with `Shift`, `Ctrl`, or `Cmd`.
- `Cmd/Ctrl+A` to select all visible commits in the active pane.
- `Esc` to clear selection.
- Merged Commit Details for a continuous selected range.
- Fuzzy message, author, exclude-message regex, and from/to date filters.
- Toggle between **List** (two side-by-side tables) and **Graph** mode (inline SVG showing how the two branches diverged from their merge base); filters dim non-matching commits in graph mode so topology stays visible, while row selection and multi-select shortcuts stay available.
- Optional filters to ignore merge commits.
- Optional matching-message detection to hide likely cherry-picked commits across branches using author, timestamp, and message.
- Export as two CSV files or one Excel workbook with two sheets.
- Recent compare pairs persisted in workspace state.

### Compare A File Or Folder With A Revision

Right-click a file or folder in Explorer and choose `Compare with Revision`.

- Pick from local branches, remote branches, tags, or a typed commit SHA prefix.
- For a file, the diff opens with the selected revision on the left and the working tree on the right.
- For multiple selected files, the same revision is applied to every selected file and each diff opens.
- For a folder, `Commit Details` lists changed files and opens the first file in preview diff mode.

### Stash And Shelve Work

Open `Stashes` in the Source Control panel to manage saved work:

- Create a stash with optional untracked files and keep-index mode.
- Apply, pop, drop, rename, preview patch, or unshelve a stash.
- Right-click an unstaged SCM resource and choose the shelve action to stash only that file.

### Resolve Conflicts

For merge, rebase, cherry-pick, and revert flows, the extension keeps the operation visible:

- Conflict files open in VS Code merge editors when possible.
- If files cannot be opened directly, the Source Control view is revealed as a fallback.
- Status-bar actions expose `Continue`, `Skip`, and `Abort` when those actions apply.
- Rebase progress is shown when Git exposes the current step.
- Finalize commands guard against unresolved conflicts.

### Manage Worktrees

Open `Worktrees` to manage parallel checkouts from the Activity Bar container.

Worktrees are grouped as `Current`, `Other Worktrees`, `Locked`, and `Prunable / Stale`.
When the repository only has the main/current worktree and no submodules, the Worktrees and Submodules views auto-collapse after both lists load.

Available actions include:

- Open a worktree in this window or a new window.
- Reveal in Finder / Explorer.
- Open a terminal in the worktree directory.
- Add a worktree from an existing branch.
- Add a worktree with a new branch.
- Add a detached worktree.
- Lock, unlock, remove, or force remove worktrees.
- Preview and prune stale worktrees.

### Manage Submodules

Open `Submodules` to inspect nested repositories.

Submodules are grouped as `Needs Attention`, `Clean`, `Uninitialized`, and `Nested`.
When a repository has no submodules and only the main/current worktree, this view auto-collapses with Worktrees after loading.

Available actions include:

- Init one submodule or all submodules.
- Update one submodule, update all, or update recursively.
- Sync one URL or all URLs.
- Open a submodule in this window or a new window.
- Checkout the recorded commit when the pointer is out of sync.
- Pull the tracked branch.
- Show pointer diff.
- Stage pointer change.
- Deinit a submodule.

### Commit From Source Control

The extension adds daily commit helpers to VS Code's native Source Control panel:

- Pick a reusable commit message template.
- Generate a commit message from staged diff with a configurable timeout.
- Amend the last commit from the SCM input box.
- Commit with `Ctrl+Enter` / `Cmd+Enter`.
- Stage or unstage files, run partial staging, and fetch/push/pull with previews.

## Feature Reference

### Gutter Change Markers

Inline gutter decorations show added, modified, and deleted lines relative to `HEAD`. They update as you type with debounce and can be disabled with `vscodeGitClient.gutterMarkers.enabled`.

To keep editing responsive on Windows and large repositories, generated folders and files above the configured size or line-count limits are skipped.

### Diff And Merge Entry Points

Supported editor workflows include:

- Working tree vs `HEAD`.
- Index vs `HEAD`.
- Commit vs parent.
- Any two refs for a file.
- Built-in VS Code 3-way merge editor for conflicts.
- Next and previous conflict navigation.

### Cross-Cutting Actions

- Quick Git Actions command palette entry.
- Push and pull previews with incoming/outgoing summaries.
- Fetch `--prune`.
- Partial staging with `git add -p`.
- File history and blame from the active editor file or Explorer context menu.
- Guardrails for destructive operations.
- Output-channel logging for slow Git commands.
- Deterministic refresh after mutating operations.

## Settings

| Setting                                             | Default         | Description                                                                                                                                                                      |
| --------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vscodeGitClient.gitPath`                           | `"git"`         | Git executable path                                                                                                                                                              |
| `vscodeGitClient.commandTimeoutMs`                  | `15000`         | Timeout for Git commands in milliseconds                                                                                                                                         |
| `vscodeGitClient.maxGraphCommits`                   | `200`           | Controls how many commits load per page in Git Graph views. Commits accumulate as you click "Load More..." in the tree view or scroll to the bottom of the Filter Graph webview. |
| `vscodeGitClient.recentBranchesCount`               | `3`             | Number of branches shown in the Recent group                                                                                                                                     |
| `vscodeGitClient.gutterMarkers.enabled`             | `true`          | Show inline gutter markers for lines added, modified, or deleted vs `HEAD`                                                                                                       |
| `vscodeGitClient.gutterMarkers.maxFileSizeKb`       | `512`           | Skip gutter marker computation for files larger than this size in KB                                                                                                             |
| `vscodeGitClient.gutterMarkers.maxLineCount`        | `10000`         | Skip gutter marker computation for files with more lines than this value                                                                                                         |
| `vscodeGitClient.performance.logGitCommands`        | `false`         | Log Git commands that take 500ms or longer to the extension output channel                                                                                                       |
| `vscodeGitClient.performance.refreshDebounceMs`     | `250`           | Debounce delay for VS Code Git repository-state auto-refresh events                                                                                                              |
| `vscodeGitClient.performance.saveRefreshDebounceMs` | `150`           | Debounce delay for save-triggered working-tree refresh events                                                                                                                    |
| `vscodeGitClient.compare.exportFormat`              | `"csv"`         | Compare Branches export format: `csv` for two files, or `excel` for one `.xlsx` with two sheets                                                                                  |
| `vscodeGitClient.commitMessageTemplates`            | see below       | Reusable commit message templates with `{branch}`, `{ticket}`, `{scope}`, and `{cursor}` placeholders                                                                            |
| `vscodeGitClient.commitMessageTicketPattern`        | `"[A-Z]+-\\d+"` | Regex used to extract a ticket id from the current branch name                                                                                                                   |
| `vscodeGitClient.aiGenerateTimeoutMs`               | `5000`          | Timeout for AI commit message generation in milliseconds                                                                                                                         |

Existing `intelliGit.*` settings are still read as a legacy fallback when the matching `vscodeGitClient.*` setting has not been configured.

Default commit message templates:

```json
[
  { "label": "feat", "template": "feat({scope}): {cursor}" },
  { "label": "fix", "template": "fix({scope}): {cursor}" },
  { "label": "chore", "template": "chore: {cursor}" },
  { "label": "ticket", "template": "[{ticket}] {cursor}" }
]
```

## Performance Notes

The extension activates lazily when one of its views or commands is used. Refreshes are scoped to the visible surface where possible. Branch and tag data are cached in `StateStore`; the Branches view renders cached state while local branches, remote branches, basic tags, and tag remote-availability refresh in parallel. VS Code Git repository-state events and save events refresh working-tree state without reloading every branch, tag, stash, worktree, submodule, and graph slice.

On Windows, Git command execution uses lower concurrency than macOS/Linux to reduce `CreateProcess` pressure on the Extension Host. Additional mitigations include configurable refresh debounce settings, parallel operation-state detection, cached gutter configuration, and save debounce.

If a workspace still feels slow, enable `vscodeGitClient.performance.logGitCommands` and inspect the extension output channel for slow Git operations. Adding the repository folder and `.git` directory to Windows Defender exclusions usually has the largest practical impact.

## Development

Install dependencies:

```bash
npm install
```

Compile:

```bash
npm run compile
```

Open this folder in VS Code and press `F5` to launch the extension host.

### Architecture Map

| Module                                                     | Purpose                                                                                                        |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `src/services/gitService.ts`                               | Git command wrapper with typed methods, VS Code Git API integrations, error normalization, and command logging |
| `src/services/gitParsing.ts`                               | Output parsers for branches, stashes, log, status, and blame                                                   |
| `src/services/repositoryContext.ts`                        | Resolves the active Git repository root                                                                        |
| `src/services/submoduleService.ts` / `submoduleParsing.ts` | Submodule discovery and command wrappers                                                                       |
| `src/services/worktreeParsing.ts`                          | Worktree list parser                                                                                           |
| `src/state/stateStore.ts`                                  | Cached state for branches, stashes, graph, compare, worktree, submodule, and working-tree changes              |
| `src/state/changelistStore.ts`                             | Tracks selected changes in the Commit Details view                                                             |
| `src/state/commitTemplates.ts`                             | Loads and resolves commit message templates                                                                    |
| `src/providers/branchTreeProvider.ts`                      | Branch and tag tree provider                                                                                   |
| `src/providers/stashTreeProvider.ts`                       | Stash tree provider                                                                                            |
| `src/providers/graphTreeProvider.ts`                       | Git Graph tree provider                                                                                        |
| `src/providers/commitFilesTreeProvider.ts`                 | Commit Details tree provider                                                                                   |
| `src/providers/worktreeTreeProvider.ts`                    | Worktree tree provider                                                                                         |
| `src/providers/submoduleTreeProvider.ts`                   | Submodule tree provider                                                                                        |
| `src/commands/commandController.ts`                        | Command registration, action orchestration, and guardrails                                                     |
| `src/editor/editorOrchestrator.ts`                         | Merge, diff, revision, and compare-tab orchestration                                                           |
| `src/editor/gutterDecorationController.ts`                 | Inline gutter change markers vs `HEAD`                                                                         |
| `src/editor/virtualGitContentProvider.ts`                  | Virtual document provider for revision content                                                                 |
| `src/views/compareView.ts`                                 | Branch comparison webview                                                                                      |
| `src/views/graphFilterView.ts`                             | Filter Graph webview                                                                                           |
| `src/views/branchSearchView.ts`                            | Branch search webview                                                                                          |
| `src/views/commitActions.ts`                               | Shared context-menu action model for commit webviews                                                           |
| `src/views/templateRenderer.ts`                            | Handlebars template renderer for webviews                                                                      |

### Command ID Reference

Key command IDs, not exhaustive:

- `vscodeGitClient.quickActions` - Quick Git Actions palette
- `vscodeGitClient.refresh` - Refresh all views
- `vscodeGitClient.branch.*` - Checkout, create, rename, delete, track, merge, rebase, reset, compare, search, actionHub, openCommits
- `vscodeGitClient.tag.*` - Checkout, checkoutNewBranch, copyRevisionNumber, showRepositoryAtRevision, compareWithCurrent, createPatch, openCommits
- `vscodeGitClient.stash.*` - Create, apply, pop, drop, rename, previewPatch, unshelve
- `vscodeGitClient.graph.*` - openDetails, openFileDiff, checkoutCommit, createBranchHere, createTagHere, cherryPick, cherryPickRange, revert, rebaseInteractiveFromHere, compareWithCurrent, createPatch, showRepositoryAtRevision, openRepositoryFileAtRevision, goToParentCommit, filter, clearFilter
- `vscodeGitClient.commit.*` - revertSelectedChanges, cherryPickSelectedChanges, createPatchSelectedChanges, applyPatch, amend
- `vscodeGitClient.compare.open` - Open branch comparison
- `vscodeGitClient.compareWithRevision` - Compare Explorer files or folders with a revision
- `vscodeGitClient.merge.*` - openConflict, next, previous, finalize
- `vscodeGitClient.operation.*` - abort, continue, skip
- `vscodeGitClient.git.*` - pushWithPreview, pullWithPreview, fetchPrune
- `vscodeGitClient.stage.*` / `vscodeGitClient.unstage.file` - stage and unstage actions
- `vscodeGitClient.scm.*` - shelveResource, commitTemplate, generateCommitMessage, amendFromInput
- `vscodeGitClient.worktree.*` - worktree actions
- `vscodeGitClient.submodule.*` - submodule actions
- `vscodeGitClient.fileBlame.open` - File blame

Legacy `intelliGit.*` command aliases are registered after activation so existing keybindings and integrations keep working during migration.

## Current Boundaries

- Single repository per window, using the first workspace folder.
- Native Git CLI required on the system path, or configure `vscodeGitClient.gitPath`.
- Built-in VS Code merge and diff editors are used for reliability.
- Git Graph is tree-based rendering with glyph hints, not a custom canvas DAG.
- IntelliJ-style binary-patch behavior for selected-change patch workflows is not fully replicated yet; the current create/apply patch flow is optimized for text-based patches.
- AI commit message generation requires a compatible language model provider and times out gracefully if unavailable.
- PR and issue tracker integrations are intentionally outside the current scope.

## Feedback And Contributions

Issues and pull requests are welcome: https://github.com/vscode-git-client/vscode-git-client/issues
